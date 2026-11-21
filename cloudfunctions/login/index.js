/**
 * 云函数 login —— 微信云调用身份登录 + 首次建档（安全版）
 *
 * 身份来源（唯一可信）：微信云函数运行时注入的 openid。
 *   - 通过 wx.cloud.callFunction 调用时，微信会在运行时注入 OPENID；
 *   - 优先 wx-server-sdk.getWXContext().OPENID，兜底环境变量 WX_OPENID。
 *   - 【安全】绝不使用前端传入的 studentId / clientId 作为身份——
 *     HTTP 网关或外部调用拿不到 openid，一律拒绝，杜绝越权。
 *
 * 首次登录自动做两件事（幂等）：
 *   - 在 zx_users upsert 用户档案（openid / last_login_at）
 *   - 若该 student_id 名下无任何题目，克隆 demo_student 的 12 道确认种子题，
 *     保证新用户一进来就能组卷（三个业务云函数无需改动）
 *
 * 入参：无（身份从微信上下文取）
 * 出参：{ code:0, studentId(即openid), authMode:'openid', isNew, seeded, appId }
 */
const cloudbase = require('@cloudbase/js-sdk')

const DEFAULT_APPID = 'wx8874a19dbd6fa717'

/** HTTP 网关适配（保留兼容；但网关调用无 openid，会在身份处被拒绝） */
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

/**
 * 取微信云调用注入的真实身份 openid（唯一可信来源）。
 * 取不到返回 ''，调用方应拒绝本次请求。
 */
function getCallerOpenId() {
  try {
    const wx = require('wx-server-sdk')
    wx.init({ env: wx.DYNAMIC_CURRENT_ENV })
    const ctx = wx.getWXContext() || {}
    if (ctx.OPENID) return ctx.OPENID
  } catch (e) { /* 未安装 wx-server-sdk 或非微信云调用环境 */ }
  // 微信云函数运行时也会直接注入环境变量（部分基础库/运行时）
  return process.env.WX_OPENID || ''
}

exports.main = async (event) => {
  const p = parseEvent(event)

  // 1) 身份：只认微信注入的 openid，前端传什么都不信
  const studentId = getCallerOpenId()
  if (!studentId) {
    return respond(event, {
      code: -401,
      message: '无法验证微信身份：请通过小程序的 wx.cloud.callFunction 调用；HTTP 网关和外部请求不受理',
      needWxCall: true
    })
  }

  const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
  const db = app.rdb()
  try {
    // 2) upsert 用户档案
    const exist = await db.from('zx_users').select('id').eq('openid', studentId).limit(1)
    const isNew = !(exist.data && exist.data.length)
    if (isNew) {
      await db.from('zx_users').insert({
        id: 'u_' + studentId,
        openid: studentId,
        role: 'student',
        nickname: '微信用户',
        created_at: new Date().toISOString(),
        last_login_at: new Date().toISOString()
      })
    } else {
      await db.from('zx_users').update({ last_login_at: new Date().toISOString() })
        .eq('openid', studentId)
    }

    // 3) 首次建档：克隆种子题（幂等：名下已有题则跳过）
    let seeded = 0
    const own = await db.from('zx_questions').select('id').eq('student_id', studentId).limit(1)
    if (!(own.data && own.data.length)) {
      const seeds = await db.from('zx_questions')
        .select('*').eq('student_id', 'demo_student').eq('confirmed', true).limit(500)
      for (const q of (seeds.data || [])) {
        try {
          await db.from('zx_questions').insert(Object.assign({}, q, {
            id: 'q_' + require('crypto').randomBytes(5).toString('hex'),
            student_id: studentId,
            created_at: new Date().toISOString()
          }))
          seeded++
        } catch (e) { /* 单行失败不影响整体 */ }
      }
    }

    return respond(event, {
      code: 0, studentId, authMode: 'openid', isNew, seeded,
      appId: DEFAULT_APPID, note: '微信 openid 登录成功，身份由云端注入，前端不可伪造'
    })
  } catch (e) {
    return respond(event, { code: -1, message: e && e.message })
  }
}
