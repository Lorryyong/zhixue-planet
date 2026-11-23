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
// 艾宾浩斯复习方案：间隔天数（首次答错后第1天复习，之后按数组递进）
const REVIEW_PLANS = [
  { key: 'intensive', label: '密集', gaps: [1, 2, 4, 7, 15], desc: '1/2/4/7/15 天，记得更牢' },
  { key: 'standard', label: '标准', gaps: [1, 3, 7, 15], desc: '1/3/7/15 天，艾宾浩斯经典节奏' },
  { key: 'relaxed', label: '舒缓', gaps: [1, 3, 7, 15, 30], desc: '1/3/7/15/30 天，负担更轻' }
]

Page({
  data: {
    list: [],           // {name, checked, textbook, versions, versionIndex}
    // 打卡设置
    goalOptions: GOAL_OPTIONS,
    ratioOptions: RATIO_OPTIONS,
    reviewPlans: REVIEW_PLANS,
    dailyGoal: 10,
    wrongRatio: 50,
    reviewPlan: 'standard',
    saving: false
  },
  onShow() {
    settings.load().then(s => {
      this.apply(s.subjects || [])
      const c = s.checkin || {}
      this.setData({
        dailyGoal: GOAL_OPTIONS.indexOf(Number(c.dailyGoal)) >= 0 ? Number(c.dailyGoal) : 10,
        wrongRatio: RATIO_OPTIONS.indexOf(Number(c.wrongRatio)) >= 0 ? Number(c.wrongRatio) : 50,
        reviewPlan: REVIEW_PLANS.some(p => p.key === c.reviewPlan) ? c.reviewPlan : 'standard'
      })
    })
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
    this.setData({ list })
  },
  onCheck(e) {
    const i = Number(e.currentTarget.dataset.i)
    const list = this.data.list.slice()
    list[i] = Object.assign({}, list[i], { checked: !list[i].checked })
    this.setData({ list })
  },
  onVersion(e) {
    const i = Number(e.currentTarget.dataset.i)
    const vi = Number(e.detail.value)
    const list = this.data.list.slice()
    list[i] = Object.assign({}, list[i], { versionIndex: vi, textbook: list[i].versions[vi] })
    this.setData({ list })
  },
  onGoal(e) { this.setData({ dailyGoal: Number(e.currentTarget.dataset.v) }) },
  onRatio(e) { this.setData({ wrongRatio: Number(e.currentTarget.dataset.v) }) },
  onPlan(e) { this.setData({ reviewPlan: e.currentTarget.dataset.k }) },
  async save() {
    const selected = this.data.list.filter(x => x.checked).map(x => ({ name: x.name, textbook: x.textbook, checked: true }))
    if (!selected.length) { wx.showToast({ title: '请至少勾选一个学科', icon: 'none' }); return }
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
      wx.showToast({ title: '设置已保存', icon: 'success' })
    } catch (e) {
      this.setData({ saving: false })
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
    }
  }
})
