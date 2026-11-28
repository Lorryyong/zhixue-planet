/**
 * 我的学情卡 —— 按周 / 学期 / 学年汇总本人的学情记录（答题数、正确率、打卡天数）。
 * 数据由 parent 云函数 studyCard 动作实时聚合（zx_answer_record + checkin_dates），口径与首页本周正确率一致。
 */
const cloud = require('../../utils/cloud.js')
const auth = require('../../utils/auth.js')
const poster = require('../../utils/poster.js')

Page({
  data: {
    tab: 'day',            // day=日记录 | week=周记录 | term=学期记录 | year=学年记录
    loading: true,
    summary: null,
    days: [], weeks: [], terms: [], years: [],
    rows: [], heat: []
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
          days: c.days || [], weeks: c.weeks || [], terms: c.terms || [], years: c.years || []
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
            days: r.days || [], weeks: r.weeks || [], terms: r.terms || [], years: r.years || []
          })
        } catch (e) {}
        this.setData({
          loading: false,
          summary: r.summary || null,
          days: r.days || [], weeks: r.weeks || [], terms: r.terms || [], years: r.years || []
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
    const rows = d.tab === 'day' ? d.days : (d.tab === 'week' ? d.weeks : (d.tab === 'term' ? d.terms : d.years))
    this.setData({ rows })
    if (d.tab === 'day') this._buildHeat()
  },

  // 打卡热力图：近 15 周 × 7 天（周一在顶），格子深浅 = 当天答题数；数据源与日记录同口径
  _buildHeat() {
    const map = {}
    ;(this.data.days || []).forEach(function (r) { map[r.key] = r })
    const bj = new Date(Date.now() + 8 * 3600 * 1000)
    const todayKey = bj.toISOString().slice(0, 10)
    // 本周周一（UTC 基准做日期运算，避免时区干扰）
    const dow = (bj.getUTCDay() + 6) % 7 // 周一=0
    const monday = new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate() - dow))
    const weeks = []
    for (let w = 14; w >= 0; w--) {
      const col = []
      for (let d = 0; d < 7; d++) {
        const dt = new Date(monday.getTime() - w * 7 * 86400000 + d * 86400000)
        const key = dt.toISOString().slice(0, 10)
        const r = map[key]
        const ans = r ? (r.answers || 0) : 0
        let lv = ans >= 10 ? 3 : (ans >= 5 ? 2 : (ans >= 1 ? 1 : 0))
        if (lv === 0 && r && r.checkins) lv = 1
        col.push({ key, lv, future: key > todayKey, cur: key === todayKey, label: (dt.getUTCMonth() + 1) + '/' + dt.getUTCDate() })
      }
      weeks.push(col)
    }
    this.setData({ heat: weeks })
  },

  // 学情分享卡：生成海报图后走系统分享菜单
  shareCard() {
    const sm = this.data.summary
    if (!sm) return
    poster.shareCanvasImage(this, 'shareCanvas', {
      title: '我的学情卡',
      big: sm.totalAnswers,
      bigLabel: '累计答题（道）',
      lines: [
        ['累计打卡', (sm.totalCheckinDays || 0) + ' 天'],
        ['连续打卡', (sm.streak || 0) + ' 天'],
        ['攻克错题', (sm.conquered || 0) + ' 道'],
        ['累计能量', String(sm.totalEarned || 0)]
      ],
      footer: '智学星球 · 每天一点进步'
    })
  }
})
