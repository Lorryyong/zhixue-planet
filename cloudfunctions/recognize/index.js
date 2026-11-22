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
 * 两种动作：
 *   1) 识别（默认）：写入待校对题目，返回题目供前端校对。
 *   2) 确认入库：{ action:'confirm', studentId, paperId }，置为 confirmed。
 *
 * 说明：AI 用 @cloudbase/node-sdk 的 app.ai()，云函数内走环境凭证，
 *       无需单独 API Key；模型开关在云开发控制台「AI→生文模型」开启。
 *       模型名可用环境变量 AI_MODEL 覆盖（默认 glm-5.3-flash）。
 *
 * 入参：{ fileName, subject, imageBase64?, fileUrl?, mimeType? }
 *      { action:'confirm'|'updateQuestion', ... }
 * 出参：{ code:0, paperId, subject, questions:[...], engine:'ai'|'demo', note }
 */
const cloudbase = require('@cloudbase/js-sdk')
const tcb = require('@cloudbase/node-sdk')
const qt = require('./questionTypes.js')

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
  const { action, fileID, fileName, subject, paperId, questionId, patch, imageBase64, fileUrl, mimeType } = p
  // 【安全】身份只认微信云调用注入的 openid，忽略前端传入的 studentId
  const studentId = getCallerOpenId()
  if (!studentId) return respond(event, { code: -401, message: '无法验证微信身份，请通过 wx.cloud.callFunction 调用', needWxCall: true })

  // ============ 动作二：确认入库 ============
  if (action === 'confirm') {
    const appDb = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
    const db = appDb.rdb()
    try {
      if (!paperId) return respond(event, { code: -1, message: '缺少 paperId' })
      const pending = await db.from('zx_questions')
        .select('*').eq('student_id', studentId).eq('paper_id', paperId).limit(500)
      const rows = pending.data || []
      for (const q of rows) {
        await db.from('zx_questions').update({ confirmed: true, need_confirm: false }).eq('id', q.id)
      }
      await db.from('zx_papers').update({ confirm_status: 'confirmed', question_count: rows.length })
        .eq('id', paperId).eq('student_id', studentId)
      return respond(event, { code: 0, count: rows.length })
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
      if (Array.isArray(patch.knowledge_tags)) safe.knowledge_tags = JSON.stringify(patch.knowledge_tags.slice(0, 5).map(String))
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

  questions = questions.map(q => Object.assign({}, q, { id: genId('q'), tags: q.knowledge_tags }))

  const appDb = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
  const db = appDb.rdb()
  try {
    const pid = genId('p')
    await db.from('zx_papers').insert({
      id: pid, student_id: studentId,
      title: fileName || 'AI识别·云试卷', subject: subject || '数学',
      grade: '九年级', source: engine === 'ai' ? 'ai' : 'demo', file_id: fileID || null,
      question_count: questions.length, ocr_status: engine === 'ai' ? 'done' : 'demo',
      confirm_status: 'draft', created_at: new Date().toISOString()
    })
    for (const q of questions) {
      const type = qt.normalizeType(q.q_type)
      const m = qt.meta(type)
      await db.from('zx_questions').insert({
        id: q.id, paper_id: pid, student_id: studentId,
        subject: subject || '数学', q_type: type, stem: q.stem,
        options: JSON.stringify(q.options || []), answer: JSON.stringify(q.answer),
        scoring_points: JSON.stringify(q.scoring_points || []),
        score: q.score || (m.family === 'subjective' ? 10 : 2),
        analysis: q.analysis, knowledge_tags: JSON.stringify(q.knowledge_tags),
        confidence: q.confidence, need_confirm: true, confirmed: false,
        created_at: new Date().toISOString()
      })
    }
    return respond(event, {
      code: 0, paperId: pid, subject: subject || '数学', questions,
      engine, note
    })
  } catch (e) {
    return respond(event, { code: -1, message: e && e.message })
  }
}
