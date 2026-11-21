/**
 * 云函数 recognize —— PDF/图片试卷 AI 拆题 + 确认入库（PostgreSQL 版）
 *
 * 识别链路（生产）：
 *   前端把图片/PDF 读成 base64 随 HTTP 请求传入 →
 *   CloudBase 视觉大模型（glm-5.3-flash，可读图片/PDF）一次性做 OCR + 拆题 + 打标签 →
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
 * 入参：{ studentId, fileName, subject, imageBase64?, fileBase64?, mimeType? }
 *      { action:'confirm', studentId, paperId }
 * 出参：{ code:0, paperId, subject, questions:[...], engine:'ai'|'demo', note }
 */
const cloudbase = require('@cloudbase/js-sdk')
const tcb = require('@cloudbase/node-sdk')

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
  { stem: '若 a−b=3，ab=2，则 a²+b² 的值为（　）', options: ['5', '9', '13', '11'], answer: 2, analysis: 'a²+b²=(a−b)²+2ab=9+4=13。', knowledge_tags: ['k2'], confidence: 0.96 },
  { stem: '已知 AB=AC，∠A=60°，则△ABC 是（　）', options: ['直角三角形', '等边三角形', '等腰直角三角形', '钝角三角形'], answer: 1, analysis: '有一个角60°的等腰三角形是等边三角形。', knowledge_tags: ['k1', 'k7'], confidence: 0.91 },
  { stem: '函数 y=−3x+4 的图象经过（　）', options: ['一、二、四象限', '一、三象限', '二、四象限', '一、二、三象限'], answer: 0, analysis: 'k<0,b>0，经过一、二、四象限。', knowledge_tags: ['k5'], confidence: 0.88 },
  { stem: '切线与过切点的半径的位置关系是（　）', options: ['平行', '垂直', '相交', '重合'], answer: 1, analysis: '圆的切线垂直于过切点的半径。', knowledge_tags: ['k6'], confidence: 0.93 }
]

const SYSTEM_PROMPT = '你是初中试卷拆题助手。从试卷中抽取单选题，输出严格 JSON 数组，不要任何解释文字或代码块标记。每个元素字段：stem(题干字符串), options(4个选项字符串数组), answer(正确答案下标0-3的数字), analysis(简短解析字符串), knowledge_tags(1-3个知识点标签字符串数组，如"全等三角形"/"一次函数"/"圆")。只输出题目本身能识别的题，最多10道；无法确定的题请跳过。输出格式：[{"stem":"...","options":["A","B","C","D"],"answer":0,"analysis":"...","knowledge_tags":["..."]}]'

/** 调视觉大模型拆题；失败抛出异常由上层降级 */
async function aiExtract(imageBase64, fileBase64, mimeType, subject) {
  const modelName = process.env.AI_MODEL || 'glm-5.3-flash'
  const app = tcb.init({ env: tcb.SYMBOL_CURRENT_ENV, timeout: 120000 })
  const ai = app.ai()
  const model = ai.createModel('cloudbase')

  let mediaBlock
  if (fileBase64 && /pdf/i.test(mimeType || '')) {
    // PDF：glm-5.3-flash 支持文件块，但需公网 URL；这里用 data URL 兜底尝试
    mediaBlock = { type: 'file', file: { file_url: 'data:application/pdf;base64,' + fileBase64 } }
  } else {
    const b64 = (imageBase64 || fileBase64 || '').replace(/^data:[^;]+;base64,/, '')
    if (!b64) throw new Error('没有可识别的图片数据')
    const mime = /png/i.test(mimeType || '') ? 'image/png' : 'image/jpeg'
    mediaBlock = { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + b64 } }
  }

  const res = await model.generateText({
    model: modelName,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: [
        { type: 'text', text: '学科：' + (subject || '数学') + '。请拆出这张试卷里的单选题。' },
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
    const opts = Array.isArray(q.options) ? q.options.slice(0, 4).map(String) : ['A', 'B', 'C', 'D']
    let ans = Number(q.answer)
    if (!Number.isInteger(ans) || ans < 0 || ans >= opts.length) ans = 0
    return {
      stem: String(q.stem || '').slice(0, 500),
      options: opts,
      answer: ans,
      analysis: String(q.analysis || '').slice(0, 800),
      knowledge_tags: Array.isArray(q.knowledge_tags) ? q.knowledge_tags.slice(0, 3).map(String) : [],
      confidence: 0.9
    }
  }).filter(q => q.stem)
}

exports.main = async (event) => {
  const p = parseEvent(event)
  const { action, studentId, fileID, fileName, subject, paperId, imageBase64, fileBase64, mimeType } = p
  if (!studentId) return respond(event, { code: -1, message: '缺少 studentId' })

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

  // ============ 动作一：识别并写库（pending） ============
  const mode = process.env.RECOGNIZE_MODE || 'ai'
  let questions = []
  let engine = 'demo'
  let note = 'Demo 预置样题；在控制台开启生文模型并上传真实试卷即可走 AI 拆题。'

  if (mode !== 'demo' && (imageBase64 || fileBase64)) {
    try {
      questions = await aiExtract(imageBase64, fileBase64, mimeType, subject)
      engine = 'ai'
      note = 'AI 视觉模型 OCR+拆题完成，题目待人工校对。'
    } catch (e) {
      console.warn('[recognize] AI 拆题失败，降级样题：', e && e.message)
      questions = SAMPLE.map(q => Object.assign({}, q))
      note = 'AI 识别失败（' + (e && e.message || '未知') + '），已降级为样题。'
    }
  } else {
    questions = SAMPLE.map(q => Object.assign({}, q))
    if (mode !== 'demo' && !(imageBase64 || fileBase64)) {
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
      await db.from('zx_questions').insert({
        id: q.id, paper_id: pid, student_id: studentId,
        subject: subject || '数学', q_type: 'single', stem: q.stem,
        options: JSON.stringify(q.options), answer: JSON.stringify(q.answer),
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
