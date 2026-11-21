const store = require('../../utils/store.js')
Page({
  data: {},
  onShow() { this.refresh() },
  refresh() {
    const s = store.getState()
    this.setData({ level: s.gamification.level, dayLabel: store.dateStr(store.offsetNow()) })
  },
  advanceDay() {
    store.advanceDay(store.getState())
    this.refresh()
    wx.showToast({ title: '已进入下一天，重刷排期已更新', icon: 'none' })
  },
  goRadar() { wx.navigateTo({ url: '/pages/radar/radar' }) },
  resetData() {
    wx.showModal({
      title: '重置数据', content: '将清空本地 Demo 数据并恢复初始状态，确定吗？',
      success: (res) => {
        if (res.confirm) { store.resetState(); this.refresh(); wx.showToast({ title: '已重置', icon: 'success' }) }
      }
    })
  }
})