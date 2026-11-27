/**
 * 学情详情 —— 某个周/学期/学年区间的学科与知识点分析
 * 数据由 parent 云函数 studyDetail 实时聚合；页面提供学科筛选、知识点雷达图、
 * 薄弱知识点清单、学科表现、答题趋势与一句话诊断，帮学生和家长定位薄弱点。
 */
const cloud = require('../../utils/cloud.js')
const auth = require('../../utils/auth.js')

const SUBJ_ORDER = ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '地理', '道德与法治']

Page({
  data: {
    loading: true,
    label: '', range: '',
    subject: '全部',
    subjects: [],          // [{subject, answers, correct, wrong, acc}]（含相对条宽 pctOfMax）
    totals: null,          // 当前筛选下的总览
    checkins: 0,
    diagnosis: '',
    radarTags: [],         // 雷达图用的知识点（答题量前 8）
    weakTags: [],          // 薄弱知识点（正确率升序）
    errorBars: [],         // P0-1 错因分布 [{label, count, pct, barW}]
    errorNote: '',         // 错因分布口径说明（本周期 / 当前未攻克）
    errorHints: [],        // 错因触发建议（审题/计算积累达阈值）
    trend: [],             // [{label, answers, acc}]
    canvasW: 340, canvasH: 300,
    empty: false
  },

  onLoad(options) {
    this._kind = options.kind || 'week'
    this._key = options.key || ''
    const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({
      label: decodeURIComponent(options.label || ''),
      range: decodeURIComponent(options.range || ''),
      canvasW: Math.round(win.windowWidth - 50)
    })
    this.load()
  },

  load() {
    // 本地缓存秒显（按区间 key 存），60 秒内重复打开不发请求；云端另有 10 分钟聚合缓存
    const storeKey = 'zx_study_detail_v1'
    const myKey = this._kind + ':' + this._key
    let cached = null
    try { cached = (wx.getStorageSync(storeKey) || {})[myKey] || null } catch (e) {}
    if (cached && cached.r) this._applyDetail(cached.r)
    if (cached && (Date.now() - (cached.at || 0) < 60000)) return
    if (!cloud.isCloudReady()) { if (!cached) this.setData({ loading: false, empty: true }); return }
    auth.ensureStudentId()
      .then(() => cloud.call('parent', { action: 'studyDetail', kind: this._kind, key: this._key }))
      .then(r => {
        try {
          const all = wx.getStorageSync(storeKey) || {}
          all[myKey] = { at: Date.now(), r }
          wx.setStorageSync(storeKey, all)
        } catch (e) {}
        this._applyDetail(r)
      })
      .catch(() => { if (!this._detail) this.setData({ loading: false, empty: true }) })
  },

  _applyDetail(r) {
        this._detail = r
        const subjects = (r.subjects || []).slice().sort((a, b) => {
          const ia = SUBJ_ORDER.indexOf(a.subject), ib = SUBJ_ORDER.indexOf(b.subject)
          return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
        })
        const maxAns = Math.max(1, ...subjects.map(s => s.answers))
        subjects.forEach(s => { s.pctOfMax = Math.round(s.answers / maxAns * 100) })
        // P0-1 错因分布：优先本周期口径，无数据时回退到当前未攻克错题分布
        const es = r.errorStats || {}
        const usePeriod = (es.periodTotal || 0) > 0
        const src = usePeriod ? (es.period || []) : (es.active || [])
        const tot = usePeriod ? (es.periodTotal || 0) : (es.activeTotal || 0)
        const maxC = Math.max(1, ...src.map(x => x.count))
        const errorBars = src.map(x => ({ label: x.label, count: x.count, pct: tot ? Math.round(x.count / tot * 100) : 0, barW: Math.round(x.count / maxC * 100) }))
        this.setData({
          loading: false, subjects, checkins: r.checkins || 0, empty: !(r.totals && r.totals.answers),
          errorBars: tot ? errorBars : [], errorHints: es.hints || [],
          errorNote: tot ? (usePeriod ? '本区间新出错的错题按错因统计，共 ' + tot + ' 道' : '本区间暂无新错题，先看当前未攻克错题的错因分布，共 ' + tot + ' 道') : ''
        })
        this.applySubject('全部')
        this.buildTrend(r.daily || [])
  },

  onSubject(e) { this.applySubject(e.currentTarget.dataset.subj) },

  applySubject(subj) {
    const r = this._detail
    if (!r) return
    let totals
    if (subj === '全部') totals = r.totals
    else {
      const s = (r.subjects || []).find(x => x.subject === subj)
      totals = s ? { answers: s.answers, correct: s.correct, wrong: s.wrong, acc: s.acc } : { answers: 0, correct: 0, wrong: 0, acc: 0 }
    }
    const tagSrc = subj === '全部' ? (r.tagsAll || []) : ((r.tagsBySubject || {})[subj] || [])
    const radarTags = tagSrc.slice(0, 8)
    const weakTags = tagSrc.slice()
      .sort((a, b) => (a.acc - b.acc) || (b.answers - a.answers))
      .slice(0, 8)
    this.setData({ subject: subj, totals, radarTags, weakTags, diagnosis: this.diagnose(r, subj) })
    // 等 WXML 渲染出 canvas 后再画
    setTimeout(() => this.drawRadar(), 60)
  },

  diagnose(r, subj) {
    const pool = (subj === '全部' ? (r.subjects || []) : (r.subjects || []).filter(s => s.subject === subj))
      .filter(s => s.answers >= 3)
    const tagSrc = (subj === '全部' ? (r.tagsAll || []) : ((r.tagsBySubject || {})[subj] || []))
      .filter(t => t.answers >= 2)
    if (!pool.length && !tagSrc.length) return ''
    let txt = ''
    if (pool.length) {
      const weak = pool.slice().sort((a, b) => a.acc - b.acc)[0]
      txt = '最薄弱学科：' + weak.subject + '（正确率 ' + weak.acc + '%，共 ' + weak.answers + ' 道）'
    }
    if (tagSrc.length) {
      const wt = tagSrc.slice().sort((a, b) => (a.acc - b.acc) || (b.answers - a.answers))[0]
      txt += (txt ? '；' : '') + '最薄弱知识点：「' + wt.tag + '」（错 ' + wt.wrong + ' 道，正确率 ' + wt.acc + '%）'
    }
    if (pool.length > 1) {
      const best = pool.slice().sort((a, b) => b.acc - a.acc)[0]
      if (best.acc > (pool.slice().sort((a, b) => a.acc - b.acc)[0].acc)) txt += '；表现最好：' + best.subject + '（' + best.acc + '%）'
    }
    // 错因维度：本周期新出错 ≥3 道时点出主要错因
    const es = r.errorStats || {}
    if ((es.periodTotal || 0) >= 3 && (es.period || []).length) {
      const top = es.period.slice().sort((a, b) => b.count - a.count)[0]
      if (top && top.count > 0) txt += (txt ? '；' : '') + '主要错因：' + top.label + '（占 ' + Math.round(top.count / es.periodTotal * 100) + '%）'
    }
    return txt
  },

  buildTrend(daily) {
    let groups = []
    if (this._kind === 'week') {
      const names = ['一', '二', '三', '四', '五', '六', '日']
      groups = daily.map((d, i) => ({ label: names[i] || '', answers: d.answers, acc: d.answers ? Math.round(d.correct / d.answers * 100) : 0 }))
    } else if (this._kind === 'term') {
      for (let i = 0; i < daily.length; i += 7) {
        const chunk = daily.slice(i, i + 7)
        const a = chunk.reduce((s, d) => s + d.answers, 0), c = chunk.reduce((s, d) => s + d.correct, 0)
        const p = chunk[0].date.split('-')
        groups.push({ label: (+p[1]) + '/' + (+p[2]), answers: a, acc: a ? Math.round(c / a * 100) : 0 })
      }
    } else {
      const byMonth = {}
      daily.forEach(d => {
        const m = d.date.slice(0, 7)
        if (!byMonth[m]) byMonth[m] = { answers: 0, correct: 0 }
        byMonth[m].answers += d.answers; byMonth[m].correct += d.correct
      })
      groups = Object.keys(byMonth).sort().map(m => ({
        label: (+m.split('-')[1]) + '月', answers: byMonth[m].answers,
        acc: byMonth[m].answers ? Math.round(byMonth[m].correct / byMonth[m].answers * 100) : 0
      }))
    }
    const maxAns = Math.max(1, ...groups.map(g => g.answers))
    groups.forEach(g => { g.h = Math.max(4, Math.round(g.answers / maxAns * 100)) })
    this.setData({ trend: groups })
  },

  // ===== 知识点雷达图（正确率 %；只用基础线条/填充，兼容旧版 canvas）=====
  drawRadar() {
    const tags = this.data.radarTags
    if (!tags || tags.length < 3) return
    const W = this.data.canvasW, H = this.data.canvasH
    const ctx = wx.createCanvasContext('tagRadar', this)
    const cx = W / 2, cy = H / 2 + 6, R = Math.min(W, H) / 2 - 46
    const n = tags.length
    const pt = (i, ratio) => {
      const a = -Math.PI / 2 + i * 2 * Math.PI / n
      return [cx + R * ratio * Math.cos(a), cy + R * ratio * Math.sin(a)]
    }
    ctx.setFillStyle('#fbfcff'); ctx.fillRect(0, 0, W, H)
    // 网格环
    ;[1, 0.75, 0.5, 0.25].forEach(ratio => {
      ctx.beginPath()
      for (let i = 0; i < n; i++) { const p = pt(i, ratio); i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]) }
      ctx.closePath()
      ctx.setStrokeStyle('rgba(91,108,246,0.18)'); ctx.setLineWidth(1); ctx.stroke()
    })
    // 轴线 + 标签
    ctx.setFontSize(11); ctx.setFillStyle('#5b6a92')
    for (let i = 0; i < n; i++) {
      const p = pt(i, 1)
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(p[0], p[1])
      ctx.setStrokeStyle('rgba(91,108,246,0.12)'); ctx.stroke()
      const lp = pt(i, 1.22)
      ctx.setTextAlign(lp[0] < cx - 8 ? 'right' : (lp[0] > cx + 8 ? 'left' : 'center'))
      ctx.setTextBaseline('middle')
      const name = tags[i].tag.length > 5 ? tags[i].tag.slice(0, 5) + '…' : tags[i].tag
      ctx.fillText(name + ' ' + tags[i].acc + '%', lp[0], lp[1])
    }
    // 数值多边形
    ctx.beginPath()
    tags.forEach((t, i) => { const p = pt(i, Math.max(0.03, t.acc / 100)); i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]) })
    ctx.closePath()
    ctx.setFillStyle('rgba(91,108,246,0.30)'); ctx.fill()
    ctx.setStrokeStyle('#5b6cf6'); ctx.setLineWidth(2); ctx.stroke()
    tags.forEach((t, i) => {
      const p = pt(i, Math.max(0.03, t.acc / 100))
      ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, Math.PI * 2)
      ctx.setFillStyle(t.acc < 50 ? '#e64340' : '#5b6cf6'); ctx.fill()
    })
    ctx.draw()
  },

  goWrong() { wx.switchTab({ url: '/pages/wrong/wrong' }) }
})
