/**
 * 云函数 recognize —— PDF/图片试卷 AI 拆题 + 确认入库（PostgreSQL 版）
 *
 * 识别链路（生产）：
 *   图片：前端读成 base64 data URL 传入 → 视觉模型 image_url 块识别。
 *   PDF ：前端上传微信云存储换公网临时 URL（fileUrl）传入 → GLM 文件块识别
 *         （GLM 文件输入只接受公网 URL，base64 data URL 会失败，故不再用 fileBase64）。
 *   视觉大模型（glm-5.3-flash）一次性做 OCR + 拆题 + 打标签 →
 *   解析 JSON → 归一化 → 写入 zx_papers(pending) + zx_questions(need_confirm)。
 *
 * 降级链路（始终保留）：
 *   未开模型开关 / 无图片数据 / AI 失败 / 解析失败 → 返回预置 SAMPLE 样题，
 *   保证答题闭环不中断。RECOGNIZE_MODE=demo 可强制走样题。
 *
 * 三种动作：
 *   1) 识别（默认）：写入待校对题目，返回题目供前端校对。
 *   2) importExcel：{ action:'importExcel', fileID, fileName, subject }，下载云存储 Excel，
 *      用 xlsx 解析 + 全题型校验，写入 need_confirm 题目，返回同构 questions 供 check 校对。
 *   3) 确认入库：{ action:'confirm', paperId }，置为 confirmed。
 *
 * 说明：AI 用 @cloudbase/node-sdk 的 app.ai()，云函数内走环境凭证，
 *       无需单独 API Key；模型开关在云开发控制台「AI→生文模型」开启。
 *       模型名可用环境变量 AI_MODEL 覆盖（默认 glm-5.3-flash）。
 *
 * 入参：{ fileName, subject, imageBase64?, fileUrl?, mimeType? }
 *      { action:'importExcel', fileID, fileName?, subject? }
 *      { action:'confirm'|'updateQuestion', ... }
 * 出参：{ code:0, paperId, subject, questions:[...], engine:'ai'|'demo'|'excel', note }
 */
const cloudbase = require('@cloudbase/js-sdk')
const tcb = require('@cloudbase/node-sdk')
const crypto = require('crypto')
const XLSX = require('xlsx')
const qt = require('./questionTypes.js')
const excelParser = require('./excelParser.js')
const qmeta = require('./questionMeta.js')
const kbook = require('./knowledgeBook.js')
const contentCheck = require('./contentCheck.js')

/** 取微信云调用注入的真实身份 openid（唯一可信来源）；取不到返回 '' */
function getCallerOpenId() {
  try {
    const wx = require('wx-server-sdk')
    wx.init({ env: wx.DYNAMIC_CURRENT_ENV })
    const ctx = wx.getWXContext() || {}
    if (ctx.OPENID) return ctx.OPENID
  } catch (e) { /* 非微信云调用环境 */ }
  return process.env.WX_OPENID || ''
}

/** 管理员 openid 环境变量白名单 */
function adminEnvList() {
  return String(process.env.ADMIN_OPENIDS || '')
    .split(/[,，\s]+/).map(function (s) { return s.trim() }).filter(Boolean)
}
function inAdminList(openid, envList, dbRows) {
  if (envList.indexOf(openid) >= 0) return true
  return (dbRows || []).some(function (r) { return r.openid === openid })
}

/** HTTP 网关适配 */
function parseEvent(event) {
  if (!event || !event.body) return event || {}
  let raw = event.body
  if (event.isBase64Encoded) {
    try { raw = Buffer.from(raw, 'base64').toString('utf8') } catch (e) { /* 保持原样 */ }
  }
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch (e) { return {} }
  }
  return raw || {}
}
function respond(event, result) {
  if (event && event.httpMethod) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      isBase64Encoded: false,
      body: JSON.stringify(result)
    }
  }
  return result
}

function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/**
 * 分批并发写库（v1.9.7）：逐条串行 await insert 时，几十~上百题的网络往返会累积到
 * 数秒，触发云函数 3 秒超时（FUNCTIONS_TIME_LIMIT_EXCEEDED）。改为每批 N 条并发，
 * 批与批之间串行，兼顾速度与云端连接压力。返回 { ok, failed, errors }。
 */
async function insertRowsBatched(db, table, rows, batchSize) {
  const size = Math.max(1, batchSize || 10)
  let ok = 0
  const errors = []
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size)
    const results = await Promise.all(chunk.map(function (row) {
      return db.from(table).insert(row).then(function () { return true }, function (e) { return e })
    }))
    results.forEach(function (r, j) {
      if (r === true) ok++
      else errors.push({ index: i + j, message: (r && r.message) || String(r) })
    })
  }
  return { ok: ok, failed: errors.length, errors: errors.slice(0, 10) }
}

/** 把 PG 里的 JSON 字符串/数组安全转成数组（loadPaper 用） */
function parseArr(v) {
  if (Array.isArray(v)) return v
  if (v == null || v === '') return []
  if (typeof v === 'string') { try { return JSON.parse(v) } catch (e) { return [] } }
  return []
}

/** 按公网临时 URL 下载文件为 Buffer（PG 环境主链路：wx-server-sdk.downloadFile 在 PG 不支持） */
function downloadUrlBuffer(url) {
  return new Promise(function (resolve, reject) {
    let u
    try { u = new URL(url) } catch (e) { reject(new Error('文件 URL 无效')); return }
    const mod = (u.protocol === 'http:') ? require('http') : require('https')
    const req = mod.get(url, function (res) {
      // 跟随重定向（COS 临时链接偶尔 302）
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        downloadUrlBuffer(res.headers.location).then(resolve, reject)
        return
      }
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error('下载文件 HTTP ' + res.statusCode)); return
      }
      const chunks = []
      res.on('data', function (c) { chunks.push(c) })
      res.on('end', function () { resolve(Buffer.concat(chunks)) })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(60000, function () { req.destroy(new Error('下载文件超时')) })
  })
}

/** 从微信云存储下载文件为 Buffer（传统环境兜底；PG 环境不支持，优先用 downloadUrlBuffer） */
function downloadCloudFile(fileID) {
  return new Promise(function (resolve, reject) {
    if (!wxSdk || typeof wxSdk.downloadFile !== 'function') {
      reject(new Error('云存储下载能力不可用')); return
    }
    wxSdk.downloadFile({ fileID: fileID })
      .then(function (res) { resolve(res && res.fileContent ? res.fileContent : res) })
      .catch(reject)
  })
}

/** 用 js-sdk 把云存储 fileID 换成公网临时 URL（兼容旧前端只传 fileID 的情况；PG 环境可用） */
function fileIDToUrl(fileID) {
  return new Promise(function (resolve) {
    if (!fileID) { resolve(''); return }
    try {
      const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
      const r = app.getTempFileURL
        ? app.getTempFileURL({ fileList: [fileID] })
        : Promise.resolve({ fileList: [] })
      Promise.resolve(r).then(function (res) {
        const item = res && res.fileList && res.fileList[0]
        resolve((item && (item.tempFileURL || item.download_url)) || '')
      }).catch(function () { resolve('') })
    } catch (e) { resolve('') }
  })
}

/** 获取 Excel Buffer：
 *  1) excelBase64：前端直接读文件传入（PG 环境首选，完全绕开云存储下载）
 *  2) fileUrl：公网临时 URL，云函数按 URL 下载（PG/传统通用）
 *  3) fileID → js-sdk 换公网 URL → 下载（兼容旧前端，PG 可用）
 *  4) fileID → wx-server-sdk.downloadFile（仅传统环境兜底，PG 不支持）
 */
async function fetchExcelBuffer(fileID, fileUrl, excelBase64) {
  if (excelBase64) {
    try { return Buffer.from(String(excelBase64).replace(/^data:[^;]+;base64,/, ''), 'base64') }
    catch (e) { /* 落到下一条链路 */ }
  }
  if (fileUrl && /^https?:\/\//i.test(fileUrl)) {
    try { return await downloadUrlBuffer(fileUrl) } catch (e) { /* 继续兜底 */ }
  }
  if (fileID) {
    const url = await fileIDToUrl(fileID)
    if (url && /^https?:\/\//i.test(url)) {
      try { return await downloadUrlBuffer(url) } catch (e) { /* 继续兜底 */ }
    }
    // 最后兜底：传统环境的 downloadFile（PG 会抛 SDK_UPGRADE_REQUIRED）
    return downloadCloudFile(fileID)
  }
  throw new Error('没有可用的 Excel 数据来源')
}
let wxSdk = null
try {
  wxSdk = require('wx-server-sdk')
  wxSdk.init({ env: wxSdk.DYNAMIC_CURRENT_ENV })
} catch (e) { /* 非微信环境 */ }

const SAMPLE = [
  { q_type: 'single', stem: '若 a−b=3，ab=2，则 a²+b² 的值为（　）', options: ['5', '9', '13', '11'], answer: 2, analysis: 'a²+b²=(a−b)²+2ab=9+4=13。', knowledge_tags: ['k2'], confidence: 0.96 },
  { q_type: 'single', stem: '已知 AB=AC，∠A=60°，则△ABC 是（　）', options: ['直角三角形', '等边三角形', '等腰直角三角形', '钝角三角形'], answer: 1, analysis: '有一个角60°的等腰三角形是等边三角形。', knowledge_tags: ['k1', 'k7'], confidence: 0.91 },
  { q_type: 'blank', stem: '一元二次方程 x²−5x+6=0 的两根之和为______，两根之积为______。', options: [], answer: ['5', '6'], analysis: '由韦达定理，和为5，积为6。', knowledge_tags: ['k2'], confidence: 0.9 },
  { q_type: 'solve', stem: '已知二次函数 y=x²−2x−3。（1）求图象与 x 轴的交点；（2）写出顶点坐标。', options: [], answer: '令y=0解得x=−1或x=3，交点为(−1,0)、(3,0)；配方y=(x−1)²−4，顶点(1,−4)。', scoring_points: [{ point: '求出与x轴两个交点', score: 5 }, { point: '写出顶点坐标(1,−4)', score: 5 }], score: 10, analysis: '考查二次函数图象与坐标轴交点及顶点。', knowledge_tags: ['k4'], confidence: 0.87 }
]

const SYSTEM_PROMPT = '你是中考试卷拆题助手。从试卷中抽取题目，识别题型，输出严格 JSON 数组，不要任何解释文字或代码块标记。题型 q_type 取值：single(单选)、multiple(多选)、judge(判断)、blank(填空)、solve(解答)、calculation(计算)、reading(阅读理解)、experiment(实验)、translation(翻译)、essay(作文)。每个元素字段：q_type, stem(题干字符串), options(选择题给2-6个选项字符串数组，非选择题给空数组[]), answer(单选=正确选项下标数字；多选=下标数组；判断=0错/1对；填空=字符串数组每空一项；解答/计算/阅读/实验/翻译/作文=参考答案文本), analysis(简短解析), knowledge_tags(1-3个知识点标签字符串数组), scoring_points(主观题评分要点数组[{point,score}]，客观题给[]), score(题目分值数字，主观题按要点合计，客观题默认2)。只输出题目本身能识别的题，最多10道；无法确定的题请跳过。输出格式：[{"q_type":"single","stem":"...","options":["A","B","C","D"],"answer":0,"analysis":"...","knowledge_tags":["..."],"scoring_points":[],"score":2}]'

/** 调视觉大模型拆题；失败抛出异常由上层降级 */
async function aiExtract(imageBase64, fileUrl, mimeType, subject) {
  const modelName = process.env.AI_MODEL || 'glm-5.3-flash'
  const app = tcb.init({ env: tcb.SYMBOL_CURRENT_ENV, timeout: 120000 })
  const ai = app.ai()
  const model = ai.createModel('cloudbase')

  let mediaBlock
  if (fileUrl && /^https?:\/\//i.test(fileUrl)) {
    // PDF：GLM 文件块只接受公网 URL（前端已用 wx.cloud.getTempFileURL 换好）
    mediaBlock = { type: 'file', file: { file_url: fileUrl } }
  } else {
    const b64 = (imageBase64 || '').replace(/^data:[^;]+;base64,/, '')
    if (!b64) throw new Error('没有可识别的图片数据（PDF 需要公网 URL）')
    const mime = /png/i.test(mimeType || '') ? 'image/png' : 'image/jpeg'
    mediaBlock = { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + b64 } }
  }

  const res = await model.generateText({
    model: modelName,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: [
        { type: 'text', text: '学科：' + (subject || '数学') + '。请拆出这张试卷里的题目，识别每道题的题型（单选/多选/判断/填空/解答/计算/阅读/实验/翻译/作文）。' },
        mediaBlock
      ] }
    ]
  })
  return parseAiText(res && res.text)
}

/** 解析 AI 文本 → 归一化题目数组 */
function parseAiText(text) {
  if (!text) throw new Error('AI 返回为空')
  // 去掉可能的 markdown 代码块
  let s = String(text).replace(/```(?:json)?/gi, '').trim()
  const a = s.indexOf('['), b = s.lastIndexOf(']')
  if (a < 0 || b <= a) throw new Error('AI 未返回 JSON 数组')
  s = s.slice(a, b + 1)
  const arr = JSON.parse(s)
  if (!Array.isArray(arr) || !arr.length) throw new Error('AI 拆题结果为空')
  return arr.slice(0, 10).map(q => {
    const type = qt.normalizeType(q.q_type)
    const m = qt.meta(type)
    const opts = Array.isArray(q.options) ? q.options.slice(0, 6).map(String) : []
    let ans
    if (m.answerKind === 'index') {
      ans = Number(q.answer)
      if (!Number.isInteger(ans) || ans < 0 || ans >= Math.max(opts.length, 1)) ans = 0
    } else if (m.answerKind === 'indexArray') {
      ans = (Array.isArray(q.answer) ? q.answer : []).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < opts.length)
    } else if (m.answerKind === 'textArray') {
      ans = (Array.isArray(q.answer) ? q.answer : [q.answer]).map(x => String(x == null ? '' : x))
    } else {
      ans = String(q.answer == null ? '' : q.answer)
    }
    const spRaw = Array.isArray(q.scoring_points) ? q.scoring_points : []
    const scoring_points = spRaw.slice(0, 8).map(p => ({
      point: String((p && (p.point || p.text)) || '').slice(0, 80),
      score: Number((p && p.score) || 0)
    })).filter(p => p.point)
    return {
      q_type: type,
      stem: String(q.stem || '').slice(0, 500),
      options: m.hasOptions ? opts : [],
      answer: ans,
      scoring_points,
      score: Number(q.score) || (m.family === 'subjective' ? 10 : 2),
      analysis: String(q.analysis || '').slice(0, 800),
      knowledge_tags: Array.isArray(q.knowledge_tags) ? q.knowledge_tags.slice(0, 3).map(String) : [],
      confidence: 0.9
    }
  }).filter(q => q.stem)
}

exports.main = async (event) => {
  const p = parseEvent(event)
  const { action, fileID, fileUrl, excelBase64, fileName, subject, paperId, questionId, patch, imageBase64, mimeType, enabled, original, scope, filters, doInit, asSystem } = p
  // 【安全】身份只认微信云调用注入的 openid，忽略前端传入的 studentId
  const studentId = getCallerOpenId()
  if (!studentId) return respond(event, { code: -401, message: '无法验证微信身份，请通过 wx.cloud.callFunction 调用', needWxCall: true })

  // 【v1.9.13】管理端导入：asSystem=true 时校验管理员身份；通过后题以 scope='system' 写草稿，
  // 校对确认（confirm）时再发布到公共题库并分发给所有用户。非管理员一律拒绝。
  let wantSystem = asSystem === true || asSystem === 'true' || asSystem === 1
  if (wantSystem) {
    const envAdmins = adminEnvList()
    let adminRows = []
    try {
      const tmpApp = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
      const ar = await tmpApp.rdb().from('zx_admins').select('openid').limit(500)
      adminRows = ar.data || []
    } catch (e) { /* 表未建时按环境变量判定 */ }
    if (!inAdminList(studentId, envAdmins, adminRows)) {
      return respond(event, { code: -403, message: '非管理员，无权导入系统题库。请先在「我的-管理端」用管理员账号登录。' })
    }
  }
  const writeScope = wantSystem ? 'system' : 'user'

  // ============ 动作：Excel 批量导入题（写入待确认，走 check 校对后入库） ============
  if (action === 'importExcel') {
    try {
      if (!fileID && !fileUrl && !excelBase64) return respond(event, { code: -1, message: '缺少 Excel 文件（excelBase64/fileID/fileUrl）' })
      const buf = await fetchExcelBuffer(fileID, fileUrl, excelBase64)
      const wb = XLSX.read(buf, { type: 'buffer' })
      // 取第一张工作表；若名为"样例/说明"之类则找有题干列的那张
      let sheetName = wb.SheetNames[0]
      let rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' })
      const hasStem = function (rs) {
        if (!rs || !rs.length) return false
        const h = rs[0].map(function (x) { return String(x || '').toLowerCase().replace(/\s/g, '') })
        return h.some(function (x) { return x === 'stem' || x === '题干' || x === '题目' || x === '问题' })
      }
      if (!hasStem(rows)) {
        for (let i = 1; i < wb.SheetNames.length; i++) {
          const rs = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[i]], { header: 1, defval: '' })
          if (hasStem(rs)) { sheetName = wb.SheetNames[i]; rows = rs; break }
        }
      }
      const parsed = excelParser.parseRows(rows)
      if (!parsed.questions.length) {
        return respond(event, {
          code: -2, message: '未解析到有效题目', total: parsed.total,
          invalid: parsed.invalid.slice(0, 30)
        })
      }
      // 写 zx_papers(source='excel') + zx_questions(need_confirm=true)，复用确认链路
      const appDb = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
      const db = appDb.rdb()
      const pid = genId('p')
      const questions = parsed.questions.map(function (q) {
        const meta = qmeta.inferMeta(q.original || '', { year: q.year, grade: q.grade, region: q.region })
        return Object.assign({}, q, {
          id: q.id || genId('q'), tags: q.knowledge_tags,
          knowledge_points: kbook.buildKnowledgePoints(q.knowledge_tags, q.knowledge_points, q.subject || subject, meta.grade),
          year: meta.year, grade: meta.grade, region: meta.region
        })
      })
      // 【内容安全】并发剔除题干含违规信息的题（fail-open；仅本地高危词硬拦截）
      const checks = await Promise.all(questions.map(function (q) {
        return contentCheck.checkText((q.stem || '') + ' ' + (q.analysis || ''), studentId)
      }))
      let blocked = 0
      const safeQuestions = []
      questions.forEach(function (q, i) {
        if (checks[i] && checks[i].pass) safeQuestions.push(q); else blocked++
      })
      questions.length = 0
      Array.prototype.push.apply(questions, safeQuestions)
      if (!questions.length) {
        return respond(event, { code: -5, message: '所有题目均未通过内容安全检查，未入库' })
      }
      // 试卷级来源：优先取首行的 original，否则用文件名
      const paperOriginal = (questions.find(function (q) { return q.original }) || {}).original || fileName || ''
      await db.from('zx_papers').insert({
        id: pid, student_id: studentId, scope: writeScope,
        title: fileName || ('Excel导入·' + (subject || '数学')),
        subject: subject || questions[0].subject || '数学',
        grade: '九年级', source: 'excel', original: paperOriginal.slice(0, 200), file_id: fileID || null,
        question_count: questions.length, ocr_status: 'done', confirm_status: 'draft',
        created_at: new Date().toISOString()
      })
      // 【v1.9.7】批量并发写题，避免逐条串行 await 触发 3 秒超时
      const qRows = questions.map(function (q) {
        const type = qt.normalizeType(q.q_type)
        const m = qt.meta(type)
        return {
          id: q.id, paper_id: pid, student_id: studentId,
          scope: writeScope, // v1.9.13：管理端导入为 system 草稿，确认后发布；用户导入为 user
          subject: q.subject || subject || '数学', q_type: type, stem: q.stem,
          options: JSON.stringify(q.options || []), answer: JSON.stringify(q.answer),
          scoring_points: JSON.stringify(q.scoring_points || []),
          score: q.score || (m.family === 'subjective' ? 10 : 2),
          analysis: q.analysis || '', knowledge_tags: JSON.stringify(q.knowledge_tags || []),
          knowledge_points: JSON.stringify(kbook.buildKnowledgePoints(q.knowledge_tags, q.knowledge_points, q.subject || subject, q.grade)),
          original: (q.original || paperOriginal || '').slice(0, 200),
          year: q.year || 0, grade: q.grade || '', region: q.region || '',
          need_fix: !!q.needFix, issues: JSON.stringify(q.issues || []),
          confidence: q.confidence || 1, need_confirm: true, confirmed: false,
          created_at: new Date().toISOString()
        }
      })
      const wr = await insertRowsBatched(db, 'zx_questions', qRows, 12)
      return respond(event, {
        code: 0, paperId: pid, subject: subject || questions[0].subject || '数学',
        questions: questions, engine: 'excel',
        total: parsed.total, imported: wr.ok, writeFailed: wr.failed,
        needFixCount: parsed.needFixCount,
        invalid: parsed.invalid.slice(0, 30),
        note: 'Excel 解析完成，共 ' + parsed.total + ' 行，导入 ' + wr.ok +
          ' 题' + (wr.failed ? '（' + wr.failed + ' 题写入失败）' : '') +
          (parsed.invalid.length ? '，' + parsed.invalid.length + ' 行无效已跳过' : '') +
          (parsed.needFixCount ? '；其中 ' + parsed.needFixCount + ' 题信息不全（缺选项/答案），已在校对页标红待补全' : '') +
          '。请逐题校对后确认入库。'
      })
    } catch (e) {
      return respond(event, { code: -1, message: 'Excel 解析失败：' + (e && e.message || e) })
    }
  }

  // ============ 动作：加载已有试卷的全部题目（供点击试卷进入编辑） ============
  if (action === 'loadPaper') {
    const appDb = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
    const db = appDb.rdb()
    try {
      if (!paperId) return respond(event, { code: -1, message: '缺少 paperId' })
      // 校验试卷归属（只认本人）
      const pr = await db.from('zx_papers').select('*').eq('id', paperId).eq('student_id', studentId).limit(1)
      if (!(pr.data && pr.data.length)) {
        return respond(event, { code: -403, message: '试卷不存在或无权访问' })
      }
      const paperRow = pr.data[0]
      const qr = await db.from('zx_questions').select('*')
        .eq('student_id', studentId).eq('paper_id', paperId).limit(500)
      const rows = qr.data || []
      // 归一化为校对页可直接渲染/编辑的结构
      const questions = rows.map(function (row) {
        const type = qt.normalizeType(row.q_type)
        const m = qt.meta(type)
        return {
          id: row.id,
          q_type: type,
          stem: row.stem || '',
          options: parseArr(row.options),
          answer: qt.asValue(row.answer),
          scoring_points: qt.asValue(row.scoring_points) || [],
          score: Number(row.score) || (m.family === 'subjective' ? 10 : 2),
          analysis: row.analysis || '',
          original: row.original || '',
          year: Number(row.year) || 0, grade: row.grade || '', region: row.region || '',
          knowledge_tags: parseArr(row.knowledge_tags),
          tags: parseArr(row.knowledge_tags),
          knowledge_points: parseArr(row.knowledge_points).length
            ? parseArr(row.knowledge_points)
            : kbook.buildKnowledgePoints(parseArr(row.knowledge_tags), null, paperRow.subject, row.grade),
          needFix: !!row.need_fix,
          issues: parseArr(row.issues),
          confidence: Number(row.confidence) || 1,
          confirmed: !!row.confirmed
        }
      })
      return respond(event, {
        code: 0, paperId,
        paper: {
          id: paperRow.id, title: paperRow.title || '云试卷',
          subject: paperRow.subject || '数学', grade: paperRow.grade || '九年级',
          count: questions.length,
          status: paperRow.confirm_status === 'confirmed' ? 'confirmed' : 'pending',
          original: paperRow.original || ''
        },
        subject: paperRow.subject || '数学',
        questions
      })
    } catch (e) {
      return respond(event, { code: -1, message: '加载试卷失败：' + (e && e.message || e) })
    }
  }

  // ============ 动作二：确认入库 ============
  if (action === 'confirm') {
    const appDb = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
    const db = appDb.rdb()
    try {
      if (!paperId) return respond(event, { code: -1, message: '缺少 paperId' })
      // 取试卷，判断是否系统题草稿（v1.9.13）
      const paperRes = await db.from('zx_papers').select('*').eq('id', paperId).eq('student_id', studentId).limit(1)
      const paper = (paperRes.data || [])[0] || null
      const isSystem = !!(paper && paper.scope === 'system')
      if (isSystem) {
        // 双重保险：发布系统题必须管理员
        const envAdmins = adminEnvList()
        let adminRows = []
        try {
          const ar = await db.from('zx_admins').select('openid').limit(500)
          adminRows = ar.data || []
        } catch (e) {}
        if (!inAdminList(studentId, envAdmins, adminRows)) {
          return respond(event, { code: -403, message: '非管理员，无法发布系统题库' })
        }
      }
      const pending = await db.from('zx_questions')
        .select('*').eq('student_id', studentId).eq('paper_id', paperId).limit(500)
      const rows = pending.data || []
      // 逐条确认（草稿题都在当前 openid 名下）
      for (const q of rows) {
        await db.from('zx_questions').update({ confirmed: true, need_confirm: false }).eq('id', q.id)
      }
      await db.from('zx_papers').update({ confirm_status: 'confirmed', question_count: rows.length })
        .eq('id', paperId).eq('student_id', studentId)

      // 系统题：发布到公共题库 demo_student + 分发给所有已有用户
      let published = 0, syncedUsers = 0, syncedRows = 0
      if (isSystem && rows.length) {
        const publicStemSet = new Set()
        try {
          const pub = await db.from('zx_questions').select('stem').eq('student_id', 'demo_student').limit(2000)
          ;(pub.data || []).forEach(function (r) { publicStemSet.add(r.stem) })
        } catch (e) {}
        const toPublish = rows.filter(function (q) { return !publicStemSet.has(q.stem) })
        // 写入 demo_student 公共主库（供新用户登录克隆）
        for (const q of toPublish) {
          const pubRow = Object.assign({}, q)
          delete pubRow.id
          pubRow.paper_id = '' // 公共库题不挂管理员的草稿试卷
          pubRow.student_id = 'demo_student'
          pubRow.scope = 'system'
          pubRow.confirmed = true
          pubRow.need_confirm = false
          pubRow.created_at = new Date().toISOString()
          try { await db.from('zx_questions').insert(pubRow); published++ } catch (e) { /* 单行失败忽略 */ }
        }
        // 分发给所有已有用户（跳过已有同题干的题）
        if (published) {
          try {
            const users = await db.from('zx_users').select('openid').limit(500)
            const newRows = toPublish.map(function (q) {
              const r = Object.assign({}, q)
              r.id = 'q_' + crypto.randomBytes(6).toString('hex')
              r.paper_id = '' // 分发题不挂管理员的草稿试卷
              r.student_id = ''
              r.scope = 'system'
              r.confirmed = true
              r.need_confirm = false
              r.created_at = new Date().toISOString()
              return r
            })
            for (const u of (users.data || [])) {
              const sid = u.openid
              if (!sid || sid === 'demo_student' || sid === studentId) continue
              try {
                const own = await db.from('zx_questions').select('stem').eq('student_id', sid).limit(500)
                const stems = new Set((own.data || []).map(function (r) { return r.stem }))
                let n = 0
                for (const row of newRows) {
                  if (stems.has(row.stem)) continue
                  try {
                    await db.from('zx_questions').insert(Object.assign({}, row, { student_id: sid, id: 'q_' + crypto.randomBytes(6).toString('hex') }))
                    n++
                  } catch (e) { /* 单行失败忽略 */ }
                }
                if (n) { syncedUsers++; syncedRows += n }
              } catch (e) { /* 单用户失败忽略 */ }
            }
          } catch (e) { /* 分发失败不影响主入库 */ }
        }
      }
      return respond(event, {
        code: 0, count: rows.length, isSystem,
        published, syncedUsers, syncedRows,
        note: isSystem
          ? ('已发布为系统题库：' + rows.length + ' 题入库，公共库新增 ' + published + ' 题，分发给 ' + syncedUsers + ' 位用户（' + syncedRows + ' 题）。')
          : ('已入库 ' + rows.length + ' 题')
      })
    } catch (e) {
      return respond(event, { code: -1, message: e && e.message })
    }
  }

  // ============ 动作三：人工校对修改（只改本人名下题目） ============
  if (action === 'updateQuestion') {
    const appDb = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
    const db = appDb.rdb()
    try {
      if (!questionId || !patch || typeof patch !== 'object') {
        return respond(event, { code: -1, message: '缺少 questionId 或 patch' })
      }
      // 校验归属，防止改他人题目
      const own = await db.from('zx_questions').select('id')
        .eq('id', questionId).eq('student_id', studentId).limit(1)
      if (!(own.data && own.data.length)) {
        return respond(event, { code: -403, message: '题目不存在或无权修改' })
      }
      // 白名单字段，防止越权改 student_id 等
      const safe = {}
      if (typeof patch.stem === 'string') safe.stem = patch.stem.slice(0, 500)
      if (typeof patch.q_type === 'string') safe.q_type = qt.normalizeType(patch.q_type)
      if (Array.isArray(patch.options)) safe.options = JSON.stringify(patch.options.slice(0, 6).map(String))
      // answer：单选=整数；多选/填空=数组；主观题=文本
      if (Number.isInteger(patch.answer)) safe.answer = JSON.stringify(patch.answer)
      else if (Array.isArray(patch.answer)) safe.answer = JSON.stringify(patch.answer.slice(0, 10))
      else if (typeof patch.answer === 'string') safe.answer = JSON.stringify(patch.answer.slice(0, 2000))
      if (Array.isArray(patch.scoring_points)) {
        safe.scoring_points = JSON.stringify(patch.scoring_points.slice(0, 8).map(p => ({
          point: String((p && (p.point || p.text)) || '').slice(0, 80),
          score: Number((p && p.score) || 0)
        })))
      }
      if (Number.isFinite(Number(patch.score)) && Number(patch.score) > 0) safe.score = Number(patch.score)
      if (typeof patch.analysis === 'string') safe.analysis = patch.analysis.slice(0, 800)
      if (typeof patch.original === 'string') safe.original = patch.original.slice(0, 200)
      // 出题年份/年级/省市（人工校对可改；解析值也走这里回写）
      if (patch.year !== undefined && patch.year !== null) {
        const y = Number(patch.year)
        safe.year = (Number.isInteger(y) && y >= 1990 && y <= 2100) ? y : 0
      }
      if (typeof patch.grade === 'string') safe.grade = patch.grade.slice(0, 20)
      if (typeof patch.region === 'string') safe.region = patch.region.slice(0, 40)
      if (patch.needFix === false) { safe.need_fix = false; safe.issues = JSON.stringify([]) }
      if (Array.isArray(patch.knowledge_tags)) safe.knowledge_tags = JSON.stringify(patch.knowledge_tags.slice(0, 5).map(String))
      // 结构化知识点 → 课本册次
      if (Array.isArray(patch.knowledge_points)) {
        safe.knowledge_points = JSON.stringify(patch.knowledge_points.slice(0, 8).map(function (k) {
          return { name: String((k && k.name) || '').slice(0, 40), book: String((k && k.book) || '').slice(0, 30), inferred: !!k.inferred }
        }).filter(function (k) { return !!k.name }))
      }
      if (typeof patch.confirmed === 'boolean') safe.confirmed = patch.confirmed
      if (patch.confirmed === true) safe.need_confirm = false
      if (Object.keys(safe).length) {
        await db.from('zx_questions').update(safe).eq('id', questionId).eq('student_id', studentId)
      }
      return respond(event, { code: 0, questionId, updated: Object.keys(safe) })
    } catch (e) {
      return respond(event, { code: -1, message: e && e.message })
    }
  }

  // ============ 动作：我的试卷 —— 按「来源 + 学科」合并列举 ============
  if (action === 'listSources') {
    const appDb = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
    const db = appDb.rdb()
    try {
      // 1) 拉本人所有已确认题目（含新增三维度与 id，用于「是否已刷」判定）
      const qr = await db.from('zx_questions')
        .select('id,subject,original,enabled,year,grade,region,scope')
        .eq('student_id', studentId).eq('confirmed', true).limit(2000)
      const rows = qr.data || []

      // 1.5) 旧数据回填：维度为空但从 original 可解析的，幂等写回
      const backfill = []
      rows.forEach(function (q) {
        const needYear = !Number(q.year)
        const needGrade = !q.grade
        const needRegion = !q.region
        if ((needYear || needGrade || needRegion) && q.original) {
          const meta = qmeta.inferMeta(q.original, { year: q.year, grade: q.grade, region: q.region })
          if ((needYear && meta.year) || (needGrade && meta.grade) || (needRegion && meta.region)) {
            if (needYear && meta.year) q.year = meta.year
            if (needGrade && meta.grade) q.grade = meta.grade
            if (needRegion && meta.region) q.region = meta.region
            backfill.push({ id: q.id, year: meta.year, grade: meta.grade, region: meta.region })
          }
        }
      })
      if (backfill.length) {
        await Promise.all(backfill.map(function (b) {
          const patch = {}
          if (b.year) patch.year = b.year
          if (b.grade) patch.grade = b.grade
          if (b.region) patch.region = b.region
          return db.from('zx_questions').update(patch).eq('id', b.id).eq('student_id', studentId).catch(function () {})
        }))
      }

      // 2) 拉取本人已作答题目 id，用于「是否已刷」
      let answeredIds = new Set()
      try {
        const ar = await db.from('zx_answer_record').select('question_id')
          .eq('student_id', studentId).limit(5000)
        ;(ar.data || []).forEach(function (r) { if (r.question_id) answeredIds.add(r.question_id) })
      } catch (e) { /* 作答表读取失败不影响列表 */ }

      // 3) 按 subject + original 分组，聚合维度/启用/已刷
      const map = {}
      rows.forEach(function (q) {
        const subj = q.subject || '其他'
        const orig = (q.original || '').trim() || '未标注来源'
        const scope = q.scope === 'system' ? 'system' : 'user'
        const key = subj + '\n' + orig + '\n' + scope
        if (!map[key]) {
          map[key] = {
            subject: subj, original: orig, scope: scope, count: 0, enabledCount: 0, brushedCount: 0,
            year: Number(q.year) || 0, grade: q.grade || '', region: q.region || ''
          }
        }
        const g = map[key]
        g.count++
        if (q.enabled !== false) g.enabledCount++
        if (answeredIds.has(q.id)) g.brushedCount++
        // 维度取组内第一个非空值（同一来源组通常一致）
        if (!g.year && Number(q.year)) g.year = Number(q.year)
        if (!g.grade && q.grade) g.grade = q.grade
        if (!g.region && q.region) g.region = q.region
      })

      let sources = Object.keys(map).map(function (key) {
        const g = map[key]
        return {
          subject: g.subject, original: g.original, scope: g.scope, count: g.count,
          year: g.year, grade: g.grade, region: g.region,
          brushed: g.brushedCount > 0, brushedCount: g.brushedCount,
          enabled: g.enabledCount > 0
        }
      })
      sources.sort(function (a, b) {
        return (a.subject.localeCompare(b.subject, 'zh')) ||
          (a.original.localeCompare(b.original, 'zh')) ||
          (String(a.scope).localeCompare(String(b.scope)))
      })

      // 4) 首次按学段自动启用：仅当作 initByGrade=true 且用户有年级时执行（不覆盖用户后续手动调整）
      let initInfo = null
      if (doInit === true) {
        try {
          const meRes = await db.from('zx_users').select('grade_index,grade_base_year,source_grade_init')
            .eq('openid', studentId).limit(1)
          const me = (meRes.data || [])[0] || {}
          const gi = Number(me.grade_index) || 0
          const by = Number(me.grade_base_year) || 0
          // 用当前学年计算实际年级（与前端 grade.js 一致）
          const now = new Date()
          const curSchoolYear = (now.getMonth() + 1 >= 9) ? now.getFullYear() : now.getFullYear() - 1
          let curIdx = (gi && by) ? (gi + (curSchoolYear - by)) : gi
          curIdx = Math.max(0, Math.min(13, curIdx))
          if (curIdx >= 1 && curIdx <= 12) {
            const userStage = qmeta.stageOf(qmeta.GRADES[curIdx - 1])
            const initializedStage = me.source_grade_init || ''
            // 幂等：只有从未初始化 或 学段发生变化（升学）时才重新按学段勾选，
            // 避免覆盖用户在学段内手动调整的启用状态。
            if (initializedStage !== userStage) {
              // 同一学段全部启用；无学段标注(unknown)的题也启用（避免误伤未标注来源）
              sources.forEach(function (s) {
                const st = qmeta.stageOf(s.grade)
                s.enabled = (st === userStage || st === 'unknown')
              })
              // 批量写回数据库：按 subject+original 更新
              for (const s of sources) {
                const origVal = s.original === '未标注来源' ? '' : s.original
                await db.from('zx_questions').update({ enabled: !!s.enabled })
                  .eq('student_id', studentId).eq('subject', s.subject).eq('original', origVal)
              }
              // 记录本次初始化学段
              await db.from('zx_users').update({ source_grade_init: userStage }).eq('openid', studentId)
              initInfo = { initialized: true, gradeLabel: qmeta.GRADES[curIdx - 1], stage: userStage }
            } else {
              initInfo = { initialized: false, reason: '已按当前学段初始化过', stage: userStage }
            }
          } else {
            initInfo = { initialized: false, reason: '未设置年级或无匹配试卷' }
          }
        } catch (e) {
          initInfo = { initialized: false, reason: e && e.message }
        }
      }

      // 5) 筛选项候选值（基于全量数据，筛选后不应缩小候选）
      const allSubjects = Array.from(new Set(sources.map(function (s) { return s.subject })))
      const allRegions = Array.from(new Set(sources.map(function (s) { return s.region }).filter(Boolean)))
      const allGrades = Array.from(new Set(sources.map(function (s) { return s.grade }).filter(Boolean)))
      const allScopes = Array.from(new Set(sources.map(function (s) { return s.scope }).filter(Boolean)))

      // 6) 前端筛选（科目/省市/年级/是否已刷）
      if (filters && typeof filters === 'object') {
        const f = filters
        sources = sources.filter(function (s) {
          if (f.subject && s.subject !== f.subject) return false
          if (f.region && s.region !== f.region) return false
          if (f.grade && s.grade !== f.grade) return false
          if (f.scope && s.scope !== f.scope) return false
          if (f.brushed === 'yes' && !s.brushed) return false
          if (f.brushed === 'no' && s.brushed) return false
          return true
        })
      }

      return respond(event, {
        code: 0, sources, total: sources.length, initInfo,
        filterOptions: { subjects: allSubjects, regions: allRegions, grades: allGrades, scopes: allScopes }
      })
    } catch (e) {
      return respond(event, { code: -1, message: e && e.message })
    }
  }

  // ============ 动作：勾选启用/停用某个「来源 + 学科」下的全部题目 ============
  if (action === 'setSourceEnabled') {
    const appDb = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
    const db = appDb.rdb()
    try {
      if (!original) return respond(event, { code: -1, message: '缺少来源字段' })
      const subj = subject || '其他'
      const isEnabled = enabled !== false
      // original 可能是「未标注来源」占位，对应库里 original=''
      const origVal = original === '未标注来源' ? '' : original
      const scopeVal = scope === 'system' ? 'system' : 'user'
      let upd = db.from('zx_questions').update({ enabled: isEnabled })
        .eq('student_id', studentId).eq('subject', subj).eq('original', origVal).eq('scope', scopeVal)
      const res = await upd
      return respond(event, { code: 0, subject: subj, original, scope: scopeVal, enabled: isEnabled, updated: (res.data || []).length })
    } catch (e) {
      return respond(event, { code: -1, message: e && e.message })
    }
  }

  // ============ 动作：加载某个「来源 + 学科」下的全部题目（供点击查看/编辑） ============
  if (action === 'loadSource') {
    const appDb = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
    const db = appDb.rdb()
    try {
      if (!original) return respond(event, { code: -1, message: '缺少来源字段' })
      const subj = subject || '其他'
      const origVal = original === '未标注来源' ? '' : original
      let qry = db.from('zx_questions').select('*')
        .eq('student_id', studentId).eq('subject', subj).eq('confirmed', true)
        .eq('original', origVal)
      if (scope === 'system' || scope === 'user') qry = qry.eq('scope', scope)
      const qr = await qry.limit(500)
      const rows = qr.data || []
      const questions = rows.map(function (row) {
        const type = qt.normalizeType(row.q_type)
        const m = qt.meta(type)
        return {
          id: row.id, q_type: type, stem: row.stem || '',
          options: parseArr(row.options), answer: qt.asValue(row.answer),
          scoring_points: qt.asValue(row.scoring_points) || [],
          score: Number(row.score) || (m.family === 'subjective' ? 10 : 2),
          analysis: row.analysis || '', original: row.original || '',
          year: Number(row.year) || 0, grade: row.grade || '', region: row.region || '',
          knowledge_tags: parseArr(row.knowledge_tags), tags: parseArr(row.knowledge_tags),
          knowledge_points: parseArr(row.knowledge_points).length
            ? parseArr(row.knowledge_points)
            : kbook.buildKnowledgePoints(parseArr(row.knowledge_tags), null, subj, row.grade),
          needFix: !!row.need_fix, issues: parseArr(row.issues),
          confidence: Number(row.confidence) || 1, confirmed: true
        }
      })
      return respond(event, {
        code: 0, subject: subj, original,
        paper: { id: 'src_' + subj + '_' + Date.now().toString(36), title: original + '·' + subj, subject: subj, count: questions.length, status: 'confirmed' },
        questions
      })
    } catch (e) {
      return respond(event, { code: -1, message: e && e.message })
    }
  }

  // ============ 动作一：识别并写库（pending） ============
  const mode = process.env.RECOGNIZE_MODE || 'ai'

  // 频率限制：防止 AI 成本被刷爆。按当天 zx_papers 里 source='ai' 的试卷数计数。
  if (mode === 'ai' && (imageBase64 || fileUrl)) {
    const appDb = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
    const db = appDb.rdb()
    try {
      const limit = Number(process.env.RECOGNIZE_DAILY_LIMIT || 10)
      const today = new Date().toISOString().slice(0, 10)
      const todayCount = await db.from('zx_papers')
        .select('id').eq('student_id', studentId).eq('source', 'ai')
        .gte('created_at', today + 'T00:00:00.000Z').limit(limit + 1)
      if ((todayCount.data || []).length >= limit) {
        return respond(event, {
          code: -429,
          message: '今日识别次数已达上限（' + limit + ' 次/天），请明天再试或联系管理员',
          limit
        })
      }
    } catch (e) { console.warn('[recognize] 频率检查失败，放行：', e && e.message) }
  }

  let questions = []
  let engine = 'demo'
  let note = 'Demo 预置样题；在控制台开启生文模型并上传真实试卷即可走 AI 拆题。'

  if (mode !== 'demo' && (imageBase64 || fileUrl)) {
    try {
      questions = await aiExtract(imageBase64, fileUrl, mimeType, subject)
      engine = 'ai'
      note = 'AI 视觉模型 OCR+拆题完成，题目待人工校对。'
    } catch (e) {
      console.warn('[recognize] AI 拆题失败，降级样题：', e && e.message)
      questions = SAMPLE.map(q => Object.assign({}, q))
      note = 'AI 识别失败（' + (e && e.message || '未知') + '），已降级为样题。'
    }
  } else {
    questions = SAMPLE.map(q => Object.assign({}, q))
    if (mode !== 'demo' && !(imageBase64 || fileUrl)) {
      note = '未收到图片数据（请用「拍照/选图」上传试卷），已使用样题。'
    }
  }

  questions = questions.map(q => {
    const src = q.original || fileName || ''
    const meta = qmeta.inferMeta(src, { year: q.year, grade: q.grade, region: q.region })
    return Object.assign({}, q, {
      id: genId('q'), tags: q.knowledge_tags,
      knowledge_points: kbook.buildKnowledgePoints(q.knowledge_tags, q.knowledge_points, subject, meta.grade),
      year: meta.year, grade: meta.grade, region: meta.region
    })
  })

  // 【内容安全】并发剔除题干含违规信息的题（fail-open；仅本地高危词硬拦截）
  const aiChecks = await Promise.all(questions.map(function (q) {
    return contentCheck.checkText((q.stem || '') + ' ' + (q.analysis || ''), studentId)
  }))
  let aiBlocked = 0
  const aiSafe = []
  questions.forEach(function (q, i) {
    if (aiChecks[i] && aiChecks[i].pass) aiSafe.push(q); else aiBlocked++
  })
  questions = aiSafe

  const appDb = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
  const db = appDb.rdb()
  try {
    if (!questions.length) {
      return respond(event, { code: 0, paperId: '', subject: subject || '数学', questions: [], engine,
        note: '识别到的题目未通过内容安全检查，未入库。请更换试卷内容后重试。' })
    }
    const pid = genId('p')
    await db.from('zx_papers').insert({
      id: pid, student_id: studentId, scope: writeScope,
      title: fileName || 'AI识别·云试卷', subject: subject || '数学',
      grade: '九年级', source: engine === 'ai' ? 'ai' : 'demo', original: (fileName || '').slice(0, 200), file_id: fileID || null,
      question_count: questions.length, ocr_status: engine === 'ai' ? 'done' : 'demo',
      confirm_status: 'draft', created_at: new Date().toISOString()
    })
    // 【v1.9.7】批量并发写题，避免逐条串行 await 触发 3 秒超时
    const aiRows = questions.map(function (q) {
      const type = qt.normalizeType(q.q_type)
      const m = qt.meta(type)
      return {
        id: q.id, paper_id: pid, student_id: studentId,
        scope: writeScope, // v1.9.13：管理端导入为 system 草稿，确认后发布；用户导入为 user
        subject: subject || '数学', q_type: type, stem: q.stem,
        options: JSON.stringify(q.options || []), answer: JSON.stringify(q.answer),
        scoring_points: JSON.stringify(q.scoring_points || []),
        score: q.score || (m.family === 'subjective' ? 10 : 2),
        analysis: q.analysis, knowledge_tags: JSON.stringify(q.knowledge_tags),
        knowledge_points: JSON.stringify(kbook.buildKnowledgePoints(q.knowledge_tags, q.knowledge_points, subject, q.grade)),
        original: (q.original || fileName || '').slice(0, 200),
        year: q.year || 0, grade: q.grade || '', region: q.region || '',
        confidence: q.confidence, need_confirm: true, confirmed: false,
        created_at: new Date().toISOString()
      }
    })
    const aiWr = await insertRowsBatched(db, 'zx_questions', aiRows, 12)
      return respond(event, {
        code: 0, paperId: pid, subject: subject || '数学', questions,
        engine, imported: aiWr.ok, writeFailed: aiWr.failed,
        note: note + (aiBlocked ? '（已过滤 ' + aiBlocked + ' 道违规题）' : '') + (aiWr.failed ? '（' + aiWr.failed + ' 题写入失败）' : '')
      })
  } catch (e) {
    return respond(event, { code: -1, message: e && e.message })
  }
}
