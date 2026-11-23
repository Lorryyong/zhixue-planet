// pages/feedback/feedback.js —— 用户反馈错题清单（管理员处理）
// v1.9.11：修正弹窗改用与试卷校对页共用的 question-editor 组件，字段与全题型编辑器一致。
const cloud = require('../../utils/cloud.js')
const cloudStore = require('../../utils/cloudStore.js')

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
    // 修正弹窗（组件化）
    editing: false, editId: '', editQuestion: null, busy: false
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

  // ===== 修正：打开组件，传入题目快照 =====
  openFix(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.list.find(x => x.id === id)
    if (!item) return
    // 反馈快照即题目对象（含 stem/q_type/answer/options/subject 等），直接交给通用编辑器
    this.setData({ editing: true, editId: id, editQuestion: item.snapshot || {}, busy: false })
  },
  closeFix() { this.setData({ editing: false, editId: '', editQuestion: null, busy: false }) },
  // 组件构造好 patch 后，走反馈云函数的 fix（管理员链路，按 question_id 改所有副本）
  onEditorSave(ev) {
    if (this.data.busy) return
    const patch = ev && ev.detail && ev.detail.patch
    if (!patch) return
    this.setData({ busy: true })
    wx.showLoading({ title: '修正中…' })
    cloudStore.handleFeedback(this.data.editId, 'fix', patch, '管理员修正')
      .then(() => {
        wx.hideLoading()
        this.setData({ busy: false, editing: false, editId: '', editQuestion: null })
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
