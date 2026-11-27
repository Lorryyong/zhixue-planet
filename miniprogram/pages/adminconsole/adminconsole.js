// pages/adminconsole/adminconsole.js —— 管理端工作台：登录门 + 身份卡 + 数据条 + 入口 + 管理员名单
// 管理员三型：env 系统预置 / appointed 任命（微信直通，无密码）/ session 账号授权（密码登录，7 天有效）。
const cloud = require('../../utils/cloud.js')
const cloudStore = require('../../utils/cloudStore.js')

const KIND_LABEL = { env: '系统预置', appointed: '任命管理员', session: '账号授权' }

Page({
  data: {
    checking: true, isAdmin: false, busy: false,
    username: 'admin', password: '',
    kind: '', kindLabel: '', expiresText: '', sourceText: '',
    meName: '', meAvatar: '', myOpenid: '',
    stats: { users: 0, groups: 0, feedback: 0 },
    accounts: [], admins: []
  },
  onShow() { this.check() },

  check() {
    this.setData({ checking: true })
    cloud.call('adminAuth', { action: 'check' })
      .then(r => {
        const ok = !!(r && r.isAdmin)
        const kind = (r && r.kind) || ''
        let expiresText = ''
        if (kind === 'session' && r.expiresAt) {
          const d = new Date(r.expiresAt)
          expiresText = '有效期至 ' + (d.getMonth() + 1) + '月' + d.getDate() + '日'
        }
        this.setData({
          checking: false, isAdmin: ok, kind,
          kindLabel: KIND_LABEL[kind] || '',
          expiresText, myOpenid: (r && r.openid) || ''
        })
        if (ok) this.loadWorkbench()
      })
      .catch(() => this.setData({ checking: false, isAdmin: false }))
  },

  // 工作台数据：管理员名单（含我的展示信息）+ 三个真实计数，互不阻塞
  loadWorkbench() {
    cloud.call('adminAuth', { action: 'listAdmins' })
      .then(r => {
        const admins = ((r && r.admins) || []).map(a => {
          let expiresText = ''
          if (a.expires_at) {
            const d = new Date(a.expires_at)
            expiresText = '至 ' + (d.getMonth() + 1) + '月' + d.getDate() + '日'
          }
          return Object.assign({}, a, { expiresText })
        })
        const me = admins.find(a => a.openid === this.data.myOpenid) || {}
        let sourceText = ''
        if (this.data.kind === 'appointed') {
          sourceText = me.appointedByName
            ? '由 ' + me.appointedByName + ' 任命'
            : (me.appointedBy ? '由管理员任命' : '管理员任命')
        } else if (this.data.kind === 'session') {
          sourceText = '通过管理员账号登录授权'
        } else if (this.data.kind === 'env') {
          sourceText = '由系统环境变量预置'
        }
        this.setData({
          accounts: (r && r.accounts) || [], admins,
          meName: me.nickname || '', meAvatar: me.avatar || '', sourceText
        })
      })
      .catch(() => {})
    cloud.call('login', { action: 'listUsers' })
      .then(r => this.setData({ 'stats.users': (r && r.total) || 0 }))
      .catch(() => {})
    cloudStore.listAllSources()
      .then(r => this.setData({ 'stats.groups': ((r && r.groups) || []).length }))
      .catch(() => {})
    cloudStore.listFeedback('pending')
      .then(r => this.setData({ 'stats.feedback': ((r && r.list) || []).length }))
      .catch(() => {})
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
        this.setData({ busy: false, password: '' })
        wx.showToast({ title: '登录成功', icon: 'success' })
        this.check()
      })
      .catch(e => {
        this.setData({ busy: false })
        wx.showModal({ title: '登录失败', content: (e && e.message) || '账号或密码不正确', showCancel: false })
      })
  },

  onLogout() {
    wx.showModal({
      title: '退出管理端', content: '退出后本次账号授权立即失效，确定吗？',
      success: (res) => {
        if (!res.confirm) return
        cloud.call('adminAuth', { action: 'logout' })
          .then(() => {
            this.setData({ isAdmin: false, kind: '', accounts: [], admins: [] })
            wx.showToast({ title: '已退出', icon: 'success' })
          })
          .catch(e => wx.showToast({ title: (e && e.message) || '退出失败', icon: 'none' }))
      }
    })
  },

  onAbandon() {
    wx.showModal({
      title: '放弃管理员身份',
      content: '放弃后你将立即失去管理权限，需要其他管理员重新任命才能恢复。确定吗？',
      confirmText: '放弃', confirmColor: '#d92d20',
      success: (res) => {
        if (!res.confirm) return
        cloud.call('adminAuth', { action: 'abandonAdmin' })
          .then(() => {
            this.setData({ isAdmin: false, kind: '', accounts: [], admins: [] })
            wx.showToast({ title: '已放弃管理员身份', icon: 'success' })
          })
          .catch(e => wx.showModal({ title: '无法放弃', content: (e && e.message) || '操作失败', showCancel: false }))
      }
    })
  },

  // 名单里取消他人的管理员（护栏在云端：至少保留 1 名、env 不可取消）
  onCancelAdmin(e) {
    const oid = e.currentTarget.dataset.openid
    const name = e.currentTarget.dataset.name || '该用户'
    wx.showModal({
      title: '取消管理员',
      content: '取消「' + name + '」的管理员权限？TA 将立即失去管理权限。',
      confirmText: '取消权限', confirmColor: '#d92d20',
      success: (res) => {
        if (!res.confirm) return
        cloud.call('adminAuth', { action: 'setAdmin', targetOpenid: oid, admin: false })
          .then(() => {
            wx.showToast({ title: '已取消', icon: 'success' })
            this.loadWorkbench()
          })
          .catch(err => wx.showModal({ title: '取消失败', content: (err && err.message) || '操作失败', showCancel: false }))
      }
    })
  },

  goImport() { wx.navigateTo({ url: '/pages/admin/admin' }) },
  goLibrary() { wx.navigateTo({ url: '/pages/admin/admin?tab=library' }) },
  goFeedback() { wx.navigateTo({ url: '/pages/feedback/feedback' }) },
  goUsers() { wx.navigateTo({ url: '/pages/admin/admin?tab=users' }) }
})
