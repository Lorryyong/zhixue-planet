const store = require('../../utils/store.js')
Page({
  data: {},
  onShow() { this.refresh() },
  refresh() {
    const s = store.getState()
    const g = s.gamification
    const stage = store.planetStage(g.energy)
    const days = ['日', '一', '二', '三', '四', '五', '六']
    const today = store.dateStr(store.offsetNow())
    const now = new Date(today + 'T00:00:00')
    const dow = now.getDay()
    const week = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(now); d.setDate(d.getDate() - dow + i)
      const ds = store.dateStr(d)
      week.push({ s: ds, label: days[i], on: g.checkinDates.indexOf(ds) >= 0 || (i === 0 && g.streak > 0), today: ds === today })
    }
    this.setData({ stageEmoji: stage.emoji, stageName: stage.name, energy: g.energy, level: g.level, streak: g.streak, week })
  },
  goPoints() { wx.navigateTo({ url: '/pages/points/points' }) }
})