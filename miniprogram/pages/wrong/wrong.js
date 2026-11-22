const store = require('../../utils/store.js')
const qt = require('../../utils/questionTypes.js')
Page({
  data: {},
  onShow() { this.refresh() },
  refresh() {
    const s = store.getState()
    const etMap = { knowledge: '知识漏洞', concept: '概念混淆', calc: '计算失误', reading: '审题偏差' }
    const list = s.wrongbook.map(w => {
      const q = s.questions.find(x => x.id === w.questionId)
      if (!q) return null
      const etClass = (w.errorType === 'knowledge' || w.errorType === 'concept') ? 'r' : 'y'
      const conquered = w.status === 'conquered'
      return {
        qid: w.questionId, stem: q.stem,
        errorLabel: etMap[w.errorType] || '其他', etClass,
        conquered, due: store.isDue(w) && !conquered,
        dueLabel: store.fmtDue(w),
        wrongCount: w.wrongCount, continuousCorrect: w.continuousCorrect,
        dots: [0, 1, 2].map(i => i < w.reviewStage)
      }
    }).filter(Boolean)
    this.setData({
      list,
      dueCount: s.wrongbook.filter(w => w.status === 'active' && store.isDue(w)).length
    })
  },
  // 导出错题册：生成排版文本复制到剪贴板，用户可粘贴到备忘录/微信或连接打印机
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