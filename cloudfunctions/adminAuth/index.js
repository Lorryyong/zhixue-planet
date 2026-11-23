/**
 * 云函数 adminAuth —— 管理端鉴权（v1.9.12）
 *
 * 内置管理员账号存于 zx_admin_accounts（admin/admin1，builtin=true 不可删除）。
 * 登录成功 → 把调用者 openid 写入 zx_admins，从而复用现有三个管理云函数
 * （importQuestions / feedback / login.listUsers）的 openid 白名单鉴权，无需改动它们。
 *
 * 动作（action）：
 *   - check        ：返回当前 openid 是否管理员（供管理端页面进入时判断）
 *   - login        ：{ username, password } 校验账号密码，成功则授权当前 openid
 *   - logout       ：解除当前 openid 的管理员授权（账号本身保留，内置账号永不删除）
 *   - listAccounts ：列出内置账号（builtin 标记，前端展示"不可删除"）
 *
 * 身份：只认微信云调用注入的 openid；账号密码仅用于授权当前微信身份。
 */
const cloudbase = require('@cloudbase/js-sdk')
const crypto = require('crypto')

function parseEvent(event) {
  if (!event || event.body) {
    let raw = event && event.body
    if (event && event.isBase64Encoded) { try { raw = Buffer.from(raw, 'base64').toString('utf8') } catch (e) {} }
    if (typeof raw === 'string') { try { return JSON.parse(raw) } catch (e) { return {} } }
    if (raw && typeof raw === 'object') return raw
  }
  return event || {}
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
function getCallerOpenId() {
  try {
    const wx = require('wx-server-sdk')
    wx.init({ env: wx.DYNAMIC_CURRENT_ENV })
    const ctx = wx.getWXContext() || {}
    if (ctx.OPENID) return ctx.OPENID
  } catch (e) {}
  return process.env.WX_OPENID || ''
}
function adminEnvList() {
  return String(process.env.ADMIN_OPENIDS || '')
    .split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
}
function sha256(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest('hex')
}

exports.main = async (event) => {
  const p = parseEvent(event)
  const openid = getCallerOpenId()
  if (!openid) return respond(event, { code: -401, message: '无法验证微信身份，请通过小程序云调用', needWxCall: true })

  const action = p.action || 'check'
  const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
  const db = app.rdb()
  const envAdmins = adminEnvList()

  async function isAdmin() {
    if (envAdmins.indexOf(openid) >= 0) return true
    try {
      const r = await db.from('zx_admins').select('openid').eq('openid', openid).limit(1)
      return !!(r.data && r.data.length)
    } catch (e) { return false }
  }

  try {
    // 是否管理员
    if (action === 'check') {
      return respond(event, { code: 0, isAdmin: await isAdmin(), openid })
    }

    // 账号密码登录 → 授权当前 openid
    if (action === 'login') {
      const username = String(p.username || '').trim()
      const password = String(p.password || '')
      if (!username || !password) return respond(event, { code: -1, message: '请输入账号和密码' })
      let acc = null
      try {
        const r = await db.from('zx_admin_accounts').select('*').eq('username', username).limit(1)
        acc = (r.data || [])[0] || null
      } catch (e) {
        return respond(event, { code: -1, message: '账号库读取失败：' + (e && e.message || e) })
      }
      if (!acc) return respond(event, { code: -2, message: '账号或密码不正确' })
      if (sha256(password) !== acc.password_hash) return respond(event, { code: -2, message: '账号或密码不正确' })

      // 授权当前 openid（幂等）
      try {
        const exist = await db.from('zx_admins').select('openid').eq('openid', openid).limit(1)
        if (!(exist.data && exist.data.length)) {
          await db.from('zx_admins').insert({
            openid, note: 'admin账号登录授权:' + username, created_at: new Date().toISOString()
          })
        }
      } catch (e) {
        return respond(event, { code: -1, message: '授权写入失败：' + (e && e.message || e) })
      }
      return respond(event, { code: 0, message: '登录成功', username, isAdmin: true })
    }

    // 退出：解除当前 openid 授权（不动账号表；内置账号永不删除）
    if (action === 'logout') {
      if (envAdmins.indexOf(openid) >= 0) {
        return respond(event, { code: -1, message: '当前身份由环境变量预设，无法在本机退出' })
      }
      try { await db.from('zx_admins').delete().eq('openid', openid) } catch (e) {}
      return respond(event, { code: 0, message: '已退出管理端' })
    }

    // 管理员账号列表（仅管理员可见；builtin 标记不可删除）
    if (action === 'listAccounts') {
      if (!(await isAdmin())) return respond(event, { code: -403, message: '仅管理员可查看账号列表' })
      let rows = []
      try {
        const r = await db.from('zx_admin_accounts').select('username,builtin,note,created_at').limit(100)
        rows = (r.data || []).map(function (a) {
          return { username: a.username, builtin: !!a.builtin, note: a.note || '', deletable: !a.builtin }
        })
      } catch (e) {}
      return respond(event, { code: 0, accounts: rows })
    }

    return respond(event, { code: -9, message: '未知动作：' + action })
  } catch (e) {
    return respond(event, { code: -1, message: (e && e.message) || String(e) })
  }
}
