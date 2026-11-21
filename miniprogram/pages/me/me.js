const store = require('../../utils/store.js')
const cloud = require('../../utils/cloud.js')
const cloudStore = require('../../utils/cloudStore.js')
const auth = require('../../utils/auth.js')
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
        title: 'HTTP 网关未配置',
        content: '请先在腾讯云控制台 HTTP 网关配置 /recognize、/composeTask、/submitAnswer 三条路由指向对应云函数，并把默认域名加入小程序 request 合法域名。未配置时本地 Demo 仍可正常使用。',
        showCancel: false
      })
      return
    }
    this.setData({ cloudResults: [] })
    wx.showLoading({ title: '登录并联调中…' })
    // 先确保真实身份（首次会建档+克隆种子题），再逐个联调
    auth.ensureStudentId().then(studentId => {
      const s = store.getState()
      const sample = (s.questions || []).find(q => q.tags && q.tags.length) || (s.questions || [])[0]
      const tests = [
        { name: 'recognize', data: { studentId, subject: '数学', fileName: '联调测试卷.pdf' },
          ok: r => '返回 ' + ((r.questions || []).length) + ' 道识别题，已写入 PG 待校对' },
        { name: 'composeTask', data: { studentId },
          ok: r => { const q = (r.task || {}).question_ids; const n = typeof q === 'string' ? JSON.parse(q || '[]').length : (q || []).length; return '组卷 ' + n + ' 题' } },
        { name: 'submitAnswer', data: { studentId, questionId: sample ? sample.id : 'q1', answer: sample ? sample.answer : 1, correct: true, knowledgeTags: sample ? sample.tags : ['k1'] },
          ok: () => '批改与掌握度写入成功' }
      ]
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
    }).catch(e => {
      wx.hideLoading()
      this.setData({ cloudResults: [{ name: 'login', ok: false, msg: (e && e.message) || '登录失败' }] })
    })
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
