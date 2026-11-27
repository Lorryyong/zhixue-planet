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

  onShow() { this._applyCache(); this.load() },

  // 本地缓存秒显（云端另有 10 分钟聚合缓存，两层叠加后重复打开基本无等待）
  _applyCache() {
    try {
      const c = wx.getStorageSync('zx_study_card_v1')
      if (c && c.summary) {
        this._cacheAt = c.at || 0
        this.setData({
          loading: false,
          summary: c.summary,
          weeks: c.weeks || [], terms: c.terms || [], years: c.years || []
        }, () => this.applyTab())
        return true
      }
    } catch (e) {}
    return false
  },

  load() {
    if (!cloud.isCloudReady()) { this.setData({ loading: false }); return }
    // 60 秒内刚同步过且已有数据：跳过网络
    if (this._cacheAt && (Date.now() - this._cacheAt < 60000) && this.data.summary) return
    if (!this.data.summary) this.setData({ loading: true })
    auth.ensureStudentId()
      .then(() => cloud.call('parent', { action: 'studyCard' }))
      .then(r => {
        this._cacheAt = Date.now()
        try {
          wx.setStorageSync('zx_study_card_v1', {
            at: this._cacheAt, summary: r.summary || null,
            weeks: r.weeks || [], terms: r.terms || [], years: r.years || []
          })
        } catch (e) {}
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

  goDetail(e) {
    const d = e.currentTarget.dataset
    wx.navigateTo({
      url: '/pages/studydetail/studydetail?kind=' + this.data.tab +
        '&key=' + encodeURIComponent(d.key) +
        '&label=' + encodeURIComponent(d.label) +
        '&range=' + encodeURIComponent(d.range)
    })
  },

  applyTab() {
    const d = this.data
    const rows = d.tab === 'week' ? d.weeks : (d.tab === 'term' ? d.terms : d.years)
    this.setData({ rows })
  }
})
