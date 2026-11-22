/**
 * 云函数 trackEvent —— 轻量行为埋点（v1.9.4）
 *
 * 用途：支撑 PRD 第 7 节核心指标（激活率/闭环完成率/留存/人均答题量/识别成功率）。
 * 设计红线：
 *   - 非业务链路：调用失败不影响任何主流程，前端 fire-and-forget；
 *   - 身份只认微信注入 openid；HTTP/CLI 无身份一律拒绝；
 *   - 隐私最小化：只存事件名 + 少量标量字段，不存原文题干/答案；
 *   - 尊重隐私设置：minorMode/allowAnalytics 由前端在采集前判断，云端再做一次兜底过滤。
 *
 * 入参：{ events: [{ event:string, ts?:ISO, props?:object }] }  单次最多 20 条
 * 出参：{ code:0, saved:number }
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
function respond(event, result) {
  if (event && event.httpMethod) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      isBase64Encoded: false, body: JSON.stringify(result)
    }
  }
  return result
}
function parseEvent(event) {
  if (!event || !event.body) return event || {}
  let raw = event.body
  if (event.isBase64Encoded) { try { raw = Buffer.from(raw, 'base64').toString('utf8') } catch (e) {} }
  if (typeof raw === 'string') { try { return JSON.parse(raw) } catch (e) { return {} } }
  return raw || {}
}

// 只保留白名单标量字段，防止前端上报大对象/原文污染
const PROP_KEYS = ['subject', 'engine', 'q_type', 'count', 'value', 'correct', 'fromCloud', 'source', 'grade', 'taskDate', 'appVersion']
function cleanProps(props) {
  const out = {}
  if (!props || typeof props !== 'object') return out
  PROP_KEYS.forEach(function (k) {
    const v = props[k]
    if (v == null) return
    if (typeof v === 'string') out[k] = String(v).slice(0, 40)
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    else if (typeof v === 'boolean') out[k] = v
  })
  return out
}

exports.main = async (event) => {
  const p = parseEvent(event)
  const openid = getCallerOpenId()
  if (!openid) return respond(event, { code: -401, message: '无法验证微信身份' })
  const events = Array.isArray(p.events) ? p.events.slice(0, 20) : []
  if (!events.length) return respond(event, { code: 0, saved: 0 })

  // 隐私兜底：用户关闭统计或开启未成年模式时，云端也丢弃事件
  try {
    const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
    const db = app.rdb()
    const me = await db.from('zx_users').select('settings').eq('openid', openid).limit(1)
    const settings = (me.data && me.data[0] && me.data[0].settings) || {}
    const privacy = (typeof settings === 'object' && settings.privacy) ? settings.privacy : {}
    if (privacy.minorMode === true || privacy.allowAnalytics === false) {
      return respond(event, { code: 0, saved: 0, skipped: 'privacy' })
    }
  } catch (e) { /* 读设置失败不阻断埋点 */ }

  let saved = 0
  try {
    const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
    const db = app.rdb()
    for (const ev of events) {
      const name = String((ev && ev.event) || '').slice(0, 40)
      if (!name) continue
      try {
        await db.from('zx_events').insert({
          id: 'e_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          student_id: openid,
          event: name,
          props: JSON.stringify(cleanProps(ev.props)),
          client_ts: ev.ts ? String(ev.ts).slice(0, 30) : null,
          server_ts: new Date().toISOString()
        })
        saved++
      } catch (e) { /* 单行失败忽略 */ }
    }
  } catch (e) { /* 整体失败静默 */ }
  return respond(event, { code: 0, saved: saved })
}
