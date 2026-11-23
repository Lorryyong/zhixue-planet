const store = require('../../utils/store.js')
const cloudStore = require('../../utils/cloudStore.js')
const qt = require('../../utils/questionTypes.js')
const kbook = require('../../utils/knowledgeBook.js')
const track = require('../../utils/track.js')

Page({
  data: {
    qs: [], paperTitle: '', reEdit: false, confirmedCount: 0,
    // 编辑弹窗（v1.9.11 起由 question-editor 组件承载表单）
    editing: false, editQuestion: null, saving: false
  },
  onShow() { this.refresh() },
  refresh() {
    const s = store.getState()
    const paper = s.papers.find(p => p.id === s.pendingPaperId)
    this.setData({
      qs: s.pendingQuestions.map((q, i) => {
        const type = qt.normalizeType(q.q_type)
        const m = qt.meta(type)
        let answerText = qt.formatAnswer(q)
        return Object.assign({}, q, {
          no: i + 1, qTypeLabel: m.label,
          optText: (q.options || []).map((o, j) => String.fromCharCode(65 + j) + '. ' + o),
          answerText,
          pointsText: (q.scoring_points || []).map(p => p.point + '(' + (p.score || 0) + '分)').join('；'),
          tagNames: (q.tags || q.knowledge_tags || []).map(t => store.kName(t)),
          kpList: this._kpList(q),
          issuesText: (q.issues || []).join('；'),
          needFix: !!q.needFix,
          confLabel: q.confirmed ? '已确认' : '待确认',
          confClass: q.confirmed ? 'g' : 'y'
        })
      }),
      paperTitle: paper ? paper.title : '',
      reEdit: !!(paper && paper.status === 'confirmed'),
      confirmedCount: s.pendingQuestions.filter(q => q.confirmed).length
    })
  },
  // 结构化知识点 → 展示行
  _kpList(q) {
    let kps = q.knowledge_points
    if (!Array.isArray(kps) || !kps.length) {
      kps = kbook.buildKnowledgePoints(q.tags || q.knowledge_tags || [], null, q.subject, q.grade)
    }
    return (kps || []).filter(k => k && k.name).map(k => {
      const book = k.book || kbook.inferBook(k.name, q.subject, q.grade)
      return {
        name: k.name,
        book: book,
        bookIndex: Math.max(0, kbook.BOOKS.indexOf(book)),
        inferred: !!k.inferred
      }
    })
  },
  confirmQ(e) {
    store.confirmQ(store.getState(), e.currentTarget.dataset.id)
    this.refresh()
    wx.showToast({ title: '已确认', icon: 'none' })
  },
  // ===== 编辑弹窗（v1.9.11：组件化）=====
  editTip(e) {
    const id = e.currentTarget.dataset.id
    const q = store.getState().pendingQuestions.find(x => x.id === id)
    if (!q) return
    this.setData({ editing: true, editQuestion: q, saving: false })
  },
  closeEdit() { this.setData({ editing: false, editQuestion: null, saving: false }) },
  // 组件构造好 patch 后落库：本地 + 云端（保留 check 原有权限链路）
  async onEditorSave(ev) {
    const patch = ev && ev.detail && ev.detail.patch
    const q = this.data.editQuestion
    if (!patch || !q) return
    this.setData({ saving: true })
    const full = Object.assign({}, patch, { needFix: false, issues: [] })
    store.editPendingQ(store.getState(), q.id, full)
    this.setData({ editing: false, editQuestion: null, saving: false })
    this.refresh()
    wx.showLoading({ title: '保存中…' })
    try {
      await cloudStore.updateQuestion(q.id, full)
      wx.hideLoading()
      wx.showToast({ title: '已保存并同步云端', icon: 'success' })
    } catch (e2) {
      wx.hideLoading()
      wx.showToast({ title: '本地已改，云端同步失败', icon: 'none' })
    }
  },
  async confirmAll() {
    const s = store.getState()
    const paperId = s.pendingPaperId
    const paper = s.papers.find(p => p.id === paperId)
    const reEdit = !!(paper && paper.status === 'confirmed') // 重编辑已入库试卷
    if (paperId && paperId.indexOf('p_') === 0) {
      try { await cloudStore.confirmPaper(paperId) }
      catch (e) { console.warn('[智学星球] 云端确认入库失败，仅更新本地缓存', e) }
    }
    const n = store.confirmAll(s)
    track.event('paper_confirmed', { count: n, source: reEdit ? 'reedit' : 'new' })
    const msg = reEdit ? '修改已保存' : ((paperId && paperId.indexOf('p_') === 0 ? '已云端入库 ' : '已入库 ') + n + ' 道题')
    wx.showToast({ title: msg, icon: 'success' })
    setTimeout(() => wx.navigateBack(), 900)
  },
  goPapers() { wx.switchTab({ url: '/pages/papers/papers' }) }
})
