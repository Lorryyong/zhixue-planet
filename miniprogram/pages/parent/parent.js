const settings = require('../../utils/settings.js')
const store = require('../../utils/store.js')
const cloud = require('../../utils/cloud.js')
const auth = require('../../utils/auth.js')

const RELATIONS = ['妈妈', '爸爸', '爷爷', '奶奶', '外公', '外婆', '其他监护人']
const WEEK_DAYS = ['周一', '周日', '周六']

Page({
  data: {
    // 视图模式：student=学生绑定视角；parent=家长查看视角
    mode: 'student',
    // 学生绑定表单
    bound: false, guardian: '', relation: '妈妈', phone: '',
    weekly: false, weeklyDay: '周日', boundAt: '', code: '',
    claimed: false,
    inputGuardian: '', inputPhone: '',
    relations: RELATIONS, relationIndex: 0,
    weekDays: WEEK_DAYS, weekDayIndex: 1,
    // 家长认领
    inputCode: '', children: [], activeChild: '',
    // 周报
    report: null, reportWeek: '', saving: false, loading: false
  },
  onShow() {
    settings.load().then(s => this.applyLocal(s))
    if (cloud.isCloudReady()) this.syncCloud()
  },
  // ---- 视角切换 ----
  setMode(e) {
    const mode = e.currentTarget.dataset.mode
    this.setData({ mode, report: null })
    if (mode === 'parent') this.loadChildren()
    else this.loadReport('', false)
  },
  // ---- 本地设置渲染（首帧）----
  applyLocal(s) {
    const p = s.parent || {}
    const ri = Math.max(0, RELATIONS.indexOf(p.relation || '妈妈'))
    const wdi = Math.max(0, WEEK_DAYS.indexOf(p.weeklyDay || '周日'))
    this.setData({
      bound: !!p.bound, guardian: p.guardian || '', relation: p.relation || '妈妈',
      phone: p.phone || '', weekly: !!p.weekly, weeklyDay: p.weeklyDay || '周日', boundAt: p.boundAt || '',
      inputGuardian: p.guardian || '', inputPhone: p.phone || '',
      relationIndex: ri, weekDayIndex: wdi
    })
  },
  // ---- 云端绑定状态同步（云端为准）----
  syncCloud() {
    auth.ensureStudentId()
      .then(() => cloud.call('parent', { action: 'getBinding' }))
      .then(r => {
        const b = r && r.binding
        if (b) {
          this.setData({
            bound: true, guardian: b.guardian, relation: b.relation, phone: b.phone,
            weekly: b.weekly, weeklyDay: b.weeklyDay, boundAt: b.boundAt,
            code: b.code || '', claimed: b.claimed,
            inputGuardian: b.guardian, inputPhone: b.phone,
            relationIndex: Math.max(0, RELATIONS.indexOf(b.relation)),
            weekDayIndex: Math.max(0, WEEK_DAYS.indexOf(b.weeklyDay))
          })
        }
        this.loadReport('', false)
      })
      .catch(() => { this.buildLocalReport() })
  },
  // ---- 表单输入 ----
  onGuardian(e) { this.setData({ inputGuardian: e.detail.value }) },
  onPhone(e) { this.setData({ inputPhone: e.detail.value }) },
  onCode(e) { this.setData({ inputCode: e.detail.value }) },
  onRelation(e) {
    const i = Number(e.detail.value)
    this.setData({ relationIndex: i, relation: this.data.relations[i] })
  },
  onWeekDay(e) {
    const i = Number(e.detail.value)
    this.setData({ weekDayIndex: i, weeklyDay: this.data.weekDays[i] })
  },
  onWeekly() { this.setData({ weekly: !this.data.weekly }) },
  // ---- 学生：绑定监护人（本地 + 云端）----
  bind() {
    const g = this.data.inputGuardian.trim()
    const phone = this.data.inputPhone.trim()
    if (!g) { wx.showToast({ title: '请填写监护人称呼', icon: 'none' }); return }
    if (phone && !/^1\d{10}$/.test(phone)) { wx.showToast({ title: '手机号格式不正确', icon: 'none' }); return }
    this.setData({ saving: true })
    const patch = {
      bound: true, guardian: g, relation: this.data.relation, phone,
      weekly: this.data.weekly, weeklyDay: this.data.weeklyDay,
      boundAt: this.data.boundAt || new Date().toISOString()
    }
    settings.update('parent', patch)
    if (!cloud.isCloudReady()) {
      this.setData({ saving: false })
      this.applyLocal(settings.cached())
      wx.showToast({ title: '家长绑定成功', icon: 'success' })
      return
    }
    auth.ensureStudentId()
      .then(() => cloud.call('parent', {
        action: 'bind', guardian: g, relation: this.data.relation, phone,
        weekly: this.data.weekly, weeklyDay: this.data.weeklyDay
      }))
      .then(r => {
        this.setData({ saving: false, code: (r.binding && r.binding.code) || '', bound: true })
        wx.showToast({ title: '已绑定，绑定码已生成', icon: 'success' })
      })
      .catch(e => {
        this.setData({ saving: false })
        wx.showToast({ title: (e && e.message) || '云端绑定失败，已本地保存', icon: 'none' })
      })
  },
  // ---- 学生：保存订阅设置 ----
  saveSubscription() {
    const p = settings.cached().parent || {}
    const patch = Object.assign({}, p, { weekly: this.data.weekly, weeklyDay: this.data.weeklyDay })
    settings.update('parent', patch)
    if (cloud.isCloudReady()) {
      auth.ensureStudentId()
        .then(() => cloud.call('parent', {
          action: 'bind', guardian: this.data.guardian || p.guardian || '监护人',
          relation: this.data.relation, phone: this.data.phone || '',
          weekly: this.data.weekly, weeklyDay: this.data.weeklyDay
        })).catch(() => {})
    }
    wx.showToast({ title: this.data.weekly ? '已订阅周报' : '已取消订阅', icon: 'success' })
  },
  // ---- 学生：解除绑定 ----
  unbind() {
    wx.showModal({
      title: '解除绑定', content: '解除后家长将无法查看周报，确定吗？',
      success: (res) => {
        if (!res.confirm) return
        settings.update('parent', settings.defaults().parent)
        if (cloud.isCloudReady()) {
          auth.ensureStudentId().then(() => cloud.call('parent', { action: 'unbind' })).catch(() => {})
        }
        this.setData({ bound: false, code: '', claimed: false, guardian: '', inputGuardian: '' })
        wx.showToast({ title: '已解除绑定', icon: 'success' })
      }
    })
  },
  // ---- 复制绑定码 ----
  copyCode() {
    if (!this.data.code) return
    wx.setClipboardData({ data: this.data.code, success: () => wx.showToast({ title: '绑定码已复制', icon: 'success' }) })
  },
  // ---- 家长：用绑定码认领 ----
  claim() {
    const code = this.data.inputCode.trim()
    if (!/^\d{6}$/.test(code)) { wx.showToast({ title: '请输入 6 位绑定码', icon: 'none' }); return }
    if (!cloud.isCloudReady()) { wx.showToast({ title: '认领需要云开发支持', icon: 'none' }); return }
    this.setData({ loading: true })
    auth.ensureStudentId()
      .then(() => cloud.call('parent', { action: 'claim', code }))
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
    if (!cloud.isCloudReady()) { this.setData({ children: [] }); return }
    auth.ensureStudentId()
      .then(() => cloud.call('parent', { action: 'myChildren' }))
      .then(r => {
        const children = (r && r.children) || []
        const active = this.data.activeChild || (children[0] && children[0].openid) || ''
        this.setData({ children, activeChild: active })
        if (active) this.loadReport(active, false)
        else this.buildLocalReport()
      })
      .catch(() => this.buildLocalReport())
  },
  selectChild(e) {
    const openid = e.currentTarget.dataset.id
    this.setData({ activeChild: openid })
    this.loadReport(openid, false)
  },
  // ---- 云端周报 ----
  loadReport(forStudent, refresh) {
    if (!cloud.isCloudReady()) { this.buildLocalReport(); return }
    this.setData({ loading: true })
    auth.ensureStudentId()
      .then(() => cloud.call('parent', { action: 'weeklyReport', forStudent: forStudent || '', refresh: !!refresh }))
      .then(r => {
        this.setData({ loading: false, report: r.report || null, reportWeek: (r.report && r.report.weekKey) || '' })
        if (!r.report) this.buildLocalReport()
      })
      .catch(() => { this.setData({ loading: false }); this.buildLocalReport() })
  },
  refreshReport() { this.loadReport(this.data.mode === 'parent' ? this.data.activeChild : '', true) },
  // ---- 本地降级周报 ----
  buildLocalReport() {
    const s = store.getState()
    const g = s.gamification || {}
    const mastery = s.mastery || {}
    const weak = Object.entries(mastery).filter(([id, m]) => (m.score || 0) < 75)
      .sort((a, b) => a[1].score - b[1].score).slice(0, 5)
      .map(([id, m]) => ({ name: store.kName(id), score: m.score }))
    const wrongActive = (s.wrongbook || []).filter(w => w.status === 'active').length
    const conquered = (s.wrongbook || []).filter(w => w.status === 'conquered').length
    this.setData({
      report: {
        energy: g.energy || 0, streak: g.streak || 0,
        checkins: (g.checkinDates || []).length, acc: store.weekAccuracy(s),
        weakList, wrongActive, conquered, answerCount: 0,
        hasData: !!(g.energy || Object.keys(mastery).length), local: true
      }
    })
  }
})
