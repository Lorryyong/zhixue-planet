const store = require('../../utils/store.js')
const cloudStore = require('../../utils/cloudStore.js')
const cloud = require('../../utils/cloud.js')
const auth = require('../../utils/auth.js')
const settings = require('../../utils/settings.js')

// 未设置学科时的兜底科目（保底展示，避免首页无科目可选）
const FALLBACK_SUBJECTS = ['综合', '数学', '英语', '物理', '化学', '语文']

/**
 * 依据用户勾选的学科生成首页科目列表（本地优先，同步读取）。
 * 列表 = 「综合」总览 + 用户勾选的学科；未设置时用兜底科目。
 */
function buildSubjectNames() {
  const picked = (settings.cached().subjects || [])
    .filter(x => x && x.checked && x.name)
    .map(x => x.name)
  const names = ['综合'].concat(picked.filter((n, i, a) => a.indexOf(n) === i))
  return names.length > 1 ? names : FALLBACK_SUBJECTS.slice()
}

// 当天已完成打卡的科目（本地标记，仅用于首页展示；权威状态在云端任务）
const DONE_KEY = 'zx_done_subjects_'
function readDoneSubjects(date) {
  try { return wx.getStorageSync(DONE_KEY + date) || [] } catch (e) { return [] }
}
function markDone(date, subject) {
  const arr = readDoneSubjects(date)
  if (subject && arr.indexOf(subject) < 0) {
    arr.push(subject)
    try { wx.setStorageSync(DONE_KEY + date, arr) } catch (e) {}
  }
  return arr
}

// 按当前时段生成问候语
function greetingText() {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 13) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

Page({
  data: {
    subjects: [],
    subject: '综合',
    greeting: '你好',
    nickname: '',
    avatar: ''
  },
  onShow() {
    // 先按本地勾选学科即时渲染（设置后返回首页立即生效）
    const subject = cloudStore.getPreferredSubject()
    this.setData({ subject })
    this.applySubjectSettings()
    this.applyProfile()
    this.refresh()
    // 从云端同步最新资料与设置（他处修改/换设备后一致）
    if (cloud.isCloudReady()) {
      auth.syncProfile().then(p => { if (p) this.applyProfile(p) }).catch(() => {})
      // 先同步云端权威养成快照（修复迁移清理脏能量后本地缓存虚高），再重渲染
      auth.syncGamification().then(() => this.refresh()).catch(() => {})
      settings.load().then(() => {
        this.applySubjectSettings()
        this.refresh()
      })
    }
  },

  // 应用勾选学科到首页科目栏；若当前科目不在新列表中则回退到「综合」
  applySubjectSettings() {
    const names = buildSubjectNames()
    let subject = this.data.subject || '综合'
    if (names.indexOf(subject) < 0) {
      subject = '综合'
      cloudStore.setPreferredSubject(subject)
    }
    this.setData({ subjects: names.map(name => ({ name, done: false })), subject })
  },

  applyProfile(p) {
    const profile = p || auth.getProfile() || {}
    this.setData({
      nickname: profile.nickname || '同学',
      avatar: profile.avatar || '',
      greeting: greetingText()
    })
  },

  refresh() {
    const render = () => {
      const s = store.getState()
      const t = s.dailyTask
      const today = store.dateStr(store.offsetNow())
      // 已打卡科目标记（当前科目任务完成即记账）
      if (t && t.status === 'done' && t.subject) markDone(today, t.subject)
      const doneList = readDoneSubjects(today)
      const subjects = buildSubjectNames().map(name => ({ name, done: doneList.indexOf(name) >= 0 }))
      if (!t || !t.subject || !t.questionIds || !t.questionIds.length) {
        // 无任务/空科目：标题跟随当前选中科目，避免沿用上一科的 taskSubject（如切到"历史"仍显示"生物 0题"）
        this.setData({
          subjects, taskDone: false, taskCount: 0, wrongCount: 0, bankCount: 0,
          goalCount: 0, dueWrong: 0, conquered: 0, acc: 0, taskSubject: this.data.subject
        })
        return
      }
      const g = s.gamification
      const stage = store.planetStage(g.energy)
      const dueWrong = s.wrongbook.filter(w => w.status === 'active' && store.isDue(w)).length
      const conquered = s.wrongbook.filter(w => w.status === 'conquered').length
      // 三维度按「当前任务实际题目」×「错题本 active」实时交叉计算，不依赖组卷时的 composition 快照：
      // 修复旧任务/未到期错题导致 composition.wrong 过期、显示与实际不符的问题。
      const taskIds = t.questionIds || []
      const activeWrongIds = {}
      ;(s.wrongbook || []).forEach(w => { if (w.status === 'active') activeWrongIds[w.questionId] = true })
      const wrongInTask = taskIds.filter(id => activeWrongIds[id]).length
      this.setData({
        subjects,
        energy: g.energy, level: g.level, stageName: stage.name, stageNext: stage.next,
        energyPct: Math.min(100, Math.round(g.energy / 1500 * 100)),
        streak: g.streak, acc: store.weekAccuracy(s), conquered,
        taskDone: t.status === 'done', taskCount: taskIds.length,
        taskSubject: t.subject || '综合',
        // wrong=任务中属于错题本的题；bank=题库补齐；goal=任务总题数（三者自洽）
        wrongCount: wrongInTask,
        bankCount: Math.max(0, taskIds.length - wrongInTask),
        goalCount: taskIds.length,
        dueWrong, last: s.lastQuiz
      })
    }
    render()
    // 云端组卷成功后回写缓存，再渲染一次（当天已有任务时云端直接复用）
    if (cloud.isCloudReady()) {
      const curSubject = this.data.subject
      cloudStore.composeTask(curSubject).then(() => {
        render()
      }).catch((err) => {
        // 【v1.9.17】该科已无启用题（如在「我的试卷」取消了全部试卷勾选）：
        // 云端返回 -2/emptySubject，需清掉本地残留的旧任务缓存，否则首页仍显示旧题。
        if (err && (err.code === -2 || err.emptySubject)) {
          const emptySubj = err.emptySubject || curSubject
          const s = store.getState()
          if (s.dailyTask && (s.dailyTask.subject || '综合') === emptySubj) {
            s.dailyTask = null
            store.saveState(s)
          }
          render()
        }
      })
    }
  },

  // 切换科目：每科每天各有一次独立打卡任务，可自由切换
  onSubjectTap(e) {
    const subject = e.currentTarget.dataset.s
    if (subject === this.data.subject) return
    cloudStore.setPreferredSubject(subject)
    this.setData({ subject })
    // 清掉当前科目任务缓存，refresh 会按新科目从云端加载对应任务
    const s = store.getState()
    if (s.dailyTask) { s.dailyTask = null; store.saveState(s) }
    this.refresh()
  },

  startQuiz() { wx.navigateTo({ url: '/pages/quiz/quiz' }) },
  goWrong() { wx.switchTab({ url: '/pages/wrong/wrong' }) }
})
