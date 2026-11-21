const store = require('../../utils/store.js')
Page({
  data: {},
  onShow() { this.refresh() },
  refresh() {
    const s = store.getState()
    const t = store.composeTask(s)
    const g = s.gamification
    const stage = store.planetStage(g.energy)
    const dueWrong = s.wrongbook.filter(w => w.status === 'active' && store.isDue(w)).length
    const conquered = s.wrongbook.filter(w => w.status === 'conquered').length
    this.setData({
      energy: g.energy, level: g.level, stageName: stage.name, stageNext: stage.next,
      energyPct: Math.min(100, Math.round(g.energy / 20)),
      streak: g.streak, acc: store.weekAccuracy(s), conquered,
      taskDone: t.status === 'done', taskCount: t.questionIds.length,
      blind: t.composition.blind, wrong: t.composition.wrong, cons: t.composition.cons,
      dueWrong, last: s.lastQuiz
    })
  },
  startQuiz() { wx.navigateTo({ url: '/pages/quiz/quiz' }) },
  goWrong() { wx.switchTab({ url: '/pages/wrong/wrong' }) }
})