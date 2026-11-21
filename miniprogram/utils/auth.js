/**
 * 用户登录 · 身份管理
 *
 * - 启动时 ensureStudentId()：
 *     1) 先读本地缓存的 studentId（有就直接用，秒开）
 *     2) 没有则 wx.login 拿 code → 调 login 云函数换真实 openid
 *     3) 云函数未配 AppSecret / 登录失败 → 用本地匿名 ID（clientId）兜底
 * - 全程不抛错：任何异常都返回可用的 studentId，保证闭环可跑。
 *
 * 本地缓存 key 见 STORAGE_KEY。换设备后匿名 ID 会变（数据不互通），
 * 配好 AppSecret 后为真实 openid（跨设备一致）。
 */
const cloud = require('./cloud.js')

const STORAGE_KEY = 'zx_student_id'
const MODE_KEY = 'zx_auth_mode'

function randId() {
  return 'anon_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

function cachedId() {
  try { return wx.getStorageSync(STORAGE_KEY) || '' } catch (e) { return '' }
}
function saveId(id, mode) {
  try {
    wx.setStorageSync(STORAGE_KEY, id)
    wx.setStorageSync(MODE_KEY, mode || 'anonymous')
  } catch (e) { /* 忽略 */ }
}

let resolving = null

/** 确保拿到 studentId，返回 Promise<string>。并发调用共享同一个登录流程。 */
function ensureStudentId() {
  const cached = cachedId()
  if (cached) return Promise.resolve(cached)
  if (resolving) return resolving

  resolving = new Promise(resolve => {
    let clientId = ''
    try {
      clientId = wx.getStorageSync('zx_client_id') || ''
      if (!clientId) { clientId = randId(); wx.setStorageSync('zx_client_id', clientId) }
    } catch (e) { clientId = randId() }

    const doLogin = (code) => {
      cloud.call('login', { code, clientId })
        .then(r => {
          const id = (r && r.studentId) || clientId
          saveId(id, (r && r.authMode) || 'anonymous')
          resolve(id)
        })
        .catch(() => {
          // 云端登录不可用：用匿名 ID 兜底，先保证闭环
          saveId(clientId, 'anonymous')
          resolve(clientId)
        })
    }

    // 先尝试 wx.login 拿 code；失败也要用匿名 ID 调一次 login（触发建档+种子题克隆）
    try {
      if (wx.login) {
        wx.login({
          success: res => doLogin(res && res.code ? res.code : ''),
          fail: () => doLogin('')
        })
      } else {
        doLogin('')
      }
    } catch (e) { doLogin('') }
  })

  // 登录完成后清空，允许后续主动刷新
  resolving.then(() => { resolving = null })
  return resolving
}

/** 强制重新登录（如从匿名升级到 openid） */
function refresh() {
  try { wx.removeStorageSync(STORAGE_KEY) } catch (e) {}
  return ensureStudentId()
}

function getCachedMode() {
  try { return wx.getStorageSync(MODE_KEY) || '' } catch (e) { return '' }
}

module.exports = { ensureStudentId, refresh, getCachedMode, STORAGE_KEY }
