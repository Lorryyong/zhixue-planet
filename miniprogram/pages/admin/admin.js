// pages/admin/admin.js —— 题库批量导入（管理员；仅拍照 / PDF / Excel 三种方式，识别后进入 check 校对页发布为系统题）
const cloud = require('../../utils/cloud.js')
const cloudStore = require('../../utils/cloudStore.js')
const store = require('../../utils/store.js')

Page({
  data: {
    checking: true,
    isAdmin: false,
    openid: '',
    hint: '',
    tab: 'import',           // import=题库导入 | users=用户管理（管理端入口带 tab=users 进入）
    importing: false,        // 文件导入进行中
    users: [], usersTotal: 0, usersLoading: false,
    subjects: ['数学', '英语', '物理', '化学', '语文', '生物', '历史', '政治'],
    subject: '数学',
    bootstrapped: false
  },

  onLoad(options) {
    const tab = (options && options.tab) === 'users' ? 'users' : 'import'
    this.setData({ tab })
    this.checkIdentity()
  },

  // ===== 文件导入（复用试卷页「导入新试卷」能力，asSystem=system，进入 check 校对后发布）=====
  _enterCheck(res, title, engine) {
    const qs = res && res.questions
    if (!qs || !qs.length) {
      wx.showToast({ title: '未识别到题目，请更换文件重试', icon: 'none' })
      return
    }
    store.loadCloudPaper(store.getState(), qs, {
      title: title || '系统题库导入', subject: res.subject || '数学', paperId: res.paperId
    })
    wx.navigateTo({ url: '/pages/check/check' })
    wx.showToast({
      title: engine === 'excel' ? '导入完成，请逐题校对后确认发布' : '识别完成，请逐题校对后确认发布',
      icon: 'none', duration: 2000
    })
  },

  chooseImage() {
    if (this.data.importing) return
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['camera', 'album'], sizeType: ['compressed'],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0]
        if (f) this.doRecognize(f.tempFilePath, '系统题识别.' + (/\.png$/i.test(f.tempFilePath) ? 'png' : 'jpg'))
      },
      fail: () => {}
    })
  },

  choosePdf() {
    if (this.data.importing) return
    wx.chooseMessageFile({
      count: 1, type: 'file', extension: ['pdf'],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0]
        if (f) this.doRecognize(f.path, f.name)
      },
      fail: () => {}
    })
  },

  chooseExcel() {
    if (this.data.importing) return
    wx.chooseMessageFile({
      count: 1, type: 'file', extension: ['xlsx', 'xls', 'csv'],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0]
        if (!f) return
        this.setData({ importing: true })
        wx.showLoading({ title: '解析 Excel 中…' })
        cloudStore.importExcel(f.path, f.name, this.data.subject, true)
          .then(r => {
            wx.hideLoading(); this.setData({ importing: false })
            this._enterCheck(r, f.name || '系统题库Excel导入', 'excel')
          })
          .catch(err => {
            wx.hideLoading(); this.setData({ importing: false })
            if (err && err.code === -403) {
              wx.showModal({ title: '无权限', content: err.message || '请使用管理员账号登录管理端', showCancel: false })
            } else {
              wx.showModal({ title: '导入失败', content: (err && err.message) || '请检查 Excel 格式', showCancel: false })
            }
          })
      },
      fail: () => {}
    })
  },

  doRecognize(filePath, fileName) {
    this.setData({ importing: true })
    wx.showLoading({ title: 'AI 识别中…' })
    cloudStore.recognize(filePath, fileName || '系统题识别.pdf', this.data.subject, true)
      .then(res => {
        wx.hideLoading(); this.setData({ importing: false })
        this._enterCheck(res, fileName || '系统题识别', res.engine)
      })
      .catch(err => {
        wx.hideLoading(); this.setData({ importing: false })
        if (err && err.code === -403) {
          wx.showModal({ title: '无权限', content: err.message || '请使用管理员账号登录管理端', showCancel: false })
        } else if (err && (err.code === -429 || (err.message && err.message.indexOf('上限') >= 0))) {
          wx.showModal({ title: '识别受限', content: err.message || '今日识别次数已达上限', showCancel: false })
        } else {
          wx.showModal({ title: '识别失败', content: (err && err.message) || '请重试', showCancel: false })
        }
      })
  },

  loadUsers() {
    this.setData({ usersLoading: true })
    cloud.call('login', { action: 'listUsers' })
      .then(r => {
        this.setData({ usersLoading: false, users: r.users || [], usersTotal: r.total || 0 })
      })
      .catch(e => {
        this.setData({ usersLoading: false })
        this.showErr(e)
      })
  },

  checkIdentity() {
    this.setData({ checking: true })
    cloud.call('importQuestions', { action: 'whoami' })
      .then(r => {
        this.setData({
          checking: false,
          isAdmin: !!(r && r.isAdmin),
          openid: (r && r.openid) || '',
          hint: (r && r.hint) || '',
          bootstrapped: !!(r && r.bootstrapped)
        })
        if (r && r.isAdmin && this.data.tab === 'users') this.loadUsers()
      })
      .catch(e => {
        this.setData({
          checking: false,
          isAdmin: false,
          hint: (e && e.message) || '身份校验失败，请确认已通过小程序云调用'
        })
      })
  },

  onSubject(e) { this.setData({ subject: e.detail.value }) },
  onSubjectTap(e) { this.setData({ subject: e.currentTarget.dataset.s }) },

  copyOpenid() {
    wx.setClipboardData({
      data: this.data.openid,
      success: () => wx.showToast({ title: '已复制 openid', icon: 'none' })
    })
  },

  showErr(e) {
    const msg = (e && (e.message || e.reason)) || '操作失败'
    wx.showModal({ title: '出错了', content: String(msg).slice(0, 200), showCancel: false })
  }
})
