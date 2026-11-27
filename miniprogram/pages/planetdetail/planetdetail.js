/**
 * 星球档案：单个等级星球的详细介绍页
 * 从探索页场景图、地图详情卡点击进入；含科普数据、专属装扮（可直接购买）。
 */
const store = require('../../utils/store.js')
const cloud = require('../../utils/cloud.js')
const auth = require('../../utils/auth.js')
const fd = require('../../utils/farmData.js')
const sl = require('../../utils/spaceLevels.js')

Page({
  data: {
    L: null,              // 等级配置（含 facts / detail）
    state: '',            // 已解锁 / 当前坐标 / 未解锁
    need: '',
    sign: null,           // 专属装扮（含 owned / locked / btn）
    energy: 0,
    sceneOk: true,
    buying: false
  },

  onLoad(options) {
    const level = Math.min(12, Math.max(1, Number(options.level) || 1))
    this._level = level
    this.setData({ L: sl.LEVELS[level - 1] })
  },

  onShow() {
    this.syncState()
    this.loadSign()
  },

  syncState() {
    const s = store.getState()
    const g = s.gamification || {}
    const total = Number(g.totalEarned || 0)
    const cur = sl.levelOf(total).level
    this._cur = cur
    const L = sl.LEVELS[this._level - 1]
    const state = L.level < cur ? '已解锁' : (L.level === cur ? '当前坐标' : '未解锁')
    const need = L.level > cur ? ('累计星能量达到 ' + L.min + ' 解锁 · 你还差 ' + Math.max(0, L.min - total)) : ('解锁门槛：累计星能量 ' + L.min)
    this.setData({ state, need, energy: Number(g.energy || 0) })
  },

  loadSign() {
    const apply = (ownedIds, energy) => {
      const g = fd.signOfLevel(this._level)
      if (!g) { this.setData({ sign: null }); return }
      const owned = ownedIds.indexOf(g.id) >= 0
      const locked = this._level > (this._cur || 1)
      this.setData({
        sign: Object.assign({}, g, {
          owned, locked,
          btn: owned ? '已拥有 · 展示中' : (locked ? ('Lv.' + this._level + ' 解锁后可购') : (g.price + ' ⚡ 兑换'))
        }),
        energy: typeof energy === 'number' ? energy : this.data.energy
      })
    }
    if (cloud.isCloudReady()) {
      auth.ensureStudentId().then(() => cloud.call('farm', { action: 'getPlanet' })).then(r => {
        apply((r.planet && r.planet.ownedIds) || [], r.energy)
      }).catch(() => this.loadLocalSign(apply))
    } else {
      this.loadLocalSign(apply)
    }
  },

  loadLocalSign(apply) {
    const farms = store.getFarms()
    const pf = farms['星球'] || {}
    apply(pf.decorIds || [])
  },

  onSceneError() { this.setData({ sceneOk: false }) },

  onBuySign() {
    const sign = this.data.sign
    if (!sign || sign.owned || this.data.buying) return
    if (sign.locked) { wx.showToast({ title: '先解锁这颗星球才能装扮它', icon: 'none' }); return }
    this.setData({ buying: true })
    const finish = (ok, msg, energy) => {
      this.setData({ buying: false })
      wx.showToast({ title: msg, icon: ok ? 'success' : 'none' })
      if (ok) {
        if (typeof energy === 'number') this.setData({ energy })
        this.loadSign()
      }
    }
    if (cloud.isCloudReady()) {
      auth.ensureStudentId().then(() => cloud.call('farm', { action: 'buySpaceItem', itemId: sign.id })).then(r => {
        finish(true, '装扮成功！', r.energy)
      }).catch(err => {
        const m = (err && err.message) || '兑换失败，请重试'
        finish(false, m.length > 24 ? m.slice(0, 24) : m)
      })
    } else {
      const r = store.localFarmSpend(sign.price, '星球装扮·' + sign.name)
      if (!r.ok) { finish(false, '星能量不足，还差 ' + r.need + ' ⚡'); return }
      const pf = store.ensureLocalFarm('星球')
      pf.decorIds = (pf.decorIds || []).concat([sign.id])
      const farms = store.getFarms(); farms['星球'] = pf; store.saveFarms(farms)
      const s = store.getState()
      finish(true, '装扮成功！', s.gamification.energy)
    }
  }
})
