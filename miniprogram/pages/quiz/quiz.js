const store = require('../../utils/store.js')
const cloudStore = require('../../utils/cloudStore.js')
const cloud = require('../../utils/cloud.js')
const qt = require('../../utils/questionTypes.js')
const track = require('../../utils/track.js')
const poster = require('../../utils/poster.js')
const badges = require('../../utils/badges.js')

Page({
  data: {
    loading: true, combo: 0, shownEnergy: 0, cloudMode: false, makeupDate: '',
    // P0-1 错因四分类（答错后点选，帮系统对症排复习）
    errType: '',
    errTypeOptions: [
      { v: 'knowledge', label: '知识性·没掌握' },
      { v: 'method', label: '方法性·思路错' },
      { v: 'reading', label: '审题性·看错漏看' },
      { v: 'calc', label: '计算性·算错了' }
    ]
  },
  onLoad(options) {
    const md = options && /^\d{4}-\d{2}-\d{2}$/.test(options.makeupDate || '') ? options.makeupDate : ''
    this.setData({ makeupDate: md })
    // 预热 submitAnswer 云函数：首题提交慢主要是函数冷启动（实测冷启一题近 3 秒，后续毫秒级）。
    // 进入答题页先空跑一次（不带 questionId，服务端校验即返回、不写任何数据），
    // 用用户读第一题的时间把容器热起来，首题提交就不再久等。
    if (cloud.isCloudReady()) {
      try { cloud.call('submitAnswer', {}).catch(() => {}) } catch (e) {}
    }
    this.ensureTask().then(() => this.refresh())
  },

  // 优先云端组卷；云函数不可用时降级到本地算法，保证 Demo 可跑
  async ensureTask() {
    const s0 = store.getState()
    const md = this.data.makeupDate
    const taskDate = md || store.dateStr(store.offsetNow())
    const subject = cloudStore.getPreferredSubject()
    // 复用任务前必须科目一致；补签模式按补签日期匹配，避免与普通当天任务串用
    if (s0.dailyTask && s0.dailyTask.date === taskDate && (s0.dailyTask.subject || '综合') === subject && (!!s0.dailyTask.isMakeup === !!md)) {
      this.setData({ cloudMode: !!s0.dailyTask.cloudId, subject })
      return
    }
    if (cloud.isCloudReady()) {
      try {
        await cloudStore.composeTask(subject, md || undefined)
        this.setData({ cloudMode: true, subject: subject })
        return
      } catch (e) {
        // 云端明确判定本科目无题：直接空态，绝不降级本地组卷。
        // 本地 composeTask 没有科目概念，会把其它科（如物理）的到期错题混进来，
        // 正是"历史 0 题却弹出物理错题"的根因。
        if (e && (e.code === -2 || e.emptySubject)) {
          this.setData({ loading: false, empty: true, emptyMsg: e.message || '本科目暂无可用题目' })
          return
        }
        console.warn('[智学星球] 云端组卷失败，降级本地', e)
      }
    }
    // 仅当云端不可用时才走本地降级，且按当前科目过滤，避免跨科错题混入
    store.composeTask(s0, subject)
    this.setData({ cloudMode: false })
  },

  refresh() {
    const s = store.getState()
    const t = s.dailyTask
    if (!t || !t.questionIds || !t.questionIds.length) {
      this.setData({ loading: false, empty: true })
      return
    }
    const idx = t.idx || 0
    // 任务已完成时：若当前题（最后一题）刚提交完、结果还没展示，先展示该题对错与解析，
    // 用户点「完成打卡 →」才进结束页；没有待展示结果时（如下次重新进入）才直接显示结束页。
    // 云端模式下最后一题提交后 taskProgress.finished 会立刻把本地状态置 done，
    // 旧逻辑在这里直接跳结束页，最后一题的解析永远看不到——此为该 bug 根因。
    if (t.status === 'done' && !(t.results || [])[idx]) {
      this.setData({ loading: false, empty: false, done: true, last: s.lastQuiz })
      return
    }
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
    // 题目元数据小字：科目 / 年级 / 来源 / 省市 / 年份（只展示有值的项）
    const metaBits = []
    if (q.subject) metaBits.push(q.subject)
    if (q.grade) metaBits.push(q.grade)
    if (q.original) metaBits.push(q.original)
    if (q.region) metaBits.push(q.region)
    if (q.year) metaBits.push(q.year + '年')
    const metaText = metaBits.join(' · ')
    this.setData({
      metaText,
      loading: false, empty: false, done: false,
      idx: idx + 1, total: t.questionIds.length,
      qType: type, qTypeLabel: m.label, control: m.control,
      isMulti: m.answerKind === 'indexArray',
      isSubjective: m.family === 'subjective',
      stem: q.stem, opts, blankCount,
      correctText,
      showFb: !!res, correct: res ? res.correct : false,
      errType: (res && !res.correct) ? ((function () { const w = s.wrongbook.find(x => x.questionId === q.id); const et = w ? (w.errorType || '') : ''; return et === 'concept' ? 'knowledge' : et })()) : '',
      gradedBy: res ? (res.gradedBy || 'auto') : '',
      aiComment: res ? (res.aiComment || '') : '',
      scoreText: (res && res.score != null && res.maxScore) ? (res.score + '/' + res.maxScore) : '',
      analysis: res ? q.analysis : '',
      deltaText: res ? (res.deltas || []).map(d => store.kName(d.tag) + ' ' + (d.d >= 0 ? '+' : '') + d.d).join(' · ') : '',
      src, srcClass,
      pct: Math.round(idx / t.questionIds.length * 100),
      nextLabel: idx + 1 >= t.questionIds.length ? '完成打卡 →' : '下一题 →',
      canSubmit: false, sel: -1, selArr: [], blankInputs: [], textAnswer: '',
      needSelf: false, feedbackDone: false,
      // 反馈用的当前题目快照（提交时带给管理员，便于查看与修正）
      currentQId: q.id,
      currentSnapshot: {
        stem: q.stem || '', subject: q.subject || '', q_type: type,
        qTypeLabel: m.label, grade: q.grade || '', region: q.region || '',
        year: q.year || 0, original: q.original || '',
        options: q.options || [], answer: q.answer, analysis: q.analysis || '',
        scoring_points: q.scoring_points || [], tags: q.tags || []
      }
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
      const pts = r.scoring_points || []
      this.setData({
        needSelf: true, selfRef: r.reference, selfPoints: pts, selfQid: qid, selfAnswer: answer,
        selfChecked: pts.map(() => false), selfGot: 0, selfTotalScore: pts.reduce((a, x) => a + (Number(x && x.score) || 0), 0)
      })
      return
    }
    this.refresh()
    this._feedbackFx(!!(r && r.correct))
    wx.showToast({ title: r.correct ? '答对了 +2⚡' : '答错，已加入错题本', icon: 'none' })
    this.showNewBadges(r && r.newBadges)
  },

  // 即时反馈体感：答对轻震、答错重震；连对计数（≥2 显示）
  _feedbackFx(correct) {
    try { wx.vibrateShort({ type: correct ? 'light' : 'heavy' }) } catch (e) {}
    this._combo = correct ? (this._combo || 0) + 1 : 0
    this.setData({ combo: this._combo })
  },

  // 打卡分享卡：今日成绩海报
  shareDone() {
    const s = store.getState()
    const last = this.data.last || {}
    const g = s.gamification || {}
    const subj = (s.dailyTask && s.dailyTask.subject) || ''
    poster.shareCanvasImage(this, 'shareCanvas', {
      title: '今日打卡完成' + (subj ? ' · ' + subj : ''),
      big: (last.correct || 0) + '/' + (last.total || 0),
      bigLabel: '答对题数',
      lines: [
        ['获得能量', '+' + (last.energy || 0)],
        ['攻克错题', (last.conquered || 0) + ' 道'],
        ['连续打卡', (g.streak || 0) + ' 天'],
        ['当前等级', 'Lv.' + (g.level || 1)]
      ],
      footer: '智学星球 · 探索宇宙，始于知识'
    })
  },

  // 完成页能量数字滚动
  _animateEnergy(target) {
    const end = Number(target) || 0
    if (end <= 0) { this.setData({ shownEnergy: end }); return }
    let cur = 0
    const step = Math.max(1, Math.round(end / 18))
    const timer = setInterval(() => {
      cur += step
      if (cur >= end) { cur = end; clearInterval(timer) }
      this.setData({ shownEnergy: cur })
    }, 40)
  },

  // P0-1：答错后点选错因（可选，不选保留系统推断）；云端落库，本地模式写本地错题本
  async pickErrorType(e) {
    const v = e.currentTarget.dataset.v
    if (!v || v === this.data.errType) return
    const qid = this.data.currentQId
    this.setData({ errType: v })
    if (this.data.cloudMode) {
      try { await cloudStore.setErrorType(qid, v) } catch (err) { /* 保存失败不打断答题 */ }
    } else {
      const s = store.getState()
      const w = s.wrongbook.find(x => x.questionId === qid)
      if (w) { w.errorType = v; w.errorTypeSource = 'self'; store.saveState(s) }
    }
  },

  // 新解锁徽章弹窗（不打断答题节奏）
  showNewBadges(ids) {
    if (!ids || !ids.length) return
    const defs = badges.hydrate(ids).filter(x => x.unlocked && ids.indexOf(x.id) >= 0)
    if (!defs.length) return
    const first = defs[0]
    const more = defs.length > 1 ? ('\n另有 ' + (defs.length - 1) + ' 枚徽章解锁') : ''
    wx.showModal({
      title: '🎉 解锁新徽章',
      content: first.emoji + ' ' + first.name + '\n' + first.desc + more,
      confirmText: '太棒了', showCancel: false
    })
  },

  // 得分点自评：逐项勾选「我答到了」，按各点分值加权算比例提交（云端 ≥60% 记答对、按比例记分）
  togglePoint(e) {
    const i = Number(e.currentTarget.dataset.i)
    const checked = (this.data.selfChecked || []).slice()
    checked[i] = !checked[i]
    const got = (this.data.selfPoints || []).reduce((a, x, ix) => a + (checked[ix] ? (Number(x && x.score) || 0) : 0), 0)
    this.setData({ selfChecked: checked, selfGot: got })
  },

  async selfGradePoints() {
    const pts = this.data.selfPoints || []
    const checked = this.data.selfChecked || []
    const totalScore = pts.reduce((a, x) => a + (Number(x && x.score) || 0), 0)
    let ratio
    if (totalScore > 0) ratio = (this.data.selfGot || 0) / totalScore
    else ratio = pts.length ? checked.filter(Boolean).length / pts.length : 0
    let r
    try {
      r = await cloudStore.submitAnswer(this.data.selfQid, this.data.selfAnswer, ratio)
    } catch (err) {
      wx.showToast({ title: '提交失败，请重试', icon: 'none' })
      return
    }
    this.setData({ needSelf: false })
    this.refresh()
    const correct = ratio >= 0.6
    this._feedbackFx(correct)
    wx.showToast({ title: correct ? '已记录：自评达标 +2⚡' : '已记录：自评未达标', icon: 'none' })
    this.showNewBadges(r && r.newBadges)
  },

  // 学生自评（AI 判分失败兜底；无得分点时用二值按钮）
  async selfGrade(e) {
    const correct = e.currentTarget.dataset.v === '1'
    let r
    try {
      r = await cloudStore.submitAnswer(this.data.selfQid, this.data.selfAnswer, correct)
    } catch (err) {
      wx.showToast({ title: '提交失败，请重试', icon: 'none' })
      return
    }
    this.setData({ needSelf: false })
    this.refresh()
    this._feedbackFx(correct)
    wx.showToast({ title: correct ? '已记录：自评答对 +2⚡' : '已记录：自评答错', icon: 'none' })
    this.showNewBadges(r && r.newBadges)
  },

  nextQ() {
    const s = store.getState()
    const t = s.dailyTask
    if ((t.idx || 0) + 1 >= t.questionIds.length) {
      store.finishTask(s)
      track.event('task_finish', { count: t.questionIds.length, subject: t.subject || '综合', fromCloud: this.data.cloudMode })
      this.setData({ done: true, last: s.lastQuiz, shownEnergy: 0 })
      this._animateEnergy(s.lastQuiz && s.lastQuiz.energy)
      if (t.isMakeup) {
        wx.showModal({
          title: '补签完成 🎉', content: (t.makeupDate || this.data.makeupDate) + ' 已补签成功，消耗 1 张补签卡并延续连续天数。',
          confirmText: '知道了', showCancel: false
        })
      } else {
        wx.showToast({ title: '打卡完成！', icon: 'success' })
      }
    } else {
      t.idx = (t.idx || 0) + 1
      store.saveState(s)
      this.refresh()
    }
  },
  // ===== 题目错误反馈（v1.9.9）=====
  onReportError() {
    if (this.data.feedbackDone) {
      wx.showToast({ title: '该题已反馈', icon: 'none' })
      return
    }
    wx.showActionSheet({
      itemList: ['题分类错误', '题目错误', '答案错误'],
      success: (res) => {
        const map = ['category', 'stem', 'answer']
        this.submitFeedback(map[res.tapIndex])
      },
      fail: () => {}
    })
  },
  async submitFeedback(feedbackType) {
    wx.showLoading({ title: '提交中…' })
    try {
      await cloudStore.submitFeedback(this.data.currentQId, feedbackType, this.data.currentSnapshot)
      wx.hideLoading()
      this.setData({ feedbackDone: true })
      wx.showToast({ title: '已反馈，感谢你的提醒', icon: 'success' })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: (e && e.message) || '提交失败，请重试', icon: 'none' })
    }
  },
  // 打卡完成 → 跳学情卡「日记录」里当天这科的记录（日期用云端任务日期，即北京时间）
  goDayStudy() {
    const s = store.getState()
    const t = s.dailyTask || {}
    const key = t.date || ''
    const subj = this.data.subject || t.subject || ''
    let label = '日记录', range = ''
    const m = String(key).match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (m) {
      label = (+m[2]) + '月' + (+m[3]) + '日'
      range = '周' + ['日', '一', '二', '三', '四', '五', '六'][new Date(+m[1], +m[2] - 1, +m[3]).getDay()]
    }
    wx.navigateTo({
      url: '/pages/studydetail/studydetail?kind=day&key=' + key +
        '&subject=' + encodeURIComponent(subj) +
        '&label=' + encodeURIComponent(label) + '&range=' + encodeURIComponent(range)
    })
  },
  goHome() { wx.switchTab({ url: '/pages/index/index' }) }
})
