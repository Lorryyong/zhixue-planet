const store = require('../../utils/store.js')
const cloudStore = require('../../utils/cloudStore.js')
const qt = require('../../utils/questionTypes.js')
// P0-1 错因四分类标签（concept 为旧推断值，展示并入知识性）
const ET_MAP = { knowledge: '知识性', method: '方法性', reading: '审题性', calc: '计算性', concept: '知识性' }
const ET_OPTIONS = [
  { v: 'knowledge', label: '知识性' },
  { v: 'method', label: '方法性' },
  { v: 'reading', label: '审题性' },
  { v: 'calc', label: '计算性' }
]
// 错因圆点色（列表元数据行用）
const ET_COLOR = { knowledge: '#ff5c6c', concept: '#ff5c6c', method: '#5b6cf6', reading: '#ffb020', calc: '#22c7a9' }
// 科目视觉（与首页、试卷页同一套图标与底色）
const SUBJ_META = {
  '语文': { img: '/images/icons/chinese.png', icon: '📖', bg: '#fdecec' }, '数学': { img: '/images/icons/math.png', icon: '📐', bg: '#e6ebff' },
  '英语': { img: '/images/icons/english.png', icon: '🔤', bg: '#e8f6ff' }, '物理': { img: '/images/icons/physics.png', icon: '🧲', bg: '#e9f7f1' },
  '化学': { img: '/images/icons/chemistry.png', icon: '🧪', bg: '#f0eafd' }, '生物': { img: '/images/icons/biology.png', icon: '🌿', bg: '#e7f8e9' },
  '历史': { img: '/images/icons/history.png', icon: '📜', bg: '#fdf3e0' }, '地理': { img: '/images/icons/geography.png', icon: '🌍', bg: '#e4f5fb' },
  '道德与法治': { img: '/images/icons/politics.png', icon: '⚖️', bg: '#fdeef4' }, '道法': { img: '/images/icons/politics.png', icon: '⚖️', bg: '#fdeef4' }
}
function subjMeta(name) { return SUBJ_META[name] || { icon: '📄', bg: '#eef0ff' } }
Page({
  data: {
    allList: [],          // 全部错题（含完整展示字段）
    list: [],             // 筛选后列表
    dueCount: 0,
    // 筛选：科目（分布与清单共用同一选择，上下联动）/ 错误类型 / 掌握状态
    subjectOptions: [], errorOptions: [], statusOptions: [],
    subject: '', filterError: '', filterStatus: '',
    hasFilter: false,
    // 子主题导航：dist=错题分布 / list=错题清单
    navActive: 'dist',
    // 错题分布：按学科统计未攻克错题的知识点分布（雷达图）
    distAxes: [], distTotal: 0, distMax: 1, distHasRadar: false,
    // 现代版（v2 设计）：页头计数、分布排行 Top5 折叠
    totalCount: 0, conqueredCount: 0,
    distBars: [], distMore: 0, distExpanded: false,
    // 详情弹窗（解析默认折叠：先答后看，P0-2）
    detailOpen: false, detail: null, showAnalysis: false,
    errTypeOptions: ET_OPTIONS
  },
  onShow() { this.refresh() },

  refresh() {
    const s = store.getState()
    const etMap = ET_MAP
    const allList = s.wrongbook.map(w => {
      const q = s.questions.find(x => x.id === w.questionId)
      if (!q) return null
      const type = qt.normalizeType(q.q_type)
      const m = qt.meta(type)
      const etClass = (w.errorType === 'knowledge' || w.errorType === 'concept' || w.errorType === 'method') ? 'r' : 'y'
      const conquered = w.status === 'conquered'
      const vis = subjMeta(q.subject || '未分类')
      return {
        qid: w.questionId, stem: q.stem,
        subject: q.subject || '未分类',
        img: vis.img, icon: vis.icon, iconBg: vis.bg,
        errorType: w.errorType || 'knowledge', errorLabel: etMap[w.errorType] || '其他', etClass,
        etColor: ET_COLOR[w.errorType] || '#8992ab',
        detailErrType: (w.errorType === 'concept' ? 'knowledge' : (w.errorType || 'knowledge')),
        stabText: (Number(w.stability) > 0 && w.status !== 'conquered') ? ('记忆稳定度约 ' + Math.max(1, Math.round(Number(w.stability))) + ' 天 · 记得越牢复习间隔越长') : '',
        stabShort: (Number(w.stability) > 0 && w.status !== 'conquered') ? ('稳定度约 ' + Math.max(1, Math.round(Number(w.stability))) + ' 天') : '',
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

    // 学科候选（分布与清单共用）：从全部错题提取，按固定学科顺序排列
    const ORDER = ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '地理', '道德与法治']
    const subjectOptions = Array.from(new Set(allList.map(x => x.subject).filter(Boolean)))
      .sort((a, b) => {
        const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b)
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, 'zh')
      })
    const errorOptions = Array.from(new Set(allList.map(x => x.errorType).filter(Boolean)))
    // 状态分段：待重刷（已到期）/ 未攻克 / 已攻克（「全部」由分段首项承担）
    const statusOptions = [{ key: 'due', label: '待重刷' }, { key: 'active', label: '未攻克' }, { key: 'conquered', label: '已攻克' }]

    // 当前学科：保持已选（仍在候选内时）；否则默认未攻克错题最多的一科
    let subject = this.data.subject
    if (!subject || subjectOptions.indexOf(subject) < 0) {
      const activeBySubj = {}
      allList.forEach(x => { if (!x.conquered) activeBySubj[x.subject] = (activeBySubj[x.subject] || 0) + 1 })
      subject = Object.keys(activeBySubj).sort((a, b) => activeBySubj[b] - activeBySubj[a])[0] || subjectOptions[0] || ''
    }

    this.setData({
      allList,
      subjectOptions, errorOptions, statusOptions,
      dueCount: s.wrongbook.filter(w => w.status === 'active' && store.isDue(w)).length,
      totalCount: allList.length,
      conqueredCount: allList.filter(x => x.conquered).length,
      subject
    }, () => { this._localFilter(); this._applyDist() })
  },

  // 错题分布：当前学科未攻克错题 → 按知识点计数（每题每个知识点计 1 次）
  _applyDist() {
    const subj = this.data.subject
    const items = (this.data.allList || []).filter(x => x.subject === subj && !x.conquered)
    const cnt = {}
    items.forEach(x => {
      const tags = (x.tagNames && x.tagNames.length) ? x.tagNames : ['未标注知识点']
      tags.forEach(t => { cnt[t] = (cnt[t] || 0) + 1 })
    })
    const axes = Object.keys(cnt).map(name => ({ name, count: cnt[name] }))
      .sort((a, b) => b.count - a.count).slice(0, 8)
    const distMax = axes.length ? axes[0].count : 1
    // 排行条只展示 Top 5，其余折叠（雷达仍用全部轴，最多 8）
    const expanded = this.data.distExpanded
    this.setData({
      distAxes: axes, distTotal: items.length, distMax,
      distHasRadar: axes.length >= 3,
      distBars: expanded ? axes : axes.slice(0, 5),
      distMore: Math.max(0, axes.length - 5)
    }, () => this.drawDistRadar(axes))
  },
  toggleDist() {
    this.setData({ distExpanded: !this.data.distExpanded }, () => this._applyDist())
  },
  // 学科选择：分布与清单共用同一个值，点任意一处两处同步
  onSubjectPick(e) {
    const v = e.currentTarget.dataset.v || ''
    if (!v || v === this.data.subject) return
    this.setData({ subject: v, distExpanded: false }, () => { this._localFilter(); this._applyDist() })
  },
  drawDistRadar(axes) {
    if (!axes || axes.length < 3) return
    const ctx = wx.createCanvasContext('distRadar', this)
    const cx = 150, cy = 145, R = 100
    const n = axes.length
    const max = Math.max.apply(null, axes.map(a => a.count)) || 1
    const pt = (i, r) => { const a = (-90 + i * 360 / n) * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)] }
    ctx.clearRect(0, 0, 300, 290)
    ;[0.25, 0.5, 0.75, 1].forEach(sc => {
      ctx.beginPath()
      for (let i = 0; i < n; i++) { const p = pt(i, R * sc); i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]) }
      ctx.closePath(); ctx.setStrokeStyle('#e6e8f2'); ctx.setLineWidth(1); ctx.stroke()
    })
    for (let i = 0; i < n; i++) { const p = pt(i, R); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(p[0], p[1]); ctx.setStrokeStyle('#e6e8f2'); ctx.stroke() }
    ctx.beginPath()
    axes.forEach((a, i) => { const p = pt(i, R * Math.max(0.06, a.count / max)); i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]) })
    ctx.closePath(); ctx.setFillStyle('rgba(255,92,108,0.15)'); ctx.setStrokeStyle('#ff5c6c'); ctx.setLineWidth(2); ctx.fill(); ctx.stroke()
    ctx.setFontSize(9); ctx.setFillStyle('#8992ab')
    axes.forEach((a, i) => {
      const p = pt(i, R + 16)
      const label = String(a.name || '').slice(0, 6)
      ctx.fillText(label, p[0] - Math.min(27, label.length * 4.5), p[1] + 4)
    })
    ctx.draw()
  },

  // 子主题导航：滚动到对应区块，并预留吸顶导航栏的高度，避免子标题被遮住
  goSection(e) {
    const t = e.currentTarget.dataset.t
    this.setData({ navActive: t })
    const target = t === 'dist' ? '#sec-dist' : '#sec-list'
    const q = wx.createSelectorQuery()
    q.select(target).boundingClientRect()
    q.select('.subnav').boundingClientRect()
    q.selectViewport().scrollOffset()
    q.exec(res => {
      const rect = res[0], nav = res[1], vp = res[2]
      if (!rect || !vp) { wx.pageScrollTo({ selector: target, duration: 300 }); return }
      const navH = nav ? nav.height : 56
      wx.pageScrollTo({ scrollTop: Math.max(0, vp.scrollTop + rect.top - navH - 10), duration: 300 })
    })
  },

  // 本地多维筛选：科目（与分布联动，必选一科）/ 错误类型 / 掌握状态
  _localFilter() {
    const d = this.data
    const etMap = ET_MAP
    const list = (d.allList || []).filter(x => {
      if (d.subject && x.subject !== d.subject) return false
      if (d.filterError && x.errorType !== d.filterError) return false
      if (d.filterStatus === 'due' && !x.due) return false
      if (d.filterStatus === 'active' && x.conquered) return false
      if (d.filterStatus === 'conquered' && !x.conquered) return false
      return true
    })
    // 错误类型/状态选项带上可读标签供 wxml 平铺
    const errorChips = (d.errorOptions || []).map(k => ({ key: k, label: etMap[k] || '其他' }))
    this.setData({
      list, errorChips,
      hasFilter: !!(d.filterError || d.filterStatus)
    })
  },

  // chip 点选：再次点击已选项则取消，回到「全部」
  _toggle(key, v) {
    const cur = this.data[key]
    const next = (cur === v && v !== '') ? '' : v
    this.setData({ [key]: next }, () => this._localFilter())
  },
  onFilterError(e) { this._toggle('filterError', e.currentTarget.dataset.v || '') },
  onFilterStatus(e) { this._toggle('filterStatus', e.currentTarget.dataset.v || '') },
  resetFilter() {
    this.setData({ filterError: '', filterStatus: '' }, () => this._localFilter())
  },

  // 点击错题：打开详情弹窗（解析默认折叠，先自己想/重做，再看解析）
  openDetail(e) {
    const qid = e.currentTarget.dataset.qid
    const item = this.data.allList.find(x => x.qid === qid)
    if (!item) return
    this.setData({ detailOpen: true, detail: item, showAnalysis: false })
  },
  closeDetail() { this.setData({ detailOpen: false, detail: null, showAnalysis: false }) },
  showAnalysisNow() { this.setData({ showAnalysis: true }) },
  // 详情里改选错因：云端落库（失败则只改本地），列表标签同步刷新
  async pickDetailErrorType(e) {
    const v = e.currentTarget.dataset.v
    const d = this.data.detail
    if (!v || !d || v === d.detailErrType) return
    try { await cloudStore.setErrorType(d.qid, v) } catch (err) {
      const s = store.getState()
      const w = s.wrongbook.find(x => x.questionId === d.qid)
      if (w) { w.errorType = v; w.errorTypeSource = 'self'; store.saveState(s) }
    }
    const nd = Object.assign({}, d, { errorType: v, detailErrType: v, errorLabel: ET_MAP[v] || '其他' })
    const allList = (this.data.allList || []).map(x => x.qid === d.qid ? Object.assign({}, x, { errorType: v, detailErrType: v, errorLabel: ET_MAP[v] || '其他' }) : x)
    this.setData({ detail: nd, allList }, () => this._localFilter())
  },
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
    const etMap = ET_MAP
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
