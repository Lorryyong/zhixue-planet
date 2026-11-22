const store = require('../../utils/store.js')
const cloud = require('../../utils/cloud.js')
const auth = require('../../utils/auth.js')

Page({
  data: {
    energy: 0, level: 1, streak: 0,
    stageName: '', stageEmoji: '', stageNext: '', energyPct: 0,
    rules: store.ENERGY_RULES,
    path: [],
    ledger: []
  },
  onShow() { this.refresh() },
  refresh() {
    const s = store.getState()
    const g = s.gamification || {}
    const stage = store.planetStage(g.energy || 0)
    // 晋级路线：标记当前阶段与进度
    const path = store.PLANET_PATH.map((p, i) => {
      const reached = (g.energy || 0) >= p.min
      const next = store.PLANET_PATH[i + 1]
      return Object.assign({}, p, {
        reached,
        current: reached && (!next || (g.energy || 0) < next.min),
        progress: next ? Math.min(100, Math.round(((g.energy || 0) - p.min) / (next.min - p.min) * 100)) : 100
      })
    })
    this.setData({
      energy: g.energy || 0, level: g.level || 1, streak: g.streak || 0,
      stageName: stage.name, stageEmoji: stage.emoji, stageNext: stage.next,
      energyPct: Math.min(100, Math.round((g.energy || 0) / 1500 * 100)),
      path,
      ledger: (g.energyLedger || []).slice().reverse().slice(0, 30)
    })
    // 云端账本同步
    if (cloud.isCloudReady()) {
      auth.ensureStudentId().then(() => cloud.call('login', {})).then(r => {
        if (r && r.gamification) store.applyCloudGamification(store.getState(), r.gamification)
        if (r && r.energyLedger && r.energyLedger.length) {
          this.setData({ ledger: r.energyLedger.slice().reverse().slice(0, 30) })
        }
      }).catch(() => {})
    }
  },
  goPlanet() { wx.switchTab({ url: '/pages/planet/planet' }) }
})
