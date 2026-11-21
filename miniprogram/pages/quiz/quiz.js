const store = require('../../utils/store.js')
Page({
  data: {},
  onLoad() { this.refresh() },
  refresh() {
    const s = store.getState()
    const t = store.composeTask(s)
    if (t.status === 'done') {
      this.setData({ done: true, last: s.lastQuiz })
      return
    }
    const idx = t.idx
    const q = s.questions.find(x => x.id === t.questionIds[idx])
    const res = t.results[idx]
    const opts = q.options.map((o, j) => {
      let cls = 'opt'
      if (res) { if (j === q.answer) cls += ' right'; else if (j === res.sel) cls += ' wrong' }
      return { k: String.fromCharCode(65 + j), text: o, cls, idx: j }
    })
    let src = '巩固', srcClass = 'g'
    if (s.wrongbook.some(w => w.questionId === q.id && w.status === 'active')) { src = '错题重刷'; srcClass = 'r' }
    else if (Object.entries(s.mastery).some(([id, m]) => m.score < 60 && q.tags.indexOf(id) >= 0)) { src = '薄弱攻坚'; srcClass = 'y' }
    this.setData({
      done: false, idx: idx + 1, total: t.questionIds.length,
      stem: q.stem, opts,
      showFb: !!res, correct: res ? res.correct : false,
      analysis: res ? q.analysis : '',
      deltaText: res ? res.deltas.map(d => store.kName(d.tag) + ' ' + (d.d >= 0 ? '+' : '') + d.d).join(' · ') : '',
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
  submitQ() {
    if (!this.data.canSubmit) return
    const s = store.getState()
    const t = s.dailyTask
    const r = store.submitAnswer(s, t.questionIds[t.idx], this.data.sel)
    this.refresh()
    wx.showToast({ title: r.correct ? '答对了 +2⚡' : '答错，已加入错题本', icon: 'none' })
  },
  nextQ() {
    const s = store.getState()
    const t = s.dailyTask
    if (t.idx + 1 >= t.questionIds.length) {
      store.finishTask(s)
      this.setData({ done: true, last: s.lastQuiz })
      wx.showToast({ title: '打卡完成！', icon: 'success' })
    } else {
      t.idx++
      store.saveState(s)
      this.refresh()
    }
  },
  goRadar() { wx.navigateTo({ url: '/pages/radar/radar' }) },
  goHome() { wx.switchTab({ url: '/pages/index/index' }) }
})