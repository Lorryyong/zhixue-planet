/**
 * 云函数 radarData —— 学情画像数据（按学科动态）
 *
 * 身份仅认微信注入的 openid。返回：
 *   - subjects：出现过的学科列表（含「综合」）
 *   - mastery ：[{ id, name, score, subject }]，knowledge_id 即知识点名
 *   - bookMap ：{ 知识点名: 课本册次 }，来自题目 knowledge_points 的人工/推断册次
 *   - blind   ：薄弱知识点（score<75）按分数升序
 *
 * 前端据此按所选学科过滤、画雷达图、展示课本册次，彻底替代写死的 k1~k6。
 */
const cloudbase = require('@cloudbase/js-sdk')

function getCallerOpenId() {
  try {
    const wx = require('wx-server-sdk')
    wx.init({ env: wx.DYNAMIC_CURRENT_ENV })
    const ctx = wx.getWXContext() || {}
    if (ctx.OPENID) return ctx.OPENID
  } catch (e) { /* 非微信云调用环境 */ }
  return process.env.WX_OPENID || ''
}
function parseEvent(event) {
  if (!event || !event.body) return event || {}
  let raw = event.body
  if (event.isBase64Encoded) { try { raw = Buffer.from(raw, 'base64').toString('utf8') } catch (e) {} }
  if (typeof raw === 'string') { try { return JSON.parse(raw) } catch (e) { return {} } }
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
function parseArr(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') { try { return JSON.parse(v) } catch (e) { return [] } }
  return []
}

exports.main = async (event) => {
  const p = parseEvent(event)
  const studentId = getCallerOpenId()
  if (!studentId) return respond(event, { code: -401, message: '无法验证微信身份，请通过 wx.cloud.callFunction 调用', needWxCall: true })
  const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
  const db = app.rdb()

  try {
    const [mRes, qRes] = await Promise.all([
      db.from('zx_mastery').select('*').eq('student_id', studentId).limit(500),
      db.from('zx_questions').select('knowledge_points').eq('student_id', studentId).limit(500)
    ])
    const mastery = (mRes.data || []).map(function (m) {
      return {
        id: m.knowledge_id || '',
        name: m.knowledge_id || '',
        score: Number(m.score) || 0,
        subject: m.subject || ''
      }
    }).filter(function (m) { return !!m.id })

    // 题目知识点 → 课本册次映射（优先人工标注 book）
    const bookMap = {}
    ;(qRes.data || []).forEach(function (q) {
      parseArr(q.knowledge_points).forEach(function (k) {
        if (k && k.name && k.book && !bookMap[k.name]) bookMap[k.name] = String(k.book).slice(0, 30)
      })
    })

    const subjSet = {}
    mastery.forEach(function (m) { if (m.subject) subjSet[m.subject] = true })
    const subjects = ['综合'].concat(Object.keys(subjSet).sort())
    const blind = mastery.filter(function (m) { return m.score < 75 })
      .sort(function (a, b) { return a.score - b.score }).slice(0, 10)

    return respond(event, { code: 0, subjects, mastery, bookMap, blind })
  } catch (e) {
    return respond(event, { code: -1, message: e && e.message })
  }
}
