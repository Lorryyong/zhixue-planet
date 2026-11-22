const store = require('../../utils/store.js')
const cloudStore = require('../../utils/cloudStore.js')
const cloud = require('../../utils/cloud.js')
const qt = require('../../utils/questionTypes.js')
const track = require('../../utils/track.js')

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
    const type = qt.normalizeType(q.q_type)
    const m = qt.meta(type)
    const results = t.results || []
    const res = results[idx]

    // 选项型（单选/多选/判断）：渲染 ABCD 选项；填空/主观题不显示选项
    let opts = []
    if (m.control === 'choice') {
      const answerArr = m.answerKind === 'indexArray' ? (Array.isArray(q.answer) ? q.answer : []) : []
      const stdIdx = m.answerKind === 'index' ? Number(q.answer) : -1
      opts = (q.options || []).map((o, j) => {
        let cls = 'opt'
        if (res) {
          const selVal = res.sel
          const selArr = Array.isArray(selVal) ? selVal : [selVal]
          if (m.answerKind === 'indexArray') {
            if (answerArr.indexOf(j) >= 0) cls += ' right'
            else if (selArr.indexOf(j) >= 0) cls += ' wrong'
          } else {
            if (j === stdIdx) cls += ' right'
            else if (j === res.sel) cls += ' wrong'
          }
        }
        return { k: String.fromCharCode(65 + j), text: o, cls, idx: j, selected: cls.indexOf('sel') >= 0 }
      })
    }
    // 答案回填（判分后展示，非选择型）
    let correctText = ''
    if (res && m.control !== 'choice') {
      correctText = qt.formatAnswer(q)
    }
    // 填空题输入框数量 = 标准答案空数
    let blankCount = 1
    if (type === 'blank') {
      const a = qt.asValue(q.answer)
      blankCount = Array.isArray(a) ? Math.max(1, a.length) : 1
    }
    let src = '巩固', srcClass = 'g'
    if (s.wrongbook.some(w => w.questionId === q.id && w.status === 'active')) { src = '错题重刷'; srcClass = 'r' }
    else if (Object.entries(s.mastery).some(([id, mv]) => mv.score < 60 && (q.tags || []).indexOf(id) >= 0)) { src = '薄弱攻坚'; srcClass = 'y' }
    this.setData({
      loading: false, empty: false, done: false,
      idx: idx + 1, total: t.questionIds.length,
      qType: type, qTypeLabel: m.label, control: m.control,
      isMulti: m.answerKind === 'indexArray',
      isSubjective: m.family === 'subjective',
      stem: q.stem, opts, blankCount,
      correctText,
      showFb: !!res, correct: res ? res.correct : false,
      gradedBy: res ? (res.gradedBy || 'auto') : '',
      aiComment: res ? (res.aiComment || '') : '',
      scoreText: (res && res.score != null && res.maxScore) ? (res.score + '/' + res.maxScore) : '',
      analysis: res ? q.analysis : '',
      deltaText: res ? (res.deltas || []).map(d => store.kName(d.tag) + ' ' + (d.d >= 0 ? '+' : '') + d.d).join(' · ') : '',
      src, srcClass,
      pct: Math.round(idx / t.questionIds.length * 100),
      nextLabel: idx + 1 >= t.questionIds.length ? '完成打卡 →' : '下一题 →',
      canSubmit: false, sel: -1, selArr: [], blankInputs: [], textAnswer: '',
      needSelf: false
    })
  },

  selectOpt(e) {
    if (this.data.showFb) return
    const j = e.currentTarget.dataset.idx
    if (this.data.isMulti) {
      // 多选：可切换多个
      let selArr = (this.data.selArr || []).slice()
      const i = selArr.indexOf(j)
      if (i >= 0) selArr.splice(i, 1)
      else selArr.push(j)
      const opts = this.data.opts.map((o) => {
        const cls = (selArr.indexOf(o.idx) >= 0 ? (o.cls.indexOf(' sel') < 0 ? o.cls + ' sel' : o.cls) : o.cls.replace(' sel', ''))
        return Object.assign({}, o, { cls, selected: selArr.indexOf(o.idx) >= 0 })
      })
      this.setData({ opts, selArr, canSubmit: selArr.length > 0 })
    } else {
      const opts = this.data.opts.map((o, i) => {
        const sel = i === j
        const cls = (sel ? (o.cls.indexOf(' sel') < 0 ? o.cls + ' sel' : o.cls) : o.cls.replace(' sel', ''))
        return Object.assign({}, o, { cls, selected: sel })
      })
      this.setData({ opts, sel: j, canSubmit: true })
    }
  },

  onBlankInput(e) {
    const i = e.currentTarget.dataset.idx
    const arr = (this.data.blankInputs || []).slice()
    arr[i] = e.detail.value
    this.setData({ blankInputs: arr, canSubmit: arr.some(x => String(x || '').trim()) })
  },
  onTextAnswer(e) {
    this.setData({ textAnswer: e.detail.value, canSubmit: !!e.detail.value.trim() })
  },

  async submitQ() {
    if (!this.data.canSubmit || this.data.submitting) return
    const s = store.getState()
    const t = s.dailyTask
    const qid = t.questionIds[t.idx || 0]
    // 依据题型组装答案
    let answer
    if (this.data.control === 'choice') {
      answer = this.data.isMulti ? this.data.selArr : this.data.sel
    } else if (this.data.qType === 'blank') {
      answer = this.data.blankInputs
    } else {
      answer = this.data.textAnswer
    }
    this.setData({ submitting: true })
    let r
    if (this.data.cloudMode) {
      try {
        r = await cloudStore.submitAnswer(qid, answer)
      } catch (e) {
        console.warn('[智学星球] 云端提交失败，降级本地', e)
        r = store.submitAnswer(s, qid, answer)
        this.setData({ cloudMode: false })
      }
    } else {
      r = store.submitAnswer(s, qid, answer)
    }
    this.setData({ submitting: false })
    track.event('answer_submit', { q_type: this.data.qType, correct: !!(r && r.correct), fromCloud: this.data.cloudMode })

    // 主观题 AI 不可用 → 弹自评对话框
    if (r && r.needSelfGrade) {
      this.setData({ needSelf: true, selfRef: r.reference, selfPoints: r.scoring_points || [], selfQid: qid, selfAnswer: answer })
      return
    }
    this.refresh()
    wx.showToast({ title: r.correct ? '答对了 +2⚡' : '答错，已加入错题本', icon: 'none' })
  },

  // 学生自评（AI 判分失败兜底）
  async selfGrade(e) {
    const correct = e.currentTarget.dataset.v === '1'
    try {
      await cloudStore.submitAnswer(this.data.selfQid, this.data.selfAnswer, correct)
    } catch (err) {
      wx.showToast({ title: '提交失败，请重试', icon: 'none' })
      return
    }
    this.setData({ needSelf: false })
    this.refresh()
    wx.showToast({ title: correct ? '已记录：自评答对 +2⚡' : '已记录：自评答错', icon: 'none' })
  },

  nextQ() {
    const s = store.getState()
    const t = s.dailyTask
    if ((t.idx || 0) + 1 >= t.questionIds.length) {
      store.finishTask(s)
      track.event('task_finish', { count: t.questionIds.length, subject: t.subject || '综合', fromCloud: this.data.cloudMode })
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
