const store = require('../../utils/store.js')
const cloud = require('../../utils/cloud.js')
const cloudStore = require('../../utils/cloudStore.js')
Page({
  data: { cloudReady: false, cloudResults: [] },
  onShow() { this.refresh() },
  refresh() {
    const s = store.getState()
    this.setData({
      level: s.gamification.level,
      dayLabel: store.dateStr(store.offsetNow()),
      cloudReady: cloud.isCloudReady()
    })
  },
  advanceDay() {
    store.advanceDay(store.getState())
    this.refresh()
    wx.showToast({ title: '已进入下一天，重刷排期已更新', icon: 'none' })
  },
  goRadar() { wx.navigateTo({ url: '/pages/radar/radar' }) },
  // 云函数联调：逐个调用三个云函数，展示结果，便于真机验证部署是否成功
  testCloud() {
    if (!cloud.isCloudReady()) {
      wx.showModal({
        title: '云开发未就绪',
        content: '请先在微信开发者工具中开通云开发、部署 cloudfunctions 下的三个云函数，再重新编译。未开通时本地 Demo 仍可正常使用。',
        showCancel: false
      })
      return
    }
    const studentId = cloudStore.STUDENT_ID
    const tests = [
      { name: 'recognize', data: { studentId, subject: '数学', fileName: '联调测试卷.pdf' },
        ok: r => '返回 ' + ((r.questions || []).length) + ' 道识别题，已写入 PG 待校对' },
      { name: 'composeTask', data: { studentId },
        ok: r => { const q = (r.task || {}).question_ids; const n = typeof q === 'string' ? JSON.parse(q || '[]').length : (q || []).length; return '组卷 ' + n + ' 题' } },
      { name: 'submitAnswer', data: { studentId, questionId: 'q1', answer: 1, correct: true, knowledgeTags: ['k1'] },
        ok: () => '批改与掌握度写入成功' }
    ]
    this.setData({ cloudResults: [] })
    wx.showLoading({ title: '云函数联调中…' })
    const results = []
    const runOne = (i) => {
      if (i >= tests.length) {
        wx.hideLoading()
        this.setData({ cloudResults: results })
        return
      }
      const t = tests[i]
      cloud.call(t.name, t.data)
        .then(r => results.push({ name: t.name, ok: true, msg: t.ok(r) }))
        .catch(e => results.push({ name: t.name, ok: false, msg: e.message || '调用失败' }))
        .then(() => { this.setData({ cloudResults: results.slice() }); runOne(i + 1) })
    }
    runOne(0)
  },
  resetData() {
    wx.showModal({
      title: '重置数据', content: '将清空本地 Demo 数据并恢复初始状态，确定吗？',
      success: (res) => {
        if (res.confirm) { store.resetState(); this.refresh(); wx.showToast({ title: '已重置', icon: 'success' }) }
      }
    })
  }
})
