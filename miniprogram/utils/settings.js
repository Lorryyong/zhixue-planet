/**
 * 用户设置数据层：家长绑定/周报、学科教材、补签卡、隐私设置
 *
 * 【存储策略：本地优先】
 * - 本地 Storage 是权威持久化源：写入即时、读取即时，演示身份/离线同样可靠。
 * - 云端 zx_users.settings 仅作 best-effort 跨设备同步；
 *   云端的空默认值(defaultSettings)绝不覆盖本地已保存的设置 —— 这修复了
 *   "演示身份下每次进入都被云端空设置清空"导致设置记不住的问题。
 */
const cloud = require('./cloud.js')

const CACHE_KEY = 'zx_settings_v1'

function defaults() {
  return {
    parent: { bound: false, guardian: '', relation: '妈妈', phone: '', weekly: false, weeklyDay: '周日', boundAt: '' },
    subjects: [],
    makeup: { cards: 3, used: [], active: null },
    privacy: { minorMode: false, allowAnalytics: false, allowPersonalization: true, updatedAt: '' },
    checkin: { dailyGoal: 10, wrongRatio: 50, reviewPlan: 'standard', updatedAt: '' }
  }
}
function normalize(s) {
  const d = defaults()
  if (!s || typeof s !== 'object') return d
  return {
    parent: Object.assign({}, d.parent, (s.parent && typeof s.parent === 'object') ? s.parent : {}),
    subjects: Array.isArray(s.subjects) ? s.subjects : [],
    makeup: Object.assign({}, d.makeup, (s.makeup && typeof s.makeup === 'object') ? s.makeup : {}),
    privacy: Object.assign({}, d.privacy, (s.privacy && typeof s.privacy === 'object') ? s.privacy : {}),
    checkin: Object.assign({}, d.checkin, (s.checkin && typeof s.checkin === 'object') ? s.checkin : {})
  }
}

/** 读本地缓存（同步，供页面首帧渲染） */
function cached() {
  try { return normalize(wx.getStorageSync(CACHE_KEY)) } catch (e) { return defaults() }
}
function saveCache(s) { try { wx.setStorageSync(CACHE_KEY, normalize(s)) } catch (e) {} }

/** 是否处于"全新未设置"状态（用于判断新设备是否需要从云端恢复） */
function isPristine(s) {
  try { return JSON.stringify(normalize(s)) === JSON.stringify(defaults()) } catch (e) { return false }
}

/**
 * 读取设置：本地优先，立即返回。
 * - 本地已有设置 → 立即用本地渲染，云端仅后台 best-effort 刷新（且只在本地变回全新时恢复）。
 * - 本地全新（新设备） → 等待云端一次（3 秒超时兜底），有数据则恢复，否则用本地默认。
 * 无论哪种情况，云端空值都不会覆盖本地已保存的数据。
 */
function load() {
  const local = cached()
  if (!cloud.isCloudReady()) return Promise.resolve(local)

  const pull = () => cloud.call('login', { action: 'getSettings' })
    .then(r => {
      if (r && r.code === 0 && r.settings) return normalize(r.settings)
      return null
    })
    .catch(() => null)

  // 本地已有数据：立即返回本地，后台仅在新设备场景恢复
  if (!isPristine(local)) {
    pull().then(remote => {
      if (remote && !isPristine(remote) && isPristine(cached())) saveCache(remote)
    })
    return Promise.resolve(local)
  }

  // 本地全新：等待云端恢复（带超时兜底）
  return new Promise(resolve => {
    let done = false
    const finish = v => { if (!done) { done = true; resolve(v) } }
    const timer = setTimeout(() => finish(local), 3000)
    pull().then(remote => {
      clearTimeout(timer)
      if (remote && !isPristine(remote)) { saveCache(remote); finish(remote); return }
      finish(local)
    })
  })
}

/**
 * 分片更新设置（顶层键之一：parent / subjects / makeup / privacy / checkin）
 * 立即写本地（权威），云端 best-effort 同步；云端返回值不覆盖本地，保证设置一定记住。
 */
function update(section, value) {
  const KEYS = ['parent', 'subjects', 'makeup', 'privacy', 'checkin']
  const local = cached()
  if (KEYS.indexOf(section) < 0) return Promise.resolve(local)
  local[section] = value
  saveCache(local)
  if (!cloud.isCloudReady()) return Promise.resolve(local)
  const patch = {}; patch[section] = value
  return cloud.call('login', { action: 'updateSettings', settings: patch })
    .then(() => local)      // 不用云端返回覆盖本地（本地已是最新）
    .catch(() => local)     // 云端失败也不影响本地持久化
}

/**
 * 开始补签：锁定漏打卡的一天，暂不扣卡；需完成该日答题后才真正补签（见 applyMakeupResult）。
 * 返回 {code, date, needQuiz:true, cards, ...}
 */
function makeupCheckin(date) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date) : ''
  if (!d) return Promise.resolve({ code: -2, message: '补签日期无效' })
  if (!cloud.isCloudReady()) {
    // 本地降级：锁定待补签日，不扣卡
    const s = cached()
    const cards = Number(s.makeup.cards) || 0
    if (cards <= 0) return Promise.resolve({ code: -3, message: '补签卡不足' })
    s.makeup.active = { date: d, at: new Date().toISOString(), status: 'pending' }
    saveCache(s)
    return Promise.resolve({ code: 0, date: d, needQuiz: true, cards, local: true })
  }
  return cloud.call('login', { action: 'makeupCheckin', date: d }).then(r => {
    if (r && r.code === 0) {
      const s = cached()
      s.makeup.active = { date: d, at: new Date().toISOString(), status: 'pending' }
      saveCache(s)
    }
    return r
  }).catch(e => ({ code: -1, message: (e && e.message) || '补签失败' }))
}

/** 取消补签：放弃当前待完成的补签（未答题前不扣卡） */
function cancelMakeup() {
  const s = cached()
  s.makeup.active = null
  saveCache(s)
  if (!cloud.isCloudReady()) return Promise.resolve({ code: 0 })
  return cloud.call('login', { action: 'cancelMakeup' }).catch(() => ({ code: 0 }))
}

/** 补签答题完成后，用云端结算结果同步本地卡数/已用记录，清除 active */
function applyMakeupResult(result) {
  if (!result || !result.date) return
  const s = cached()
  s.makeup.cards = Number(result.cards)
  s.makeup.used = (s.makeup.used || []).concat([{ date: result.date, at: new Date().toISOString(), status: 'done' }]).slice(-100)
  if (s.makeup.active && s.makeup.active.date === result.date) s.makeup.active = null
  saveCache(s)
}

module.exports = { defaults, normalize, cached, saveCache, load, update, makeupCheckin, cancelMakeup, applyMakeupResult, isPristine, CACHE_KEY }
