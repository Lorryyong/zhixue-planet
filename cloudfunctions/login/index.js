/**
 * 云函数 login —— 真实用户身份（openid）登录 / 匿名兜底 + 首次建档
 *
 * 两种身份模式：
 *   1) 正式：前端 wx.login 拿到 code → 传 code，云函数用 AppSecret 调微信
 *      jscode2session 换真实 openid。AppSecret 从环境变量 WX_APP_SECRET 读取，
 *      绝不写进代码/仓库。需在云函数控制台配置该环境变量一次。
 *   2) 兜底：未配置 AppSecret 时，前端传 clientId（本地生成的匿名设备 ID），
 *      用它建档。换设备数据不互通，但闭环可先跑起来；配好 secret 后自动升级。
 *
 * 首次登录自动做两件事（幂等）：
 *   - 在 zx_users upsert 用户档案（openid / last_login_at）
 *   - 若该 student_id 名下无任何题目，克隆 demo_student 的 12 道确认种子题，
 *     保证新用户一进来就能组卷（三个业务云函数无需改动）
 *
 * 入参：{ code?, clientId?, appId? }
 * 出参：{ code:0, studentId, authMode:'openid'|'anonymous', isNew,
 *         seeded:number, appId }
 */
const cloudbase = require('@cloudbase/js-sdk')
const https = require('https')

const DEFAULT_APPID = 'wx8874a19dbd6fa717'

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

/** 用 code 调微信 jscode2session 换 openid */
function code2Session(appId, secret, code) {
  return new Promise((resolve, reject) => {
    const url = 'https://api.weixin.qq.com/sns/jscode2session?appid=' +
      encodeURIComponent(appId) + '&secret=' + encodeURIComponent(secret) +
      '&js_code=' + encodeURIComponent(code) + '&grant_type=authorization_code'
    https.get(url, res => {
      let buf = ''
      res.on('data', d => { buf += d })
      res.on('end', () => {
        try {
          const j = JSON.parse(buf)
          if (j.openid) resolve(j)
          else reject(new Error(j.errmsg || ('jscode2session 失败: errcode ' + j.errcode)))
        } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

exports.main = async (event) => {
  const p = parseEvent(event)
  const code = p.code || ''
  const clientId = p.clientId || ''
  const appId = p.appId || DEFAULT_APPID
  const secret = process.env.WX_APP_SECRET || ''

  // 1) 确定身份
  let studentId = ''
  let authMode = ''
  try {
    if (secret && code) {
      const sess = await code2Session(appId, secret, code)
      studentId = sess.openid
      authMode = 'openid'
    } else if (clientId) {
      studentId = clientId
      authMode = 'anonymous'
    } else {
      return respond(event, {
        code: -1,
        message: secret ? '缺少 code（前端需先 wx.login）' : '未配置 AppSecret，且缺少 clientId',
        needSecret: !secret
      })
    }
  } catch (e) {
    // code 无效 / 过期：让前端降级到匿名，不直接失败
    if (clientId) {
      studentId = clientId
      authMode = 'anonymous'
    } else {
      return respond(event, { code: -1, message: e && e.message, needSecret: !secret })
    }
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
        nickname: authMode === 'openid' ? '微信用户' : '体验用户',
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
      code: 0, studentId, authMode, isNew, seeded, appId,
      note: authMode === 'anonymous'
        ? '匿名模式：配置云函数环境变量 WX_APP_SECRET 后自动升级为微信真实 openid'
        : '微信 openid 登录成功'
    })
  } catch (e) {
    return respond(event, { code: -1, message: e && e.message })
  }
}
