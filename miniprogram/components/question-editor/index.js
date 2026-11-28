// components/question-editor —— 全题型题目编辑弹窗（v1.9.11 从 check 页抽取，供 check / feedback 共用）
// 只负责表单与 patch 构造，落库由页面各自通过 save 事件处理，保证两处权限链路互不干扰。
const qt = require('../../utils/questionTypes.js')
const kbook = require('../../utils/knowledgeBook.js')
const kdict = require('../../utils/kdict.js')

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
    termOptions: ['未标注', '上学期', '下学期'],
    eTerm: '', eTermIndex: 0,
    kbBooks: kbook.BOOKS,
    editType: 'single', editTypeLabel: '单选题', typeIndex: 0,
    eStem: '', eOptions: ['', '', '', ''], eAnswerIndex: 0, eAnswerArr: [], eOptSel: [false, false, false, false],
    eAnswerText: '', eBlankAnswers: [], eScore: 2, ePoints: [],
    eAnalysis: '', eTags: '', eOriginal: '', eYear: '', eGrade: '', eRegion: '', eGradeIndex: 0,
    eSubject: '', eKps: [],
    // 知识点字典两级联动选择（有字典的学科：英语/数学；dictMode 时标签走字典标准）
    dictMode: false, dictSubject: '', eDictTags: [], eDictNames: [],
    slotList: [0, 1], dictBlockNames: [], dictSlotBlock: [0, 0], dictSlotItems: [[], []], dictSlotItemIdx: [0, 0]
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
        eTerm: q.term || '',
        eTermIndex: ['', '上学期', '下学期'].indexOf(q.term || ''),
        eGrade: q.grade || '',
        eGradeIndex: Math.max(0, GRADE_OPTIONS.indexOf(q.grade || '')),
        eRegion: q.region || '',
        eSubject: q.subject || '',
        dictMode: (q.subject || '') === '英语' || (q.subject || '') === '数学',
        dictSubject: q.subject || '',
        eDictTags: [], eDictNames: [],
        dictBlockNames: [], dictSlotBlock: [0, 0], dictSlotItems: [[], []], dictSlotItemIdx: [0, 0]
      })
      // 有学科：该学科有字典就进点选模式；学科缺失（老导入题本地副本常没带 subject）：
      // 依次拿英语/数学字典认标签，认得出代码才切到点选模式，不误伤其他学科
      if (q.subject) this._initDict(q.subject, q)
      else this._initDict(null, q)
    },
    // 把已有标签认成某学科字典的代码（代码直接认、中文名按字典反查），并备好点选器数据
    _initDict(subject, q) {
      const raw = (q.tags || q.knowledge_tags || []).map(function (t) { return String(t || '').trim() }).filter(Boolean)
      const trySubj = (subj) => kdict.load(subj).then(d => {
        if (!d || !d.items || !d.items.length) return false
        const name2code = {}
        kdict.blocks(subj).forEach(b => b.items.forEach(it => { name2code[it.name] = it.code }))
        const codes = []
        raw.forEach(t => {
          const c = kdict.isCode(subj, t) ? t : (name2code[t] || null)
          if (c && codes.indexOf(c) < 0) codes.push(c)
        })
        if (!subject && !codes.length) return false
        this.setData({
          dictSubject: subj, dictMode: true,
          eDictTags: codes.slice(0, 2),
          eDictNames: codes.slice(0, 2).map(c => kdict.nameOf(subj, c) || c),
          dictSlotBlock: [0, 0], dictSlotItems: [[], []], dictSlotItemIdx: [0, 0]
        })
        this._syncSlots()
        return true
      })
      if (subject) { trySubj(subject); return }
      trySubj('英语').then(ok => { if (!ok) trySubj('数学') })
    },
    // 两级联动：按当前 eDictTags 同步两个槽位的「板块 / 知识点」选择框
    _syncSlots() {
      const blocks = kdict.blocks(this.data.dictSubject || '英语')
      if (!blocks.length) return
      const tags = this.data.eDictTags || []
      const slotBlock = [0, 0], slotItems = [[], []], slotItemIdx = [0, 0]
      for (let s = 0; s < 2; s++) {
        let bi = Math.min(this.data.dictSlotBlock[s] || 0, blocks.length - 1)
        const code = tags[s]
        if (code) {
          blocks.forEach((b, i) => { if (b.items.some(it => it.code === code)) bi = i })
          const ii = blocks[bi].items.findIndex(it => it.code === code)
          slotItemIdx[s] = ii >= 0 ? ii + 1 : 0
        }
        slotBlock[s] = bi
        slotItems[s] = ['请选择'].concat(blocks[bi].items.map(it => it.code + ' ' + it.name))
      }
      this.setData({
        dictBlockNames: blocks.map(b => b.block),
        dictSlotBlock: slotBlock, dictSlotItems: slotItems, dictSlotItemIdx: slotItemIdx
      })
    },
    onSlotBlock(e) {
      const s = Number(e.currentTarget.dataset.slot)
      const bi = Number(e.detail.value)
      const slotBlock = (this.data.dictSlotBlock || [0, 0]).slice()
      slotBlock[s] = bi
      // 换板块即清掉该槽位已选知识点（联动），等用户在新板块里重选
      const tags = (this.data.eDictTags || []).slice()
      if (tags[s]) { tags.splice(s, 1); this.setData({ eDictTags: tags, eDictNames: tags.map(c => kdict.nameOf(this.data.dictSubject || '英语', c) || c) }) }
      this.setData({ dictSlotBlock: slotBlock })
      this._syncSlots()
    },
    onSlotItem(e) {
      const s = Number(e.currentTarget.dataset.slot)
      const vi = Number(e.detail.value)
      const blocks = kdict.blocks(this.data.dictSubject || '英语')
      const bi = (this.data.dictSlotBlock || [0, 0])[s] || 0
      const tags = (this.data.eDictTags || []).slice()
      if (vi <= 0) {
        if (tags[s]) tags.splice(s, 1)
      } else {
        const code = blocks[bi] && blocks[bi].items[vi - 1] ? blocks[bi].items[vi - 1].code : null
        if (!code) return
        if (tags.length && tags[1 - s] === code) { wx.showToast({ title: '主副考点不能选同一个', icon: 'none' }); this._syncSlots(); return }
        tags[s] = code
      }
      const compact = tags.filter(Boolean)
      this.setData({ eDictTags: compact, eDictNames: compact.map(c => kdict.nameOf(this.data.dictSubject || '英语', c) || c) })
      this._syncSlots()
    },
    _kpList(q) {
      let kps = q.knowledge_points
      if (!Array.isArray(kps) || !kps.length) {
        kps = kbook.buildKnowledgePoints(q.tags || q.knowledge_tags || [], null, q.subject, q.grade)
      }
      // 字典代码不是课本知识点条目（英语题标签已走字典），不要把 S02 之类当知识点名展示
      return (kps || []).filter(k => k && k.name && !kdict.isCodeAny(k.name)).map(k => {
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
    onTerm(e) { const i = Number(e.detail.value); this.setData({ eTermIndex: i, eTerm: ['', '上学期', '下学期'][i] || '' }) },
    onRegion(e) { this.setData({ eRegion: e.detail.value }) },
    onSubject(e) {
      const v = e.detail.value
      this.setData({ eSubject: v })
      const subj = String(v || '').trim()
      if (subj !== this.data.dictSubject) {
        this.setData({ dictMode: false, dictSubject: '', eDictTags: [], eDictNames: [], dictSlotBlock: [0, 0], dictSlotItems: [[], []], dictSlotItemIdx: [0, 0] })
        if (subj) this._initDict(subj, { tags: String(this.data.eTags || '').split(/[,，]/).map(x => x.trim()).filter(Boolean) })
      }
    },
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
      // 英语题：标签只认字典点选结果（主+副最多 2 个代码），不与课本知识点名混用
      const tags = d.dictMode ? (d.eDictTags || []).slice(0, 2) : (kpNames.length ? kpNames : manualTags).slice(0, 5)
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
        year: Number(d.eYear) || 0, grade: d.eGrade || '', region: d.eRegion.trim(), term: d.eTerm || '',
        knowledge_tags: tags, tags, knowledge_points: kps
      }
      if (d.showSubject && d.eSubject.trim()) patch.subject = d.eSubject.trim()
      this.triggerEvent('save', { patch })
    }
  }
})
