// components/question-editor —— 全题型题目编辑弹窗（v1.9.11 从 check 页抽取，供 check / feedback 共用）
// 只负责表单与 patch 构造，落库由页面各自通过 save 事件处理，保证两处权限链路互不干扰。
const qt = require('../../utils/questionTypes.js')
const kbook = require('../../utils/knowledgeBook.js')

const TYPE_OPTIONS = [
  { key: 'single', label: '单选题' }, { key: 'multiple', label: '多选题' },
  { key: 'judge', label: '判断题' }, { key: 'blank', label: '填空题' },
  { key: 'solve', label: '解答题' }, { key: 'calculation', label: '计算题' },
  { key: 'reading', label: '阅读理解' }, { key: 'experiment', label: '实验题' },
  { key: 'translation', label: '翻译题' }, { key: 'essay', label: '作文' }
]
const GRADE_OPTIONS = ['小学一年级', '小学二年级', '小学三年级', '小学四年级', '小学五年级', '小学六年级', '七年级', '八年级', '九年级', '高一', '高二', '高三']

Component({
  properties: {
    question: { type: Object, value: null },   // 待编辑题目（含 stem/q_type/answer/... 字段）
    visible: { type: Boolean, value: false },  // 是否显示弹窗
    showSubject: { type: Boolean, value: false }, // 是否显示"科目分类"编辑项（feedback 页需要）
    saving: { type: Boolean, value: false },   // 页面保存中，禁用按钮防重复
    saveText: { type: String, value: '保存并同步' }
  },
  data: {
    typeOptions: TYPE_OPTIONS,
    optKeys: ['A', 'B', 'C', 'D', 'E', 'F'],
    gradeOptions: GRADE_OPTIONS,
    kbBooks: kbook.BOOKS,
    editType: 'single', editTypeLabel: '单选题', typeIndex: 0,
    eStem: '', eOptions: ['', '', '', ''], eAnswerIndex: 0, eAnswerArr: [], eOptSel: [false, false, false, false],
    eAnswerText: '', eBlankAnswers: [], eScore: 2, ePoints: [],
    eAnalysis: '', eTags: '', eOriginal: '', eYear: '', eGrade: '', eRegion: '', eGradeIndex: 0,
    eSubject: '', eKps: []
  },
  observers: {
    'question, visible': function (q, visible) {
      if (visible && q) this.fill(q)
    }
  },
  methods: {
    // 用题目对象填充表单（按题型分流）
    fill(q) {
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
        editType: type, editTypeLabel: m.label, typeIndex,
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
        eGradeIndex: Math.max(0, GRADE_OPTIONS.indexOf(q.grade || '')),
        eRegion: q.region || '',
        eSubject: q.subject || ''
      })
    },
    _kpList(q) {
      let kps = q.knowledge_points
      if (!Array.isArray(kps) || !kps.length) {
        kps = kbook.buildKnowledgePoints(q.tags || q.knowledge_tags || [], null, q.subject, q.grade)
      }
      return (kps || []).filter(k => k && k.name).map(k => {
        const book = k.book || kbook.inferBook(k.name, q.subject, q.grade)
        return { name: k.name, book, bookIndex: Math.max(0, kbook.BOOKS.indexOf(book)), inferred: !!k.inferred }
      })
    },
    onMaskTap(e) { if (e && e.target === e.currentTarget) this.triggerEvent('cancel') },
    onDialogTap() { /* 吞掉内部冒泡 */ },
    onCancel() { this.triggerEvent('cancel') },
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
    onSubject(e) { this.setData({ eSubject: e.detail.value }) },
    // 构造 patch 后交给页面落地
    onSave() {
      const d = this.data
      if (!d.eStem.trim()) { wx.showToast({ title: '题干不能为空', icon: 'none' }); return }
      if (d.saving) return
      const kps = (d.eKps || []).map(k => {
        const name = String((k && k.name) || '').trim()
        if (!name) return null
        const book = String((k && k.book) || '').trim() || kbook.inferBook(name, d.eSubject, d.eGrade)
        return { name: name.slice(0, 40), book: book.slice(0, 30), inferred: !k.book && !!book }
      }).filter(Boolean).slice(0, 8)
      const kpNames = kps.map(k => k.name)
      const manualTags = String(d.eTags || '').split(/[,，]/).map(x => x.trim()).filter(Boolean)
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
        knowledge_tags: tags, tags, knowledge_points: kps
      }
      if (d.showSubject && d.eSubject.trim()) patch.subject = d.eSubject.trim()
      this.triggerEvent('save', { patch })
    }
  }
})
