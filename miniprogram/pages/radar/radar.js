const store = require('../../utils/store.js')
const kbook = require('../../utils/knowledgeBook.js')
Page({
  data: {},
  onShow() { this.refresh() },
  refresh() {
    const s = store.getState()
    // 汇总题库里每个知识点的课本册次（优先人工标注，其次词典推断）
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
    const blind = Object.entries(s.mastery)
      .filter(([id]) => s.mastery[id].score < 75)
      .sort((a, b) => a[1].score - b[1].score)
      .slice(0, 5)
      .map(([id, m]) => {
        const name = store.kName(id)
        return { id, name, score: m.score, book: bookOf[id] || bookOf[name] || kbook.inferBook(id, '', '') }
      })
    this.setData({ blind }, () => this.drawRadar(s))
  },
  drawRadar(s) {
    const ctx = wx.createCanvasContext('radar', this)
    const keys = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6']
    const cx = 150, cy = 145, R = 105, n = keys.length
    const pt = (i, r) => { const a = (-90 + i * 360 / n) * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)] }
    ;[0.25, 0.5, 0.75, 1].forEach(sc => {
      ctx.beginPath()
      keys.forEach((_, i) => { const [x, y] = pt(i, R * sc); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y) })
      ctx.closePath(); ctx.setStrokeStyle('#e6e8f2'); ctx.setLineWidth(1); ctx.stroke()
    })
    keys.forEach((_, i) => { const [x, y] = pt(i, R); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.setStrokeStyle('#e6e8f2'); ctx.stroke() })
    ctx.beginPath()
    keys.forEach((k, i) => { const [x, y] = pt(i, R * ((s.mastery[k] || {}).score || 50) / 100); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y) })
    ctx.closePath(); ctx.setFillStyle('rgba(91,108,246,0.28)'); ctx.setStrokeStyle('#5b6cf6'); ctx.setLineWidth(2); ctx.fill(); ctx.stroke()
    ctx.setFontSize(10); ctx.setFillStyle('#8992ab')
    const labels = ['全等', '方程', '勾股', '二次', '一次', '圆']
    keys.forEach((k, i) => { const [x, y] = pt(i, R + 18); ctx.fillText(labels[i], x - 10, y + 4) })
    ctx.draw()
  }
})