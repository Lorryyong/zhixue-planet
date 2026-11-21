const store = require('../../utils/store.js')
const cloudStore = require('../../utils/cloudStore.js')
const cloud = require('../../utils/cloud.js')
Page({
  data: {},
  onShow() { this.refresh() },
  refresh() {
    const render = () => {
      const s = store.getState()
      const t = s.dailyTask
      if (!t || !t.questionIds || !t.questionIds.length) {
        this.setData({ taskDone: false, taskCount: 0, blind: 0, wrong: 0, cons: 0, dueWrong: 0, conquered: 0, acc: 0 })
        return
      }
      const g = s.gamification
      const stage = store.planetStage(g.energy)
      const dueWrong = s.wrongbook.filter(w => w.status === 'active' && store.isDue(w)).length
      const conquered = s.wrongbook.filter(w => w.status === 'conquered').length
      const comp = t.composition || {}
      this.setData({
        energy: g.energy, level: g.level, stageName: stage.name, stageNext: stage.next,
        energyPct: Math.min(100, Math.round(g.energy / 20)),
        streak: g.streak, acc: store.weekAccuracy(s), conquered,
        taskDone: t.status === 'done', taskCount: t.questionIds.length,
        blind: comp.blind || 0, wrong: comp.wrong || 0, cons: comp.cons || 0,
        dueWrong, last: s.lastQuiz
      })
    }
    render()
    // 云端组卷成功后回写缓存，再渲染一次（当天已有任务时云端直接复用）
    if (cloud.isCloudReady()) {
      cloudStore.composeTask().then(render).catch(() => {})
    }
  },
  startQuiz() { wx.navigateTo({ url: '/pages/quiz/quiz' }) },
  goWrong() { wx.switchTab({ url: '/pages/wrong/wrong' }) }
})
