/**
 * 用户登录 · 身份管理（微信云调用版）
 *
 * - 启动时 ensureStudentId()：
 *     1) 先读本地缓存的 studentId（有就直接用，秒开）
 *     2) 没有则调 login 云函数；微信运行时注入真实 openid，云端建档+克隆种子题
 *     3) 登录失败（云函数未部署/未绑定环境）→ 用本地匿名 ID 兜底，保证本地 Demo 可跑
 * - 全程不抛错：任何异常都返回可用的 studentId。
 *
 * 【安全】前端不再传任何身份字段给云函数；studentId 仅用于本地缓存展示，
 *         云端一律以微信注入的 openid 为准，前端伪造无效。
 * 本地缓存 key 见 STORAGE_KEY。真机登录后为真实 openid（跨设备一致）。
 */
const cloud = require('./cloud.js')
const store = require('./store.js')

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
    const fallback = () => {
      const id = randId()
      saveId(id, 'anonymous')
      resolve(id)
    }
    if (!cloud.isCloudReady()) { fallback(); return }
    cloud.call('login', {})
      .then(r => {
        const id = (r && r.studentId)
        if (!id) { fallback(); return }
        saveId(id, (r && r.authMode) || 'openid')
        // 用云端养成快照恢复本地（换设备数据一致）
        if (r.gamification) {
          try { store.applyCloudGamification(store.getState(), r.gamification) } catch (e) {}
        }
        resolve(id)
      })
      .catch(() => fallback())
  })

  // 登录完成后清空，允许后续主动刷新
  resolving.then(() => { resolving = null })
  return resolving
}

/** 强制重新登录 */
function refresh() {
  try { wx.removeStorageSync(STORAGE_KEY) } catch (e) {}
  return ensureStudentId()
}

function getCachedMode() {
  try { return wx.getStorageSync(MODE_KEY) || '' } catch (e) { return '' }
}

module.exports = { ensureStudentId, refresh, getCachedMode, STORAGE_KEY }
