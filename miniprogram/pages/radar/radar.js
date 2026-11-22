const store = require('../../utils/store.js')
const kbook = require('../../utils/knowledgeBook.js')
const cloud = require('../../utils/cloud.js')
const auth = require('../../utils/auth.js')
const cloudStore = require('../../utils/cloudStore.js')

// 学科宽松匹配：与组卷口径一致
const ALIAS = {
  '英语': ['英语', 'english'], '数学': ['数学', 'math', 'maths'],
  '语文': ['语文', 'chinese'], '物理': ['物理', 'physics'],
  '化学': ['化学', 'chemistry'], '生物': ['生物', 'biology'],
  '历史': ['历史', 'history'], '地理': ['地理', 'geography']
}
function subjMatch(s, want) {
  if (!want || want === '综合') return true
  const a = String(s || '').trim().toLowerCase()
  const w = String(want).trim().toLowerCase()
  if (!a) return false
  if (a === w || a.indexOf(w) >= 0 || w.indexOf(a) >= 0) return true
  return (ALIAS[want] || []).some(x => a === x || a.indexOf(x) >= 0)
}

Page({
  data: {
    subjects: ['综合'], subject: '综合',
    mastery: [], blind: [], pointCount: 0, empty: false, fromCloud: false
  },
  onShow() {
    const subject = cloudStore.getPreferredSubject() || '综合'
    this.setData({ subject })
    this.loadCloud(subject)
  },
  // 云端数据源：一次拿到学科列表+掌握度+课本册次
  loadCloud(subject) {
    if (!cloud.isCloudReady()) { this.loadLocal(subject); return }
    auth.ensureStudentId()
      .then(() => cloud.call('radarData', {}))
      .then(r => {
        const subjects = (r.subjects && r.subjects.length) ? r.subjects : ['综合']
        this.setData({ subjects, fromCloud: true })
        this.applyData(r.mastery || [], r.bookMap || {}, subject)
      })
      .catch(() => this.loadLocal(subject))
  },
  // 本地降级：用本地 mastery + 题库推断课本
  loadLocal(subject) {
    const s = store.getState()
    const bookOf = {}
    ;(s.questions || []).forEach(q => {
      const kps = q.knowledge_points
      if (!Array.isArray(kps)) return
      kps.forEach(k => {
        if (k && k.name) {
          const b = k.book || kbook.inferBook(k.name, q.subject, q.grade)
          if (b && !bookOf[k.name]) bookOf[k.name] = b
        }
      })
    })
    const mastery = Object.entries(s.mastery || {}).map(([id, m]) => {
      const name = store.kName(id)
      return { id, name, score: m.score || 0, subject: m.subject || (qSubjectOf(s, id) || '') }
    })
    // 本地 mastery 无 subject 字段：用题目标签推断，推断不到归入综合
    const enriched = mastery.map(m => {
      if (m.subject) return m
      let subj = ''
      ;(s.questions || []).some(q => {
        if ((q.tags || []).indexOf(m.id) >= 0 && q.subject) { subj = q.subject; return true }
        return false
      })
      return Object.assign({}, m, { subject: subj })
    })
    const subjSet = {}
    enriched.forEach(m => { if (m.subject) subjSet[m.subject] = true })
    const subjects = ['综合'].concat(Object.keys(subjSet).sort())
    this.setData({ subjects, fromCloud: false })
    this.applyData(enriched, bookOf, subject)
  },
  // 按学科过滤 → 渲染雷达 + 薄弱列表
  applyData(allMastery, bookMap, subject) {
    const list = allMastery.filter(m => subjMatch(m.subject, subject))
    // 雷达轴：取该学科知识点，最多 8 个（掌握度升序，突出薄弱），至少保证有轴可画
    const axes = list.slice().sort((a, b) => a.score - b.score).slice(0, 8)
    const blind = list.filter(m => m.score < 75).sort((a, b) => a.score - b.score).slice(0, 5)
      .map(m => Object.assign({}, m, { book: bookMap[m.name] || kbook.inferBook(m.name, m.subject, '') }))
    this.setData({
      subject, mastery: axes, blind,
      pointCount: list.length, empty: axes.length === 0
    }, () => this.drawRadar(axes))
  },
  switchSubject(e) {
    const subject = e.currentTarget.dataset.s
    if (subject === this.data.subject) return
    cloudStore.setPreferredSubject(subject)
    this.setData({ subject })
    if (this.data.fromCloud && cloud.isCloudReady()) {
      // 复用已缓存数据：重新拉取一次（数据量小，简单可靠）
      this.loadCloud(subject)
    } else {
      this.loadLocal(subject)
    }
  },
  drawRadar(axes) {
    const ctx = wx.createCanvasContext('radar', this)
    const cx = 150, cy = 145, R = 100
    const n = axes.length
    ctx.clearRect(0, 0, 300, 290)
    if (!n) { ctx.draw(); return }
    const pt = (i, r) => { const a = (-90 + i * 360 / n) * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)] }
    // 网格
    ;[0.25, 0.5, 0.75, 1].forEach(sc => {
      ctx.beginPath()
      for (let i = 0; i < n; i++) { const [x, y] = pt(i, R * sc); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y) }
      ctx.closePath(); ctx.setStrokeStyle('#e6e8f2'); ctx.setLineWidth(1); ctx.stroke()
    })
    for (let i = 0; i < n; i++) { const [x, y] = pt(i, R); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.setStrokeStyle('#e6e8f2'); ctx.stroke() }
    // 数据面
    ctx.beginPath()
    axes.forEach((m, i) => { const [x, y] = pt(i, R * Math.max(0.05, (m.score || 0) / 100)); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y) })
    ctx.closePath(); ctx.setFillStyle('rgba(91,108,246,0.28)'); ctx.setStrokeStyle('#5b6cf6'); ctx.setLineWidth(2); ctx.fill(); ctx.stroke()
    // 顶点标签（知识点名，最多显示 6 字）
    ctx.setFontSize(9); ctx.setFillStyle('#8992ab')
    axes.forEach((m, i) => {
      const [x, y] = pt(i, R + 16)
      const label = String(m.name || '').slice(0, 6)
      ctx.fillText(label, x - Math.min(27, label.length * 4.5), y + 4)
    })
    ctx.draw()
  }
})
