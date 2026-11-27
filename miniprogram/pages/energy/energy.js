const store = require('../../utils/store.js')
const settings = require('../../utils/settings.js')
const cloud = require('../../utils/cloud.js')
const auth = require('../../utils/auth.js')

Page({
  data: {
    energy: 0, cards: 0,
    ledger: [],
    recentDays: [],
    activeDate: '',
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
    const mk = settings.cached().makeup || {}
    const used = (mk.used || []).map(u => u.date)
    const active = mk.active && mk.active.status === 'pending' ? mk.active.date : ''
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
        active: active === ds,
        future: false
      })
    }
    this.setData({ recentDays: days, activeDate: active })
  },
  onMakeup(e) {
    const date = e.currentTarget.dataset.date
    const day = this.data.recentDays.find(d => d.date === date)
    if (day && day.on) { wx.showToast({ title: '该日已打卡', icon: 'none' }); return }
    // 已有未完成补签：引导先完成或取消
    const active = (settings.cached().makeup || {}).active
    if (active && active.status === 'pending') {
      if (active.date === date) {
        this.goMakeupQuiz(date)
      } else {
        wx.showModal({
          title: '有未完成的补签', content: '你还有 ' + active.date + ' 的补签尚未答题完成。可先完成它，或取消后补签 ' + date + '。',
          confirmText: '去完成', cancelText: '取消补签',
          success: (res) => { if (res.confirm) this.goMakeupQuiz(active.date); else this.cancelMakeup() }
        })
      }
      return
    }
    if (this.data.cards <= 0) { wx.showToast({ title: '补签卡不足', icon: 'none' }); return }
    wx.showModal({
      title: '补签 ' + date,
      content: '将锁定这一天完成补签。请在接下来完成该日的打卡题目，全部答完后自动消耗 1 张补签卡；未完成前不会扣卡。',
      confirmText: '开始补签', cancelText: '再想想',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ makeupLoading: true })
        settings.makeupCheckin(date).then(r => {
          this.setData({ makeupLoading: false })
          if (r && r.code === 0) {
            this.goMakeupQuiz(date)
          } else {
            wx.showToast({ title: (r && r.message) || '补签失败', icon: 'none' })
          }
        })
      }
    })
  },
  // 跳转答题页，携带补签日期（quiz 页据此为该日组卷）
  goMakeupQuiz(e) {
    const date = (typeof e === 'string') ? e : ((e && e.currentTarget && e.currentTarget.dataset.date) || this.data.activeDate)
    if (!date) return
    wx.navigateTo({ url: '/pages/quiz/quiz?makeupDate=' + date })
  },
  cancelMakeup() {
    settings.cancelMakeup().then(() => {
      wx.showToast({ title: '已取消补签', icon: 'success' })
      this.refresh()
    })
  }
})
