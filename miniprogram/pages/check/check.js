const store = require('../../utils/store.js')
const cloudStore = require('../../utils/cloudStore.js')
Page({
  data: {
    editing: false, editId: '',
    eStem: '', eOptions: ['', '', '', ''], eAnswer: 0,
    eAnalysis: '', eTags: ''
  },
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
  // 打开编辑弹窗，带入当前题目字段
  editTip(e) {
    const id = e.currentTarget.dataset.id
    const q = store.getState().pendingQuestions.find(x => x.id === id)
    if (!q) return
    const opts = (q.options || []).slice(0, 4)
    while (opts.length < 4) opts.push('')
    this.setData({
      editing: true, editId: id,
      eStem: q.stem || '',
      eOptions: opts,
      eAnswer: typeof q.answer === 'number' ? q.answer : 0,
      eAnalysis: q.analysis || '',
      eTags: (q.tags || q.knowledge_tags || []).join(',')
    })
  },
  closeEdit() { this.setData({ editing: false }) },
  onStem(e) { this.setData({ eStem: e.detail.value }) },
  onOption(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const opts = this.data.eOptions.slice()
    opts[idx] = e.detail.value
    this.setData({ eOptions: opts })
  },
  onAnswer(e) { this.setData({ eAnswer: Number(e.currentTarget.dataset.idx) }) },
  onAnalysis(e) { this.setData({ eAnalysis: e.detail.value }) },
  onTags(e) { this.setData({ eTags: e.detail.value }) },
  // 保存：先更新本地，再异步写云端（失败不阻塞）
  async saveEdit() {
    const d = this.data
    if (!d.eStem.trim()) { wx.showToast({ title: '题干不能为空', icon: 'none' }); return }
    const tags = d.eTags.split(/[,，]/).map(x => x.trim()).filter(Boolean)
    const patch = {
      stem: d.eStem.trim(),
      options: d.eOptions.map(x => String(x).trim()),
      answer: d.eAnswer,
      analysis: d.eAnalysis.trim(),
      knowledge_tags: tags, tags
    }
    store.editPendingQ(store.getState(), d.editId, patch)
    this.setData({ editing: false })
    this.refresh()
    wx.showLoading({ title: '保存中…' })
    try {
      await cloudStore.updateQuestion(d.editId, patch)
      wx.hideLoading()
      wx.showToast({ title: '已保存并同步云端', icon: 'success' })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '本地已改，云端同步失败', icon: 'none' })
    }
  },
  async confirmAll() {
    const s = store.getState()
    const paperId = s.pendingPaperId
    if (paperId && paperId.indexOf('p_') === 0) {
      try {
        await cloudStore.confirmPaper(paperId)
      } catch (e) {
        console.warn('[智学星球] 云端确认入库失败，仅更新本地缓存', e)
      }
    }
    const n = store.confirmAll(s)
    wx.showToast({ title: (paperId && paperId.indexOf('p_') === 0 ? '已云端入库 ' : '已入库 ') + n + ' 道题', icon: 'success' })
    setTimeout(() => wx.navigateBack(), 900)
  },
  goPapers() { wx.switchTab({ url: '/pages/papers/papers' }) }
})
