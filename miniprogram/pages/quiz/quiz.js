const store = require('../../utils/store.js')
const cloudStore = require('../../utils/cloudStore.js')
const cloud = require('../../utils/cloud.js')

Page({
  data: { loading: true, cloudMode: false },
  onLoad() { this.ensureTask().then(() => this.refresh()) },

  // 优先云端组卷；云函数不可用时降级到本地算法，保证 Demo 可跑
  async ensureTask() {
    const s0 = store.getState()
    const today = store.dateStr(store.offsetNow())
    if (s0.dailyTask && s0.dailyTask.date === today) {
      this.setData({ cloudMode: !!s0.dailyTask.cloudId })
      return
    }
    if (cloud.isCloudReady()) {
      try {
        const subject = cloudStore.getPreferredSubject()
        await cloudStore.composeTask(subject)
        this.setData({ cloudMode: true, subject: subject })
        return
      } catch (e) {
        console.warn('[智学星球] 云端组卷失败，降级本地', e)
        if (e && e.emptySubject) {
          wx.showToast({ title: e.message || '该科目暂无题目，请先导入', icon: 'none', duration: 3000 })
        }
      }
    }
    store.composeTask(s0)
    this.setData({ cloudMode: false })
  },

  refresh() {
    const s = store.getState()
    const t = s.dailyTask
    if (!t || !t.questionIds || !t.questionIds.length) {
      this.setData({ loading: false, empty: true })
      return
    }
    if (t.status === 'done') {
      this.setData({ loading: false, empty: false, done: true, last: s.lastQuiz })
      return
    }
    const idx = t.idx || 0
    const q = s.questions.find(x => x.id === t.questionIds[idx])
    if (!q) {
      this.setData({ loading: false, empty: true })
      return
    }
    const results = t.results || []
    const res = results[idx]
    const opts = q.options.map((o, j) => {
      let cls = 'opt'
      if (res) { if (j === q.answer) cls += ' right'; else if (j === res.sel) cls += ' wrong' }
      return { k: String.fromCharCode(65 + j), text: o, cls, idx: j }
    })
    let src = '巩固', srcClass = 'g'
    if (s.wrongbook.some(w => w.questionId === q.id && w.status === 'active')) { src = '错题重刷'; srcClass = 'r' }
    else if (Object.entries(s.mastery).some(([id, m]) => m.score < 60 && q.tags.indexOf(id) >= 0)) { src = '薄弱攻坚'; srcClass = 'y' }
    this.setData({
      loading: false, empty: false, done: false,
      idx: idx + 1, total: t.questionIds.length,
      stem: q.stem, opts,
      showFb: !!res, correct: res ? res.correct : false,
      analysis: res ? q.analysis : '',
      deltaText: res ? (res.deltas || []).map(d => store.kName(d.tag) + ' ' + (d.d >= 0 ? '+' : '') + d.d).join(' · ') : '',
      src, srcClass,
      pct: Math.round(idx / t.questionIds.length * 100),
      nextLabel: idx + 1 >= t.questionIds.length ? '完成打卡 →' : '下一题 →',
      canSubmit: false, sel: -1
    })
  },

  selectOpt(e) {
    if (this.data.showFb) return
    const j = e.currentTarget.dataset.idx
    const opts = this.data.opts.map((o, i) => Object.assign({}, o, { cls: (i === j ? o.cls + ' sel' : o.cls.replace(' sel', '')) }))
    this.setData({ opts, sel: j, canSubmit: true })
  },

  async submitQ() {
    if (!this.data.canSubmit || this.data.submitting) return
    const s = store.getState()
    const t = s.dailyTask
    const qid = t.questionIds[t.idx || 0]
    this.setData({ submitting: true })
    let r
    if (this.data.cloudMode) {
      try {
        r = await cloudStore.submitAnswer(qid, this.data.sel)
      } catch (e) {
        console.warn('[智学星球] 云端提交失败，降级本地', e)
        r = store.submitAnswer(s, qid, this.data.sel)
        this.setData({ cloudMode: false })
      }
    } else {
      r = store.submitAnswer(s, qid, this.data.sel)
    }
    this.setData({ submitting: false })
    this.refresh()
    wx.showToast({ title: r.correct ? '答对了 +2⚡' : '答错，已加入错题本', icon: 'none' })
  },

  nextQ() {
    const s = store.getState()
    const t = s.dailyTask
    if ((t.idx || 0) + 1 >= t.questionIds.length) {
      store.finishTask(s) // 养成数据（能量/连续打卡）暂留本地，云端无对应表
      this.setData({ done: true, last: s.lastQuiz })
      wx.showToast({ title: '打卡完成！', icon: 'success' })
    } else {
      t.idx = (t.idx || 0) + 1
      store.saveState(s)
      this.refresh()
    }
  },
  goRadar() { wx.navigateTo({ url: '/pages/radar/radar' }) },
  goHome() { wx.switchTab({ url: '/pages/index/index' }) }
})
