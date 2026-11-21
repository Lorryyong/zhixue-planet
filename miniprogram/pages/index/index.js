const store = require('../../utils/store.js')
const cloudStore = require('../../utils/cloudStore.js')
const cloud = require('../../utils/cloud.js')

const SUBJECTS = ['综合', '数学', '英语', '物理', '化学', '语文']

Page({
  data: {
    subjects: SUBJECTS,
    subject: '综合'
  },
  onShow() {
    const subject = cloudStore.getPreferredSubject()
    this.setData({ subject })
    this.refresh()
  },

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
        taskSubject: t.subject || '综合',
        blind: comp.blind || 0, wrong: comp.wrong || 0, cons: comp.cons || 0,
        dueWrong, last: s.lastQuiz
      })
    }
    render()
    // 云端组卷成功后回写缓存，再渲染一次（当天已有任务时云端直接复用）
    if (cloud.isCloudReady()) {
      cloudStore.composeTask(this.data.subject).then(r => {
        render()
        if (r && r.note) wx.showToast({ title: r.note, icon: 'none', duration: 3000 })
      }).catch(() => {})
    }
  },

  // 切换科目：保存偏好，清掉当天未开始的任务缓存并重新组卷
  onSubjectTap(e) {
    const subject = e.currentTarget.dataset.s
    if (subject === this.data.subject) return
    const s = store.getState()
    const t = s.dailyTask
    const today = store.dateStr(store.offsetNow())
    // 已开始答题(有结果)则不允许换，交由云函数锁定
    if (t && t.date === today && (t.idx > 0 || (t.results && t.results.length))) {
      wx.showToast({ title: '今日已开始答题，明天再换科目', icon: 'none' })
      return
    }
    cloudStore.setPreferredSubject(subject)
    this.setData({ subject })
    if (t) { s.dailyTask = null; store.saveState(s) }
    this.refresh()
  },

  startQuiz() { wx.navigateTo({ url: '/pages/quiz/quiz' }) },
  goWrong() { wx.switchTab({ url: '/pages/wrong/wrong' }) }
})
