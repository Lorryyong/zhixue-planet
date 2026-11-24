/**
 * 家长绑定与周报（家长视角）—— 输入孩子的绑定码认领孩子，查看学情周报。
 * 绑定码由学生在「个人资料」页获取（parent 云函数 ensureCode 自动生成）；
 * 认领时家长选择「我和学生的关系」，写入绑定记录；页面底部可解除与当前孩子的绑定。
 * 学生侧旧入口（我是学生页签）已下线：绑定码展示移至个人资料页。
 */
const cloud = require('../../utils/cloud.js')
const auth = require('../../utils/auth.js')

const RELATIONS = ['妈妈', '爸爸', '爷爷', '奶奶', '外公', '外婆', '其他监护人']

Page({
  data: {
    // 认领表单
    inputCode: '',
    relations: RELATIONS, relationIndex: 0, relation: '妈妈',
    // 已认领孩子
    children: [], activeChild: '',
    // 周报
    report: null, reportWeek: '', loading: false
  },

  onShow() {
    this.loadChildren()
  },

  // ---- 表单输入 ----
  onCode(e) { this.setData({ inputCode: e.detail.value }) },
  onRelation(e) {
    const i = Number(e.detail.value)
    this.setData({ relationIndex: i, relation: this.data.relations[i] })
  },

  // ---- 家长：用绑定码认领孩子（带「我和学生的关系」）----
  claim() {
    const code = this.data.inputCode.trim()
    if (!/^\d{6}$/.test(code)) { wx.showToast({ title: '请输入 6 位绑定码', icon: 'none' }); return }
    if (!cloud.isCloudReady()) { wx.showToast({ title: '认领需要云开发支持', icon: 'none' }); return }
    this.setData({ loading: true })
    auth.ensureStudentId()
      .then(() => cloud.call('parent', { action: 'claim', code, relation: this.data.relation }))
      .then(r => {
        this.setData({ loading: false, inputCode: '' })
        wx.showToast({ title: '认领成功', icon: 'success' })
        this.loadChildren()
        if (r.child) this.loadReport(r.child.openid, false)
      })
      .catch(e => {
        this.setData({ loading: false })
        wx.showToast({ title: (e && e.message) || '认领失败', icon: 'none' })
      })
  },

  // ---- 家长：已认领孩子列表 ----
  loadChildren() {
    if (!cloud.isCloudReady()) { this.setData({ children: [], report: null }); return }
    auth.ensureStudentId()
      .then(() => cloud.call('parent', { action: 'myChildren' }))
      .then(r => {
        const children = (r && r.children) || []
        const stillIn = children.some(c => c.openid === this.data.activeChild)
        const active = stillIn ? this.data.activeChild : ((children[0] && children[0].openid) || '')
        this.setData({ children, activeChild: active })
        if (active) this.loadReport(active, false)
        else this.setData({ report: null, reportWeek: '' })
      })
      .catch(() => {})
  },

  selectChild(e) {
    const openid = e.currentTarget.dataset.id
    this.setData({ activeChild: openid })
    this.loadReport(openid, false)
  },

  // ---- 家长：解除与当前选中孩子的绑定（页面底部按钮）----
  unclaim() {
    const target = this.data.activeChild
    if (!target) return
    const child = this.data.children.find(c => c.openid === target)
    const name = (child && (child.nickname || child.guardian)) || '孩子'
    wx.showModal({
      title: '解除绑定',
      content: '解除后将无法再查看「' + name + '」的学情周报，确定解除吗？（孩子的绑定码不变，之后可重新认领）',
      confirmText: '解除绑定', confirmColor: '#d92d20',
      success: (res) => {
        if (!res.confirm) return
        if (!cloud.isCloudReady()) return
        wx.showLoading({ title: '解除中…' })
        auth.ensureStudentId()
          .then(() => cloud.call('parent', { action: 'unclaim', studentOpenid: target }))
          .then(() => {
            wx.hideLoading()
            wx.showToast({ title: '已解除绑定', icon: 'success' })
            this.setData({ activeChild: '' })
            this.loadChildren()
          })
          .catch(e => {
            wx.hideLoading()
            wx.showToast({ title: (e && e.message) || '解除失败，请重试', icon: 'none' })
          })
      }
    })
  },

  // ---- 云端周报 ----
  loadReport(forStudent, refresh) {
    if (!cloud.isCloudReady() || !forStudent) { this.setData({ report: null }); return }
    this.setData({ loading: true })
    auth.ensureStudentId()
      .then(() => cloud.call('parent', { action: 'weeklyReport', forStudent, refresh: !!refresh }))
      .then(r => {
        this.setData({ loading: false, report: r.report || null, reportWeek: (r.report && r.report.weekKey) || '' })
      })
      .catch(() => { this.setData({ loading: false, report: null }) })
  },
  refreshReport() { this.loadReport(this.data.activeChild, true) }
})
