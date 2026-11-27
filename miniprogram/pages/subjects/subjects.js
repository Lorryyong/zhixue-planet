const settings = require('../../utils/settings.js')

// 学科 → 可选教材版本
const SUBJECT_BOOKS = {
  '语文': ['人教版', '部编版', '北师大版', '苏教版', '语文版'],
  '数学': ['人教版', '北师大版', '华师大版', '苏科版', '沪科版'],
  '英语': ['人教版', '外研版', '译林版', '沪教版', '北师大版'],
  '物理': ['人教版', '沪科版', '苏科版', '北师大版'],
  '化学': ['人教版', '沪教版', '苏教版', '鲁科版'],
  '生物': ['人教版', '北师大版', '苏教版', '济南版'],
  '历史': ['部编版', '人教版', '北师大版', '华东师大版'],
  '地理': ['人教版', '湘教版', '鲁教版', '苏教版'],
  '道德与法治': ['部编版', '人教版']
}
const ALL_SUBJECTS = Object.keys(SUBJECT_BOOKS)

// 每天打卡题目数档位
const GOAL_OPTIONS = [5, 10, 15, 20]
// 错题占比档位（%），新题 = 100 - 错题
const RATIO_OPTIONS = [0, 20, 30, 50, 60, 70]
// 复习方案：错题按记忆稳定度（简化 FSRS）安排重刷，三档为间隔系数（密集 0.7 / 标准 1.0 / 舒缓 1.4）
const REVIEW_PLANS = [
  { key: 'intensive', label: '密集', desc: '复习间隔更短，记得更牢' },
  { key: 'standard', label: '标准', desc: '按记忆稳定度安排，均衡节奏' },
  { key: 'relaxed', label: '舒缓', desc: '复习间隔更长，负担更轻' }
]

Page({
  data: {
    list: [],           // {name, checked, textbook, versions, versionIndex}
    selectedCount: 0,
    // 打卡设置
    goalOptions: GOAL_OPTIONS,
    ratioOptions: RATIO_OPTIONS,
    reviewPlans: REVIEW_PLANS,
    dailyGoal: 10,
    wrongRatio: 50,
    reviewPlan: 'standard',
    saving: false,
    statusBarHeight: 20
  },
  onLoad() {
    let sbh = 20
    try { sbh = wx.getWindowInfo().statusBarHeight || 20 } catch (e) {
      try { sbh = wx.getSystemInfoSync().statusBarHeight || 20 } catch (e2) {}
    }
    this.setData({ statusBarHeight: sbh })
  },
  // 自定义返回：有未保存修改时弹二选一（直接退出=不保存 / 保存退出=先保存再走）
  onBack() {
    if (!this._isDirty()) { this._leave(); return }
    wx.showModal({
      title: '学习设置未保存',
      content: '你修改了学习设置但还没保存。',
      confirmText: '保存退出',
      confirmColor: '#07c160',
      cancelText: '直接退出',
      cancelColor: '#e64340',
      success: (res) => {
        if (res.confirm) {
          this.save().then(ok => { if (ok) this._leave() })
        } else if (res.cancel) {
          this._leave()
        }
      }
    })
  },
  _leave() {
    try { wx.disableAlertBeforeUnload() } catch (e) {}
    wx.navigateBack({ delta: 1 })
  },
  onShow() {
    // 已有未保存修改时不要重拉数据覆盖用户的编辑
    if (this._loaded && this._isDirty()) return
    settings.load().then(s => {
      this.apply(s.subjects || [])
      const c = s.checkin || {}
      this.setData({
        dailyGoal: GOAL_OPTIONS.indexOf(Number(c.dailyGoal)) >= 0 ? Number(c.dailyGoal) : 10,
        wrongRatio: RATIO_OPTIONS.indexOf(Number(c.wrongRatio)) >= 0 ? Number(c.wrongRatio) : 50,
        reviewPlan: REVIEW_PLANS.some(p => p.key === c.reviewPlan) ? c.reviewPlan : 'standard'
      }, () => {
        this._loaded = true
        this._snapshot = this._currentSig()
        this._syncGuard()
      })
    })
  },
  onUnload() { try { wx.disableAlertBeforeUnload() } catch (e) {} },

  // 未保存修改守护：内容与载入/上次保存时不一致即为脏
  _currentSig() {
    const d = this.data
    return JSON.stringify({
      list: (d.list || []).map(x => ({ n: x.name, c: x.checked, t: x.textbook })),
      g: d.dailyGoal, r: d.wrongRatio, p: d.reviewPlan
    })
  },
  _isDirty() { return !!this._snapshot && this._currentSig() !== this._snapshot },
  _syncGuard() {
    try {
      if (this._isDirty()) {
        wx.enableAlertBeforeUnload({ message: '学习设置已修改但还没保存，离开将丢失这些修改。确定要直接退出吗？' })
      } else {
        wx.disableAlertBeforeUnload()
      }
    } catch (e) {}
  },
  apply(saved) {
    const map = {}
    ;(saved || []).forEach(x => {
      if (x && x.name) map[x.name] = x
    })
    // 已勾选的排在前面，未勾选的默认版本为第一项
    const list = ALL_SUBJECTS.map(name => {
      const cfg = map[name] || {}
      const versions = SUBJECT_BOOKS[name]
      const checked = !!cfg.checked
      const textbook = cfg.textbook || versions[0]
      return {
        name, checked, textbook, versions,
        versionIndex: Math.max(0, versions.indexOf(textbook))
      }
    })
    this.setData({ list, selectedCount: list.filter(x => x.checked).length })
  },
  onCheck(e) {
    const i = Number(e.currentTarget.dataset.i)
    const list = this.data.list.slice()
    list[i] = Object.assign({}, list[i], { checked: !list[i].checked })
    this.setData({ list, selectedCount: list.filter(x => x.checked).length }, () => this._syncGuard())
  },
  onVersion(e) {
    const i = Number(e.currentTarget.dataset.i)
    const vi = Number(e.detail.value)
    const list = this.data.list.slice()
    list[i] = Object.assign({}, list[i], { versionIndex: vi, textbook: list[i].versions[vi] })
    this.setData({ list }, () => this._syncGuard())
  },
  onGoal(e) { this.setData({ dailyGoal: Number(e.currentTarget.dataset.v) }, () => this._syncGuard()) },
  onRatio(e) { this.setData({ wrongRatio: Number(e.currentTarget.dataset.v) }, () => this._syncGuard()) },
  onPlan(e) { this.setData({ reviewPlan: e.currentTarget.dataset.k }, () => this._syncGuard()) },
  // 保存设置；返回是否保存成功（「保存退出」时失败则留在本页）
  async save() {
    const selected = this.data.list.filter(x => x.checked).map(x => ({ name: x.name, textbook: x.textbook, checked: true }))
    if (!selected.length) { wx.showToast({ title: '请至少勾选一个学科', icon: 'none' }); return false }
    this.setData({ saving: true })
    const checkin = {
      dailyGoal: this.data.dailyGoal,
      wrongRatio: this.data.wrongRatio,
      reviewPlan: this.data.reviewPlan,
      updatedAt: new Date().toISOString()
    }
    try {
      await settings.update('subjects', selected)
      await settings.update('checkin', checkin)
      this.setData({ saving: false })
      this._snapshot = this._currentSig()
      this._syncGuard()
      wx.showToast({ title: '设置已保存', icon: 'success' })
      return true
    } catch (e) {
      this.setData({ saving: false })
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
      return false
    }
  }
})
