/**
 * 我的学情卡 —— 按周 / 学期 / 学年汇总本人的学情记录（答题数、正确率、打卡天数）。
 * 数据由 parent 云函数 studyCard 动作实时聚合（zx_answer_record + checkin_dates），口径与首页本周正确率一致。
 */
const cloud = require('../../utils/cloud.js')
const auth = require('../../utils/auth.js')

Page({
  data: {
    tab: 'week',           // week=周记录 | term=学期记录 | year=学年记录
    loading: true,
    summary: null,
    weeks: [], terms: [], years: [],
    rows: []
  },

  onShow() { this.load() },

  load() {
    if (!cloud.isCloudReady()) { this.setData({ loading: false }); return }
    this.setData({ loading: true })
    auth.ensureStudentId()
      .then(() => cloud.call('parent', { action: 'studyCard' }))
      .then(r => {
        this.setData({
          loading: false,
          summary: r.summary || null,
          weeks: r.weeks || [], terms: r.terms || [], years: r.years || []
        })
        this.applyTab()
      })
      .catch(() => { this.setData({ loading: false }) })
  },

  setTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab })
    this.applyTab()
  },

  applyTab() {
    const d = this.data
    const rows = d.tab === 'week' ? d.weeks : (d.tab === 'term' ? d.terms : d.years)
    this.setData({ rows })
  }
})
