const store = require('../../utils/store.js')
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
  printTip() { wx.showToast({ title: 'Demo：可接入打印成册', icon: 'none' }) }
})