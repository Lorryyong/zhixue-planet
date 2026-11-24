/**
 * 云函数 adminAuth —— 管理端鉴权（v1.9.12）
 *
 * 内置管理员账号存于 zx_admin_accounts（builtin=true 不可删除；口令已于 2026-11-24 轮换，
 * 存储格式为加盐 scrypt，见迁移 20261124101000_rotate_admin_password.sql，口令本身不写在代码/仓库里）。
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

/** 口令校验：优先 scrypt$<saltHex>$<hashHex>（加盐慢哈希，恒定时间比较）；
 *  兼容历史 sha256 十六进制（轮换迁移应用后库中不再有此格式）。 */
function verifyPassword(password, stored) {
  const s = String(stored || '')
  if (s.indexOf('scrypt$') === 0) {
    const parts = s.split('$')
    if (parts.length !== 3) return false
    try {
      const salt = Buffer.from(parts[1], 'hex')
      const expected = Buffer.from(parts[2], 'hex')
      if (!salt.length || !expected.length) return false
      const actual = crypto.scryptSync(String(password || ''), salt, expected.length)
      return crypto.timingSafeEqual(actual, expected)
    } catch (e) { return false }
  }
  const a = Buffer.from(sha256(password), 'utf8')
  const b = Buffer.from(s, 'utf8')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** 登录防爆破：连续失败达阈值锁定一段时间（计数存 zx_admin_accounts.fail_count/locked_until，
 *  由迁移 20261124101000 添加；列不存在时更新失败被忽略，锁定不生效但不阻断登录）。 */
const LOGIN_MAX_FAILS = 5
const LOGIN_LOCK_MINUTES = 15

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
      // 锁定中直接拒绝（不泄露账号是否存在之外的信息）
      if (acc.locked_until && new Date(acc.locked_until).getTime() > Date.now()) {
        const mins = Math.max(1, Math.ceil((new Date(acc.locked_until).getTime() - Date.now()) / 60000))
        return respond(event, { code: -3, message: '登录失败次数过多，账号已锁定，请 ' + mins + ' 分钟后再试' })
      }
      if (!verifyPassword(password, acc.password_hash)) {
        // 记录失败并按阈值锁定（列未迁移时静默跳过）
        try {
          const fails = (Number(acc.fail_count) || 0) + 1
          const patch = { fail_count: fails }
          if (fails >= LOGIN_MAX_FAILS) {
            patch.fail_count = 0
            patch.locked_until = new Date(Date.now() + LOGIN_LOCK_MINUTES * 60000).toISOString()
          }
          await db.from('zx_admin_accounts').update(patch).eq('username', username)
        } catch (e) { /* fail_count/locked_until 列不存在时忽略 */ }
        return respond(event, { code: -2, message: '账号或密码不正确' })
      }
      // 登录成功：清零失败计数
      try {
        await db.from('zx_admin_accounts').update({ fail_count: 0, locked_until: null }).eq('username', username)
      } catch (e) { /* 同上 */ }

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
