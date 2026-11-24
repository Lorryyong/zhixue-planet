const store = require('../../utils/store.js')
const cloudStore = require('../../utils/cloudStore.js')
const cloud = require('../../utils/cloud.js')
const qt = require('../../utils/questionTypes.js')
const kbook = require('../../utils/knowledgeBook.js')
const track = require('../../utils/track.js')

Page({
  data: {
    qs: [], paperTitle: '', reEdit: false, confirmedCount: 0,
    // 编辑弹窗（v1.9.11 起由 question-editor 组件承载表单）
    editing: false, editQuestion: null, saving: false,
    // 入库提交中：显示等候动画并禁用按钮，防重复点击
    submitting: false
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
  // 删除本题：云端题目走云函数删除（权限在云端校验：本人上传或管理员）；
  // 云端没有此题（如本地示例题）时仅从本地列表移除
  deleteQ(e) {
    const id = e.currentTarget.dataset.id
    const q = store.getState().pendingQuestions.find(x => x.id === id)
    if (!q) return
    wx.showModal({
      title: '删除题目',
      content: '确定删除第 ' + (this.data.qs.find(x => x.id === id) || {}).no + ' 题吗？已入库的题目会从题库中永久删除，不可恢复。',
      confirmText: '删除', confirmColor: '#d92d20',
      success: async (res) => {
        if (!res.confirm) return
        const done = (msg) => {
          store.removePendingQuestion(store.getState(), id)
          this.refresh()
          wx.showToast({ title: msg, icon: 'success' })
        }
        if (!cloud.isCloudReady()) { done('已移除'); return }
        wx.showLoading({ title: '删除中…' })
        try {
          const r = await cloudStore.deleteQuestion(id)
          wx.hideLoading()
          done(r.deleted > 1 ? '已删除（含副本 ' + r.deleted + ' 行）' : '已删除')
        } catch (err) {
          wx.hideLoading()
          if (err && err.code === -404) { done('已移除'); return }
          wx.showModal({ title: '删除失败', content: (err && err.message) || '请稍后重试', showCancel: false })
        }
      }
    })
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
    if (this.data.submitting) return // 入库中：忽略重复点击，避免重复提交
    this.setData({ submitting: true })
    try {
      const s = store.getState()
      const paperId = s.pendingPaperId
      const paper = s.papers.find(p => p.id === paperId)
      const reEdit = !!(paper && paper.status === 'confirmed') // 重编辑已入库试卷
      let sysInfo = null
      if (paperId && paperId.indexOf('p_') === 0) {
        try {
          const r = await cloudStore.confirmPaper(paperId)
          if (r && r.isSystem) sysInfo = r
        } catch (e) { console.warn('[智学星球] 云端确认入库失败，仅更新本地缓存', e) }
      }
      const n = store.confirmAll(s)
      track.event('paper_confirmed', { count: n, source: reEdit ? 'reedit' : 'new' })
      const msg = reEdit ? '修改已保存' : ((paperId && paperId.indexOf('p_') === 0 ? '已云端入库 ' : '已入库 ') + n + ' 道题')
      if (sysInfo) {
        wx.showModal({
          title: '✅ 已发布为系统题库',
          content: (sysInfo.note || ('已入库 ' + n + ' 题')) + '\n\n这批题已同步给所有用户，新用户进入也会自动获得。',
          showCancel: false,
          success: () => wx.navigateBack()
        })
      } else {
        wx.showToast({ title: msg, icon: 'success' })
        setTimeout(() => wx.navigateBack(), 900)
      }
    } finally {
      this.setData({ submitting: false })
    }
  },
  noop() {},
  goPapers() { wx.switchTab({ url: '/pages/papers/papers' }) }
})
