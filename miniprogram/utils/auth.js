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
const PROFILE_KEY = 'zx_profile'

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
    const CLOUD_RESET_FLAG = 'zx_cloud_energy_reset_v193'
    cloud.call('login', {})
      .then(r => {
        const id = (r && r.studentId)
        if (!id) { fallback(); return }
        const mode = (r && r.authMode) || 'openid'
        saveId(id, mode)
        // 缓存用户资料（昵称/头像/角色），供"我"页与首次引导使用
        if (r && r.profile) saveProfile(r.profile)
        // 是否已完成资料设置（昵称+头像），用于首次登录引导
        if (r && typeof r.needProfileSetup === 'boolean') {
          try { wx.setStorageSync('zx_profile_need_setup', r.needProfileSetup) } catch (e) {}
        }
        const applyG = g => {
          if (!g) return
          try { store.applyCloudGamification(store.getState(), g) } catch (e) {}
        }
        const withLedger = g => Object.assign({}, g, { energyLedger: (r && r.energyLedger) || [] })
        // 能量重置：真实身份且未重置过 → 云端清零一次（从今天答题起算），之后不再重置
        let needReset = false
        try { needReset = (mode === 'openid') && !wx.getStorageSync(CLOUD_RESET_FLAG) } catch (e) { needReset = (mode === 'openid') }
        if (needReset) {
          cloud.call('login', { action: 'resetEnergy' })
            .then(rr => {
              try { wx.setStorageSync(CLOUD_RESET_FLAG, true) } catch (e) {}
              if (rr && rr.code === 0 && rr.gamification) applyG(rr.gamification)
              else if (r.gamification) applyG(withLedger(r.gamification))
            })
            .catch(() => { if (r.gamification) applyG(withLedger(r.gamification)) })
            .then(() => resolve(id))
        } else {
          // 用云端养成快照恢复本地（换设备数据一致）
          if (r.gamification) applyG(withLedger(r.gamification))
          resolve(id)
        }
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

/** 读取本地缓存的用户资料 */
function getProfile() {
  try { return wx.getStorageSync(PROFILE_KEY) || null } catch (e) { return null }
}
/** 缓存用户资料 */
function saveProfile(profile) {
  try { wx.setStorageSync(PROFILE_KEY, profile || null) } catch (e) { /* 忽略 */ }
}
/** 是否需要引导设置头像昵称 */
function needProfileSetup() {
  try { return !!wx.getStorageSync('zx_profile_need_setup') } catch (e) { return false }
}
/** 标记资料已设置完成 */
function markProfileDone() {
  try { wx.setStorageSync('zx_profile_need_setup', false) } catch (e) { /* 忽略 */ }
}

/**
 * 更新用户资料到云端（昵称/头像），成功后同步本地缓存。
 * @param {{nickname?:string, avatar?:string}} patch
 */
function updateProfile(patch) {
  return cloud.call('login', Object.assign({ action: 'updateProfile' }, patch || {}))
    .then(r => {
      if (r && r.profile) saveProfile(r.profile)
      markProfileDone()
      return r
    })
}

/** 从云端重新拉取资料并缓存 */
function syncProfile() {
  return cloud.call('login', { action: 'getProfile' }).then(r => {
    if (r && r.profile) saveProfile(r.profile)
    return r && r.profile
  })
}

module.exports = {
  ensureStudentId, refresh, getCachedMode, getProfile, saveProfile,
  needProfileSetup, markProfileDone, updateProfile, syncProfile, STORAGE_KEY, PROFILE_KEY
}
