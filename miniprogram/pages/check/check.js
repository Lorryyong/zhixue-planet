const store = require('../../utils/store.js')
const cloudStore = require('../../utils/cloudStore.js')
const qt = require('../../utils/questionTypes.js')
const kbook = require('../../utils/knowledgeBook.js')
const track = require('../../utils/track.js')

const TYPE_OPTIONS = [
  { key: 'single', label: '单选题' }, { key: 'multiple', label: '多选题' },
  { key: 'judge', label: '判断题' }, { key: 'blank', label: '填空题' },
  { key: 'solve', label: '解答题' }, { key: 'calculation', label: '计算题' },
  { key: 'reading', label: '阅读理解' }, { key: 'experiment', label: '实验题' },
  { key: 'translation', label: '翻译题' }, { key: 'essay', label: '作文' }
]

Page({
  data: {
    editing: false, editId: '', editType: 'single', editTypeLabel: '单选题', typeIndex: 0,
    typeOptions: TYPE_OPTIONS,
    optKeys: ['A', 'B', 'C', 'D', 'E', 'F'],
    eStem: '', eOptions: ['', '', '', ''], eAnswerIndex: 0, eAnswerArr: [], eOptSel: [false, false, false, false],
    eAnswerText: '', eBlankAnswers: [], eScore: 2, ePoints: [],
    eAnalysis: '', eTags: '',
    eYear: '', eGrade: '', eRegion: '', eGradeIndex: 0,
    gradeOptions: ['小学一年级', '小学二年级', '小学三年级', '小学四年级', '小学五年级', '小学六年级', '初一', '初二', '初三', '高一', '高二', '高三'],
    // 结构化知识点：{name, book, inferred}；kbBooks 为课本册次 picker 候选
    eKps: [], kbBooks: kbook.BOOKS
  },
  onShow() { this.refresh() },
  refresh() {
    const s = store.getState()
    const paper = s.papers.find(p => p.id === s.pendingPaperId)
    this.setData({
      qs: s.pendingQuestions.map((q, i) => {
        const type = qt.normalizeType(q.q_type)
        const m = qt.meta(type)
        let answerText = qt.formatAnswer(q)
        return Object.assign({}, q, {
          no: i + 1, qTypeLabel: m.label,
          optText: (q.options || []).map((o, j) => String.fromCharCode(65 + j) + '. ' + o),
          answerText,
          pointsText: (q.scoring_points || []).map(p => p.point + '(' + (p.score || 0) + '分)').join('；'),
          tagNames: (q.tags || q.knowledge_tags || []).map(t => store.kName(t)),
          kpList: this._kpList(q),
          issuesText: (q.issues || []).join('；'),
          needFix: !!q.needFix,
          // 右上角只显示确认状态：已确认（绿）/ 待确认（黄）
          confLabel: q.confirmed ? '已确认' : '待确认',
          confClass: q.confirmed ? 'g' : 'y'
        })
      }),
      paperTitle: paper ? paper.title : '',
      reEdit: !!(paper && paper.status === 'confirmed'),
      confirmedCount: s.pendingQuestions.filter(q => q.confirmed).length
    })
  },
  // 结构化知识点 → 展示行：知识点名（课本册次）；无册次时用词典推断提示
  _kpList(q) {
    let kps = q.knowledge_points
    if (!Array.isArray(kps) || !kps.length) {
      kps = kbook.buildKnowledgePoints(q.tags || q.knowledge_tags || [], null, q.subject, q.grade)
    }
    return (kps || []).filter(k => k && k.name).map(k => {
      const book = k.book || kbook.inferBook(k.name, q.subject, q.grade)
      return {
        name: k.name,
        book: book,
        bookIndex: Math.max(0, kbook.BOOKS.indexOf(book)),
        inferred: !!k.inferred
      }
    })
  },
  confirmQ(e) {
    store.confirmQ(store.getState(), e.currentTarget.dataset.id)
    this.refresh()
    wx.showToast({ title: '已确认', icon: 'none' })
  },
  // 打开编辑弹窗，带入当前题目字段（按题型）
  editTip(e) {
    const id = e.currentTarget.dataset.id
    const q = store.getState().pendingQuestions.find(x => x.id === id)
    if (!q) return
    const type = qt.normalizeType(q.q_type)
    const m = qt.meta(type)
    const opts = (q.options || []).slice(0, 6)
    while (opts.length < 4) opts.push('')
    const ans = qt.asValue(q.answer)
    const eAnswerIndex = (m.answerKind === 'index') ? Number(ans) : 0
    const eAnswerArr = (m.answerKind === 'indexArray') ? (Array.isArray(ans) ? ans : []) : []
    const eBlankAnswers = (m.answerKind === 'textArray') ? (Array.isArray(ans) ? ans : [ans]) : ['']
    const eAnswerText = (m.answerKind === 'reference') ? String(ans || '') : ''
    const ePoints = (q.scoring_points || []).map(p => ({ point: p.point || '', score: p.score || 0 }))
    const eKps = this._kpList(q)
    const typeIndex = Math.max(0, TYPE_OPTIONS.findIndex(function (t) { return t.key === type }))
    const eOptSel = opts.map(function (_, i) {
      return m.answerKind === 'indexArray' ? eAnswerArr.indexOf(i) >= 0 : (eAnswerIndex === i)
    })
    this.setData({
      editing: true, editId: id, editType: type, editTypeLabel: m.label, typeIndex,
      eStem: q.stem || '', eOptions: opts,
      eAnswerIndex, eAnswerArr, eOptSel, eBlankAnswers, eAnswerText,
      eScore: Number(q.score) || (m.family === 'subjective' ? 10 : 2),
      ePoints: ePoints.length ? ePoints : [{ point: '', score: 0 }],
      eAnalysis: q.analysis || '',
      eOriginal: q.original || '',
      eTags: (q.tags || q.knowledge_tags || []).join(','),
      eKps: eKps,
      eYear: q.year ? String(q.year) : '',
      eGrade: q.grade || '',
      eGradeIndex: Math.max(0, this.data.gradeOptions.indexOf(q.grade || '')),
      eRegion: q.region || ''
    })
  },
  // 弹窗内部点击不再关闭：只有点到遮罩本身(target===currentTarget)才关闭，
  // 选项字母/输入框等冒泡上来的点击一律忽略，避免点答案时弹窗消失。
  onMaskTap(e) {
    if (e && e.target === e.currentTarget) this.closeEdit()
  },
  onDialogTap() { /* 吞掉弹窗内部冒泡，防止触发遮罩关闭 */ },
  closeEdit() { this.setData({ editing: false }) },
  onTypeChange(e) {
    const idx = Number(e.detail.value)
    const type = TYPE_OPTIONS[idx] ? TYPE_OPTIONS[idx].key : 'single'
    const m = qt.meta(type)
    this.setData({ editType: type, editTypeLabel: m.label, typeIndex: idx, eScore: m.family === 'subjective' ? 10 : 2 })
  },
  onStem(e) { this.setData({ eStem: e.detail.value }) },
  onOption(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const opts = this.data.eOptions.slice()
    opts[idx] = e.detail.value
    this.setData({ eOptions: opts })
  },
  // 统一入口：按当前题型分流到单选/多选（避免 WXML 动态事件名）
  onOptTap(e) {
    if (this.data.editType === 'multiple') this.onAnswerArr(e)
    else this.onAnswerIndex(e)
  },
  onAnswerIndex(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const eOptSel = this.data.eOptions.map(function (_, i) { return i === idx })
    this.setData({ eAnswerIndex: idx, eOptSel })
  },
  onAnswerArr(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    let arr = this.data.eAnswerArr.slice()
    const i = arr.indexOf(idx)
    if (i >= 0) arr.splice(i, 1); else arr.push(idx)
    const eOptSel = this.data.eOptions.map(function (_, i) { return arr.indexOf(i) >= 0 })
    this.setData({ eAnswerArr: arr, eOptSel })
  },
  onBlankAnswer(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const arr = this.data.eBlankAnswers.slice()
    arr[idx] = e.detail.value
    this.setData({ eBlankAnswers: arr })
  },
  addBlank() { this.setData({ eBlankAnswers: this.data.eBlankAnswers.concat(['']) }) },
  onAnswerText(e) { this.setData({ eAnswerText: e.detail.value }) },
  onScore(e) { this.setData({ eScore: Number(e.detail.value) || 0 }) },
  onPoint(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const field = e.currentTarget.dataset.field
    const pts = this.data.ePoints.slice()
    pts[idx] = Object.assign({}, pts[idx], { [field]: field === 'score' ? (Number(e.detail.value) || 0) : e.detail.value })
    this.setData({ ePoints: pts })
  },
  addPoint() { this.setData({ ePoints: this.data.ePoints.concat([{ point: '', score: 0 }]) }) },
  onAnalysis(e) { this.setData({ eAnalysis: e.detail.value }) },
  onOriginal(e) { this.setData({ eOriginal: e.detail.value }) },
  onTags(e) { this.setData({ eTags: e.detail.value }) },
  // ===== 结构化知识点编辑 =====
  onKpName(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const kps = this.data.eKps.slice()
    kps[idx] = Object.assign({}, kps[idx], { name: e.detail.value, inferred: false })
    this.setData({ eKps: kps })
  },
  onKpBook(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const bi = Number(e.detail.value)
    const kps = this.data.eKps.slice()
    kps[idx] = Object.assign({}, kps[idx], { book: this.data.kbBooks[bi] || '', bookIndex: bi, inferred: false })
    this.setData({ eKps: kps })
  },
  addKp() { this.setData({ eKps: this.data.eKps.concat([{ name: '', book: '', bookIndex: 0, inferred: false }]) }) },
  removeKp(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const kps = this.data.eKps.slice()
    kps.splice(idx, 1)
    this.setData({ eKps: kps })
  },
  onYear(e) { this.setData({ eYear: e.detail.value }) },
  onGrade(e) { this.setData({ eGradeIndex: Number(e.detail.value), eGrade: this.data.gradeOptions[Number(e.detail.value)] || '' }) },
  onRegion(e) { this.setData({ eRegion: e.detail.value }) },
  // 保存：先更新本地，再异步写云端（失败不阻塞）
  async saveEdit() {
    const d = this.data
    if (!d.eStem.trim()) { wx.showToast({ title: '题干不能为空', icon: 'none' }); return }
    // 结构化知识点：名称去空；未填册次的用词典自动补全（仍标记 inferred 供复核）
    const kps = (d.eKps || []).map(k => {
      const name = String((k && k.name) || '').trim()
      if (!name) return null
      const book = String((k && k.book) || '').trim() || kbook.inferBook(name, d.subject, d.eGrade)
      return { name: name.slice(0, 40), book: book.slice(0, 30), inferred: !k.book && !!book }
    }).filter(Boolean).slice(0, 8)
    const kpNames = kps.map(k => k.name)
    // 知识点标签：优先取结构化名称，兼容用户手填标签
    const manualTags = d.eTags.split(/[,，]/).map(x => x.trim()).filter(Boolean)
    const tags = (kpNames.length ? kpNames : manualTags).slice(0, 5)
    const m = qt.meta(d.editType)
    let answer
    if (m.answerKind === 'index') answer = d.eAnswerIndex
    else if (m.answerKind === 'indexArray') answer = d.eAnswerArr.slice().sort((a, b) => a - b)
    else if (m.answerKind === 'textArray') answer = d.eBlankAnswers.map(x => String(x).trim()).filter(Boolean)
    else answer = d.eAnswerText.trim()
    const scoring_points = m.family === 'subjective'
      ? d.ePoints.map(p => ({ point: String(p.point || '').trim(), score: Number(p.score) || 0 })).filter(p => p.point)
      : []
    const patch = {
      stem: d.eStem.trim(), q_type: d.editType,
      options: (m.hasOptions ? d.eOptions.map(x => String(x).trim()) : []),
      answer, scoring_points, score: d.eScore,
      analysis: d.eAnalysis.trim(),
      original: d.eOriginal.trim(),
      year: Number(d.eYear) || 0, grade: d.eGrade || '', region: d.eRegion.trim(),
      knowledge_tags: tags, tags, knowledge_points: kps,
      needFix: false, issues: []
    }
    store.editPendingQ(store.getState(), d.editId, patch)
    this.setData({ editing: false })
    this.refresh()
    wx.showLoading({ title: '保存中…' })
    try {
      await cloudStore.updateQuestion(d.editId, patch)
      wx.hideLoading()
      wx.showToast({ title: '已保存并同步云端', icon: 'success' })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '本地已改，云端同步失败', icon: 'none' })
    }
  },
  async confirmAll() {
    const s = store.getState()
    const paperId = s.pendingPaperId
    const paper = s.papers.find(p => p.id === paperId)
    const reEdit = !!(paper && paper.status === 'confirmed') // 重编辑已入库试卷
    if (paperId && paperId.indexOf('p_') === 0) {
      try { await cloudStore.confirmPaper(paperId) }
      catch (e) { console.warn('[智学星球] 云端确认入库失败，仅更新本地缓存', e) }
    }
    const n = store.confirmAll(s)
    track.event('paper_confirmed', { count: n, source: reEdit ? 'reedit' : 'new' })
    const msg = reEdit ? '修改已保存' : ((paperId && paperId.indexOf('p_') === 0 ? '已云端入库 ' : '已入库 ') + n + ' 道题')
    wx.showToast({ title: msg, icon: 'success' })
    setTimeout(() => wx.navigateBack(), 900)
  },
  goPapers() { wx.switchTab({ url: '/pages/papers/papers' }) }
})
