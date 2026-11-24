// pages/adminconsole/adminconsole.js —— 管理端：鉴权登录 + 三个管理功能入口
const cloud = require('../../utils/cloud.js')

Page({
  data: {
    checking: true, isAdmin: false, busy: false,
    username: 'admin', password: '', accounts: []
  },
  onShow() { this.check() },

  check() {
    this.setData({ checking: true })
    cloud.call('adminAuth', { action: 'check' })
      .then(r => {
        const ok = !!(r && r.isAdmin)
        this.setData({ checking: false, isAdmin: ok })
        if (ok) this.loadAccounts()
      })
      .catch(() => this.setData({ checking: false, isAdmin: false }))
  },

  onUser(e) { this.setData({ username: e.detail.value }) },
  onPass(e) { this.setData({ password: e.detail.value }) },

  onLogin() {
    if (this.data.busy) return
    if (!this.data.username.trim() || !this.data.password) {
      wx.showToast({ title: '请输入账号和密码', icon: 'none' }); return
    }
    this.setData({ busy: true })
    cloud.call('adminAuth', { action: 'login', username: this.data.username.trim(), password: this.data.password })
      .then(() => {
        this.setData({ busy: false, password: '', isAdmin: true })
        wx.showToast({ title: '登录成功', icon: 'success' })
        this.loadAccounts()
      })
      .catch(e => {
        this.setData({ busy: false })
        wx.showModal({ title: '登录失败', content: (e && e.message) || '账号或密码不正确', showCancel: false })
      })
  },

  onLogout() {
    wx.showModal({
      title: '退出管理端', content: '退出后本机将失去管理权限，确定吗？',
      success: (res) => {
        if (!res.confirm) return
        cloud.call('adminAuth', { action: 'logout' })
          .then(() => {
            this.setData({ isAdmin: false, accounts: [] })
            wx.showToast({ title: '已退出', icon: 'success' })
          })
          .catch(e => wx.showToast({ title: (e && e.message) || '退出失败', icon: 'none' }))
      }
    })
  },

  loadAccounts() {
    cloud.call('adminAuth', { action: 'listAccounts' })
      .then(r => this.setData({ accounts: (r && r.accounts) || [] }))
      .catch(() => {})
  },

  goImport() { wx.navigateTo({ url: '/pages/admin/admin' }) },
  goLibrary() { wx.navigateTo({ url: '/pages/admin/admin?tab=library' }) },
  goFeedback() { wx.navigateTo({ url: '/pages/feedback/feedback' }) },
  goUsers() { wx.navigateTo({ url: '/pages/admin/admin?tab=users' }) }
})
