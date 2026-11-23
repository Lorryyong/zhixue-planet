const store = require('../../utils/store.js')
const qt = require('../../utils/questionTypes.js')
Page({
  data: {
    allList: [],          // 全部错题（含完整展示字段）
    list: [],             // 筛选后列表
    dueCount: 0,
    // 筛选：科目 / 错误类型 / 掌握状态（纵向平铺，本地过滤零网络开销）
    subjectOptions: [], errorOptions: [], statusOptions: [],
    filterSubject: '', filterError: '', filterStatus: '',
    hasFilter: false,
    // 详情弹窗
    detailOpen: false, detail: null
  },
  onShow() { this.refresh() },

  refresh() {
    const s = store.getState()
    const etMap = { knowledge: '知识漏洞', concept: '概念混淆', calc: '计算失误', reading: '审题偏差' }
    const allList = s.wrongbook.map(w => {
      const q = s.questions.find(x => x.id === w.questionId)
      if (!q) return null
      const type = qt.normalizeType(q.q_type)
      const m = qt.meta(type)
      const etClass = (w.errorType === 'knowledge' || w.errorType === 'concept') ? 'r' : 'y'
      const conquered = w.status === 'conquered'
      return {
        qid: w.questionId, stem: q.stem,
        subject: q.subject || '未分类',
        errorType: w.errorType || 'knowledge', errorLabel: etMap[w.errorType] || '其他', etClass,
        conquered, statusKey: conquered ? 'conquered' : 'active',
        due: store.isDue(w) && !conquered,
        dueLabel: store.fmtDue(w),
        wrongCount: w.wrongCount, continuousCorrect: w.continuousCorrect,
        dots: [0, 1, 2].map(i => i < w.reviewStage),
        // 详情所需
        qTypeLabel: m.label,
        optText: (q.options || []).map((o, j) => String.fromCharCode(65 + j) + '. ' + o),
        answerText: qt.formatAnswer(q),
        pointsText: (q.scoring_points || []).map(p => p.point + '(' + (p.score || 0) + '分)').join('；'),
        tagNames: (q.tags || q.knowledge_tags || []).map(t => store.kName(t)),
        analysis: q.analysis || '', original: q.original || ''
      }
    }).filter(Boolean)

    // 筛选项候选值：从全部错题提取，去重
    const subjectOptions = Array.from(new Set(allList.map(x => x.subject).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b, 'zh'))
    const errorOptions = Array.from(new Set(allList.map(x => x.errorType).filter(Boolean)))
    const statusOptions = [{ key: 'active', label: '待重刷' }, { key: 'conquered', label: '已攻克' }]

    this.setData({
      allList,
      subjectOptions, errorOptions, statusOptions,
      dueCount: s.wrongbook.filter(w => w.status === 'active' && store.isDue(w)).length
    }, () => this._localFilter())
  },

  // 本地多维筛选：科目 / 错误类型 / 掌握状态
  _localFilter() {
    const d = this.data
    const etMap = { knowledge: '知识漏洞', concept: '概念混淆', calc: '计算失误', reading: '审题偏差' }
    const list = (d.allList || []).filter(x => {
      if (d.filterSubject && x.subject !== d.filterSubject) return false
      if (d.filterError && x.errorType !== d.filterError) return false
      if (d.filterStatus && x.statusKey !== d.filterStatus) return false
      return true
    })
    // 错误类型/状态选项带上可读标签供 wxml 平铺
    const errorChips = (d.errorOptions || []).map(k => ({ key: k, label: etMap[k] || '其他' }))
    this.setData({
      list, errorChips,
      hasFilter: !!(d.filterSubject || d.filterError || d.filterStatus)
    })
  },

  // chip 点选：再次点击已选项则取消，回到「全部」
  _toggle(key, v) {
    const cur = this.data[key]
    const next = (cur === v && v !== '') ? '' : v
    this.setData({ [key]: next }, () => this._localFilter())
  },
  onFilterSubject(e) { this._toggle('filterSubject', e.currentTarget.dataset.v || '') },
  onFilterError(e) { this._toggle('filterError', e.currentTarget.dataset.v || '') },
  onFilterStatus(e) { this._toggle('filterStatus', e.currentTarget.dataset.v || '') },
  resetFilter() {
    this.setData({ filterSubject: '', filterError: '', filterStatus: '' }, () => this._localFilter())
  },

  // 点击错题：打开详情弹窗（查看题目 + 解析，帮助学习）
  openDetail(e) {
    const qid = e.currentTarget.dataset.qid
    const item = this.data.allList.find(x => x.qid === qid)
    if (!item) return
    this.setData({ detailOpen: true, detail: item })
  },
  closeDetail() { this.setData({ detailOpen: false, detail: null }) },
  noop() {},

  // 导出错题册：生成排版文本复制到剪贴板
  printTip() {
    const s = store.getState()
    const list = s.wrongbook.map(w => {
      const q = s.questions.find(x => x.id === w.questionId)
      if (!q) return null
      return { q, w }
    }).filter(Boolean)
    if (!list.length) { wx.showToast({ title: '暂无错题可导出', icon: 'none' }); return }
    const etMap = { knowledge: '知识漏洞', concept: '概念混淆', calc: '计算失误', reading: '审题偏差' }
    const lines = ['【智学星球 · 错题册】' + store.dateStr(new Date()), '共 ' + list.length + ' 题，按遗忘曲线反复刷', '']
    list.forEach(({ q, w }, i) => {
      const type = qt.normalizeType(q.q_type)
      const m = qt.meta(type)
      lines.push((i + 1) + '. [' + (etMap[w.errorType] || '其他') + '·' + m.label + '] ' + q.stem)
      ;(q.options || []).forEach((o, j) => lines.push('   ' + String.fromCharCode(65 + j) + '. ' + o))
      lines.push('   答案：' + qt.formatAnswer(q) + '　错 ' + w.wrongCount + ' 次')
      const pts = q.scoring_points || []
      if (pts.length) lines.push('   要点：' + pts.map(p => p.point + '(' + (p.score || 0) + '分)').join('；'))
      if (q.analysis) lines.push('   解析：' + q.analysis)
      lines.push('')
    })
    const text = lines.join('\n')
    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showModal({
          title: '错题册已生成',
          content: '共 ' + list.length + ' 题已复制到剪贴板，可粘贴到备忘录或微信保存/打印。',
          showCancel: false
        })
      }
    })
  }
})
