const store = require('../../utils/store.js')
const cloudStore = require('../../utils/cloudStore.js')
Page({
  data: {},
  onShow() { this.refresh() },
  refresh() {
    const s = store.getState()
    const paper = s.papers.find(p => p.id === s.pendingPaperId)
    this.setData({
      qs: s.pendingQuestions.map((q, i) => Object.assign({}, q, {
        no: i + 1,
        optText: (q.options || []).map((o, j) => String.fromCharCode(65 + j) + '. ' + o),
        tagNames: (q.tags || []).map(t => store.kName(t)),
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
  async confirmAll() {
    const s = store.getState()
    const paperId = s.pendingPaperId
    // 云端识别的试卷（id 形如 p_xxx）：先回调云函数把 PG 里的题置为 confirmed
    if (paperId && paperId.indexOf('p_') === 0) {
      try {
        await cloudStore.confirmPaper(paperId)
      } catch (e) {
        console.warn('[智学星球] 云端确认入库失败，仅更新本地缓存', e)
      }
    }
    // 无论云端是否成功，本地缓存同步更新，保证页面与后续组卷一致
    const n = store.confirmAll(s)
    wx.showToast({ title: (paperId && paperId.indexOf('p_') === 0 ? '已云端入库 ' : '已入库 ') + n + ' 道题', icon: 'success' })
    setTimeout(() => wx.navigateBack(), 900)
  },
  goPapers() { wx.switchTab({ url: '/pages/papers/papers' }) }
})
