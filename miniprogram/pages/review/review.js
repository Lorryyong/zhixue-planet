// 快速复习：错题本过卡模式。队列 = 已到期未攻克错题（按到期时间升序）。
// 看题 → 显示答案 → 自评「记住了/没记住」→ 云端按当前复习方案推进排期（与打卡同一套调度）。
const store = require('../../utils/store.js')
const cloudStore = require('../../utils/cloudStore.js')
const qt = require('../../utils/questionTypes.js')
const track = require('../../utils/track.js')

Page({
  data: {
    loading: true, empty: false, done: false,
    idx: 0, total: 0, pct: 0,
    subject: '', typeLabel: '', stem: '', opts: [], hasOpts: false,
    revealed: false, answerText: '', analysis: '',
    submitting: false,
    rememberedCount: 0, forgottenCount: 0, conqueredCount: 0, grantedTotal: 0
  },

  onLoad() { this._build() },

  _build() {
    const s = store.getState()
    const qmap = {}
    ;(s.questions || []).forEach(q => { qmap[q.id] = q })
    const queue = (s.wrongbook || [])
      .filter(w => w.status === 'active' && store.isDue(w) && qmap[w.questionId])
      .sort((a, b) => new Date(a.nextReviewAt).getTime() - new Date(b.nextReviewAt).getTime())
      .map(w => qmap[w.questionId])
    this._queue = queue
    if (!queue.length) {
      this.setData({ loading: false, empty: true })
      return
    }
    this.setData({ loading: false, total: queue.length })
    this._show(0)
    track.event('review_start', { count: queue.length })
  },

  _show(i) {
    const q = this._queue[i]
    if (!q) return
    const m = qt.meta(q.type)
    const opts = (q.options || []).map((t, ix) => ({ label: 'ABCDEFGH'[ix] || String(ix + 1), text: t }))
    this.setData({
      idx: i + 1, pct: Math.round(i / this._queue.length * 100),
      subject: q.subject || '', typeLabel: m.label,
      stem: q.stem || '', opts, hasOpts: opts.length > 0,
      revealed: false, answerText: '', analysis: '',
      currentId: q.id
    })
  },

  reveal() {
    const q = this._queue[this.data.idx - 1]
    if (!q) return
    this.setData({ revealed: true, answerText: qt.formatAnswer(q), analysis: q.analysis || '' })
  },

  async rate(e) {
    if (this.data.submitting) return
    const remembered = e.currentTarget.dataset.v === '1'
    const qid = this.data.currentId
    this.setData({ submitting: true })
    let r
    try {
      r = await cloudStore.reviewAnswer(qid, remembered)
    } catch (err) {
      this.setData({ submitting: false })
      wx.showToast({ title: '提交失败，请重试', icon: 'none' })
      return
    }
    try { wx.vibrateShort({ type: remembered ? 'light' : 'heavy' }) } catch (err) {}
    const d = {
      submitting: false,
      rememberedCount: this.data.rememberedCount + (remembered ? 1 : 0),
      forgottenCount: this.data.forgottenCount + (remembered ? 0 : 1),
      conqueredCount: this.data.conqueredCount + (r.conqueredNow ? 1 : 0),
      grantedTotal: this.data.grantedTotal + (Number(r.granted) || 0)
    }
    if (r.conqueredNow) wx.showToast({ title: '攻克一道错题 +30⚡', icon: 'none' })
    const next = this.data.idx // idx 是 1 基：下一张的 0 基下标恰为当前 idx
    if (next >= this._queue.length) {
      this.setData(Object.assign(d, { done: true, pct: 100 }))
      track.event('review_finish', { total: this._queue.length, remembered: d.rememberedCount })
    } else {
      this.setData(d)
      this._show(next)
    }
  },

  goWrong() { wx.navigateBack({ delta: 1 }) },
  goHome() { wx.switchTab({ url: '/pages/index/index' }) }
})
