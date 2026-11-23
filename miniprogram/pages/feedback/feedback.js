// pages/feedback/feedback.js —— 用户反馈错题清单（管理员处理）
const cloud = require('../../utils/cloud.js')
const cloudStore = require('../../utils/cloudStore.js')

const TYPE_OPTIONS = [
  { key: 'single', label: '单选题' }, { key: 'multiple', label: '多选题' },
  { key: 'judge', label: '判断题' }, { key: 'blank', label: '填空题' },
  { key: 'solve', label: '解答题' }, { key: 'calculation', label: '计算题' },
  { key: 'reading', label: '阅读理解' }, { key: 'experiment', label: '实验题' },
  { key: 'translation', label: '翻译题' }, { key: 'essay', label: '作文' }
]
const TYPE_LABELS = {
  category: '题分类错误', stem: '题目错误', answer: '答案错误'
}

function answerTextOf(snapshot) {
  const a = snapshot && snapshot.answer
  if (a == null) return ''
  if (Array.isArray(a)) return a.join(' / ')
  if (typeof a === 'number') return '选项 ' + String.fromCharCode(65 + a) + '（序号 ' + a + '）'
  return String(a)
}

// 把云端反馈记录转成展示对象
function decorate(f) {
  const snap = f.snapshot || {}
  const metaBits = []
  if (snap.subject) metaBits.push(snap.subject)
  if (snap.grade) metaBits.push(snap.grade)
  if (snap.original) metaBits.push(snap.original)
  if (snap.region) metaBits.push(snap.region)
  if (snap.year) metaBits.push(snap.year + '年')
  return Object.assign({}, f, {
    typeLabel: TYPE_LABELS[f.feedbackType] || f.feedbackType,
    metaLine: metaBits.join(' · ') || '无元数据',
    answerText: answerTextOf(snap)
  })
}

Page({
  data: {
    checking: true, isAdmin: false, openid: '', hint: '',
    list: [],
    typeOptions: TYPE_OPTIONS.map(t => t.label),
    editId: '',
    fixStem: '', fixSubject: '', fixTypeIndex: 0, fixAnswer: '', fixAnalysis: '',
    busy: false
  },
  onShow() { this.checkIdentity() },

  checkIdentity() {
    this.setData({ checking: true })
    cloud.call('importQuestions', { action: 'whoami' })
      .then(r => {
        this.setData({
          checking: false,
          isAdmin: !!(r && r.isAdmin),
          openid: (r && r.openid) || '',
          hint: (r && r.hint) || ''
        })
        if (r && r.isAdmin) this.loadList()
      })
      .catch(e => {
        this.setData({ checking: false, isAdmin: false, hint: (e && e.message) || '身份校验失败' })
      })
  },

  loadList() {
    cloudStore.listFeedback('pending')
      .then(r => this.setData({ list: (r.list || []).map(decorate) }))
      .catch(e => this.showErr(e))
  },

  copyOpenid() {
    wx.setClipboardData({ data: this.data.openid, success: () => wx.showToast({ title: '已复制', icon: 'none' }) })
  },

  // ===== 修正 =====
  openFix(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.list.find(x => x.id === id)
    if (!item) return
    const snap = item.snapshot || {}
    // 答案回填为可编辑文本
    let ansText = ''
    if (Array.isArray(snap.answer)) ansText = snap.answer.join(',')
    else if (typeof snap.answer === 'number') ansText = String(snap.answer)
    else ansText = snap.answer || ''
    const typeKey = snap.q_type || 'single'
    const ti = Math.max(0, TYPE_OPTIONS.findIndex(t => t.key === typeKey))
    this.setData({
      editId: id,
      fixStem: snap.stem || '', fixSubject: snap.subject || '',
      fixTypeIndex: ti, fixAnswer: ansText, fixAnalysis: snap.analysis || ''
    })
  },
  closeFix() { this.setData({ editId: '' }) },
  onFixStem(e) { this.setData({ fixStem: e.detail.value }) },
  onFixSubject(e) { this.setData({ fixSubject: e.detail.value }) },
  onFixType(e) { this.setData({ fixTypeIndex: Number(e.detail.value) }) },
  onFixAnswer(e) { this.setData({ fixAnswer: e.detail.value }) },
  onFixAnalysis(e) { this.setData({ fixAnalysis: e.detail.value }) },

  submitFix() {
    if (this.data.busy) return
    const d = this.data
    if (!d.fixStem.trim()) { wx.showToast({ title: '题干不能为空', icon: 'none' }); return }
    const typeKey = TYPE_OPTIONS[d.fixTypeIndex] ? TYPE_OPTIONS[d.fixTypeIndex].key : 'single'
    // 依据题型解析答案：单选/多选=序号，其余=文本
    let answer = d.fixAnswer.trim()
    if (typeKey === 'single') {
      const n = parseInt(answer, 10)
      answer = Number.isFinite(n) ? n : 0
    } else if (typeKey === 'multiple') {
      answer = answer.split(/[,，\s]+/).map(x => parseInt(x, 10)).filter(x => Number.isFinite(x))
    }
    const patch = {
      stem: d.fixStem.trim(), subject: d.fixSubject.trim(), q_type: typeKey,
      answer, analysis: d.fixAnalysis.trim()
    }
    this.setData({ busy: true })
    wx.showLoading({ title: '修正中…' })
    cloudStore.handleFeedback(d.editId, 'fix', patch, '管理员修正')
      .then(() => {
        wx.hideLoading(); this.setData({ busy: false, editId: '' })
        wx.showToast({ title: '已修正题目', icon: 'success' })
        this.loadList()
      })
      .catch(e => { wx.hideLoading(); this.setData({ busy: false }); this.showErr(e) })
  },

  onIgnore(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '忽略反馈', content: '仅忽略这条反馈，不修改题目。确定吗？',
      success: (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '处理中…' })
        cloudStore.handleFeedback(id, 'ignore', null, '管理员忽略')
          .then(() => { wx.hideLoading(); wx.showToast({ title: '已忽略', icon: 'success' }); this.loadList() })
          .catch(err => { wx.hideLoading(); this.showErr(err) })
      }
    })
  },

  onDelete(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除题目', content: '将从题库中删除该题（含所有用户副本）及关联错题记录，且不可恢复。确定删除吗？',
      confirmText: '删除', confirmColor: '#ff5c6c',
      success: (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '删除中…' })
        cloudStore.handleFeedback(id, 'delete', null, '管理员删除题目')
          .then(() => { wx.hideLoading(); wx.showToast({ title: '已删除题目', icon: 'success' }); this.loadList() })
          .catch(err => { wx.hideLoading(); this.showErr(err) })
      }
    })
  },

  showErr(e) {
    const msg = (e && (e.message || e.reason)) || '操作失败'
    wx.showModal({ title: '出错了', content: String(msg).slice(0, 200), showCancel: false })
  }
})
