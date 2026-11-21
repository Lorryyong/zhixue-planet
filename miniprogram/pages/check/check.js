const store = require('../../utils/store.js')
Page({
  data: {},
  onShow() { this.refresh() },
  refresh() {
    const s = store.getState()
    const paper = s.papers.find(p => p.id === s.pendingPaperId)
    this.setData({
      qs: s.pendingQuestions.map((q, i) => Object.assign({}, q, {
        no: i + 1,
        optText: q.options.map((o, j) => String.fromCharCode(65 + j) + '. ' + o),
        tagNames: q.tags.map(t => store.kName(t)),
        confLabel: q.confidence >= 0.9 ? '识别可信' : '需确认',
        confClass: q.confidence >= 0.9 ? 'g' : 'y'
      })),
      paperTitle: paper ? paper.title : '',
      confirmedCount: s.pendingQuestions.filter(q => q.confirmed).length
    })
  },
  confirmQ(e) {
    store.confirmQ(store.getState(), e.currentTarget.dataset.id)
    this.refresh()
    wx.showToast({ title: '已确认', icon: 'none' })
  },
  editTip() { wx.showToast({ title: 'Demo：可接入编辑弹窗', icon: 'none' }) },
  confirmAll() {
    const n = store.confirmAll(store.getState())
    wx.showToast({ title: '已入库 ' + n + ' 道题', icon: 'success' })
    setTimeout(() => wx.navigateBack(), 900)
  },
  goPapers() { wx.switchTab({ url: '/pages/papers/papers' }) }
})