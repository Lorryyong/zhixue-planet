const store = require('../../utils/store.js')
Page({
  data: {},
  onShow() { this.refresh() },
  refresh() {
    const s = store.getState()
    this.setData({
      papers: s.papers.map(p => Object.assign({}, p, {
        statusLabel: p.status === 'confirmed' ? '已确认' : (p.status === 'pending' ? '待校对' : '识别中'),
        statusClass: p.status === 'confirmed' ? 'g' : (p.status === 'pending' ? 'y' : 'r')
      })),
      confirmedCount: s.papers.filter(p => p.status === 'confirmed').length
    })
  },
  chooseFile() {
    wx.chooseMessageFile({
      count: 1, type: 'file',
      success: () => this.simulate(),
      fail: () => {}
    })
  },
  loadSample() { this.simulate() },
  simulate() {
    wx.showLoading({ title: 'AI 识别中…' })
    setTimeout(() => {
      wx.hideLoading()
      store.loadSamplePaper(store.getState())
      wx.navigateTo({ url: '/pages/check/check' })
    }, 1300)
  },
  onPaper(e) {
    if (e.currentTarget.dataset.status === 'pending') wx.navigateTo({ url: '/pages/check/check' })
    else wx.showToast({ title: '已入库试卷', icon: 'none' })
  }
})