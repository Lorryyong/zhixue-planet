const store = require('../../utils/store.js')
const settings = require('../../utils/settings.js')
const cloud = require('../../utils/cloud.js')
const auth = require('../../utils/auth.js')

Page({
  data: {
    energy: 0, cards: 0,
    ledger: [],
    recentDays: [],
    makeupLoading: false
  },
  onShow() { this.refresh() },
  refresh() {
    const s = store.getState()
    const g = s.gamification || {}
    const st = settings.cached()
    this.setData({
      energy: g.energy || 0,
      cards: Number(st.makeup && st.makeup.cards) || 0,
      ledger: (g.energyLedger || []).slice().reverse().slice(0, 50)
    })
    this.buildDays()
    // 云端同步最新能量账本与设置（含签到日期，修复「已打卡显示未打卡」）
    if (cloud.isCloudReady()) {
      auth.syncGamification().then(g => {
        if (g) {
          this.setData({
            energy: g.energy || 0,
            ledger: ((g.energyLedger || []).slice()).reverse().slice(0, 50)
          })
          this.buildDays()
        }
      }).catch(() => {})
      settings.load().then(() => {
        this.setData({ cards: Number(settings.cached().makeup.cards) || 0 })
      }).catch(() => {})
    }
  },
  // 最近 7 天，标记已打卡/可补签
  buildDays() {
    const s = store.getState()
    const g = s.gamification || {}
    const dates = g.checkinDates || []
    const used = ((settings.cached().makeup || {}).used || []).map(u => u.date)
    const today = new Date()
    const days = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i)
      const ds = store.dateStr(d)
      days.push({
        date: ds,
        label: i === 0 ? '今天' : ['周日','周一','周二','周三','周四','周五','周六'][d.getDay()],
        dayNum: d.getDate(),
        on: dates.indexOf(ds) >= 0,
        madeup: used.indexOf(ds) >= 0,
        future: false
      })
    }
    this.setData({ recentDays: days })
  },
  onMakeup(e) {
    const date = e.currentTarget.dataset.date
    const day = this.data.recentDays.find(d => d.date === date)
    if (day && day.on) { wx.showToast({ title: '该日已打卡', icon: 'none' }); return }
    if (this.data.cards <= 0) { wx.showToast({ title: '补签卡不足', icon: 'none' }); return }
    wx.showModal({
      title: '确认补签', content: '使用 1 张补签卡补签 ' + date + ' 的打卡？',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ makeupLoading: true })
        settings.makeupCheckin(date).then(r => {
          this.setData({ makeupLoading: false })
          if (r && r.code === 0) {
            wx.showToast({ title: '补签成功', icon: 'success' })
            this.refresh()
          } else {
            wx.showToast({ title: (r && r.message) || '补签失败', icon: 'none' })
          }
        })
      }
    })
  }
})
