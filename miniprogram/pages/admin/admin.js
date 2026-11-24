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
    tab: 'import',           // import=题库导入 | users=用户管理 | library=试卷管理（管理端入口带 tab 进入）
    importing: false,        // 文件导入进行中
    users: [], usersTotal: 0, usersLoading: false,
    libGroups: [], libTotalRows: 0, libLoading: false,
    libShown: [],                       // 筛选后展示的分组（带科目图标）
    libSubjectOptions: [],              // 科目选项（按首页科目顺序）
    libSelSubject: {}, libSubjectAll: true,   // 科目多选（空=全部）
    libFilterScope: '',                 // '' 全部 | system | user
    libScopeOptions: [
      { value: '', label: '全部' },
      { value: 'system', label: '系统试卷' },
      { value: 'user', label: '我的试卷' }
    ],
    libOpenKey: '', libQuestions: [], libQLoading: false,
    subjects: ['数学', '英语', '物理', '化学', '语文', '生物', '历史', '政治'],
    subject: '数学',
    bootstrapped: false
  },

  onLoad(options) {
    const t = options && options.tab
    const tab = t === 'users' ? 'users' : (t === 'library' ? 'library' : 'import')
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
      title: title || '系统试卷导入', subject: res.subject || '数学', paperId: res.paperId
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
            this._enterCheck(r, f.name || '系统试卷Excel导入', 'excel')
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
        if (r && r.isAdmin && this.data.tab === 'library') this.loadLibrary()
      })
      .catch(e => {
        this.setData({
          checking: false,
          isAdmin: false,
          hint: (e && e.message) || '身份校验失败，请确认已通过小程序云调用'
        })
      })
  },

  // ===== 试卷管理：全库试卷分组 + 逐题删除 + 转为系统（管理员可操作全部，云端校验） =====
  loadLibrary() {
    this.setData({ libLoading: true })
    cloudStore.listAllSources()
      .then(r => {
        const VIS = {
          '语文': { icon: '📖', bg: '#fdecec' }, '数学': { icon: '📐', bg: '#e6ebff' },
          '英语': { icon: '🔤', bg: '#e8f6ff' }, '物理': { icon: '🧲', bg: '#e9f7f1' },
          '化学': { icon: '🧪', bg: '#f0eafd' }, '生物': { icon: '🌿', bg: '#e7f8e9' },
          '历史': { icon: '📜', bg: '#fdf3e0' }, '地理': { icon: '🌍', bg: '#e4f5fb' },
          '道德与法治': { icon: '⚖️', bg: '#fdeef4' }, '道法': { icon: '⚖️', bg: '#fdeef4' }
        }
        const groups = (r.groups || []).map(g => {
          const v = VIS[g.subject] || { icon: '📄', bg: '#eef0ff' }
          return Object.assign({}, g, { icon: v.icon, iconBg: v.bg })
        })
        // 科目筛选选项按首页顺序排
        const ORDER = ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '地理', '道德与法治']
        const oi = (n) => { const i = ORDER.indexOf(n === '道法' ? '道德与法治' : n); return i < 0 ? ORDER.length : i }
        const subjects = Array.from(new Set(groups.map(g => g.subject))).sort((a, b) => oi(a) - oi(b))
        this.setData({ libLoading: false, libGroups: groups, libSubjectOptions: subjects, libTotalRows: r.totalRows || 0, libOpenKey: '', libQuestions: [] })
        this._applyLibFilter()
      })
      .catch(e => {
        this.setData({ libLoading: false })
        this.showErr(e)
      })
  },

  // 筛选逻辑与试卷中心一致：科目多选（空=全部）、范围单选；仅影响展示，不改任何功能逻辑
  _applyLibFilter() {
    const sel = this.data.libSelSubject || {}
    const hasSel = Object.keys(sel).some(k => sel[k])
    const scope = this.data.libFilterScope || ''
    const shown = (this.data.libGroups || []).filter(g => {
      if (hasSel && !sel[g.subject]) return false
      if (scope && g.scope !== scope) return false
      return true
    })
    this.setData({ libShown: shown, libSubjectAll: !hasSel })
  },

  onLibFilterSubject(e) {
    const v = e.currentTarget.dataset.v
    if (!v) { this.setData({ libSelSubject: {} }); this._applyLibFilter(); return }
    const sel = Object.assign({}, this.data.libSelSubject)
    if (sel[v]) delete sel[v]; else sel[v] = true
    this.setData({ libSelSubject: sel })
    this._applyLibFilter()
  },

  onLibFilterScope(e) {
    this.setData({ libFilterScope: e.currentTarget.dataset.v || '' })
    this._applyLibFilter()
  },

  resetLibFilter() {
    this.setData({ libSelSubject: {}, libFilterScope: '' })
    this._applyLibFilter()
  },

  onLibGroupTap(e) {
    const key = e.currentTarget.dataset.key
    if (this.data.libOpenKey === key) { this.setData({ libOpenKey: '', libQuestions: [] }); return }
    const g = this.data.libGroups.find(x => x.key === key)
    if (!g) return
    this.setData({ libOpenKey: key, libQLoading: true, libQuestions: [] })
    cloudStore.listGroupQuestions(g.subject, g.original, g.scope, g.studentId || undefined)
      .then(r => this.setData({ libQLoading: false, libQuestions: r.questions || [] }))
      .catch(err => {
        this.setData({ libQLoading: false })
        this.showErr(err)
      })
  },

  onLibDelSource(e) {
    const key = e.currentTarget.dataset.key
    const g = this.data.libGroups.find(x => x.key === key)
    if (!g) return
    const isSystem = g.scope === 'system'
    wx.showModal({
      title: '删除试卷',
      content: isSystem
        ? '系统试卷「' + g.original + '」（' + g.subject + '，' + g.uniqueCount + ' 题）将从公共题库和所有用户处删除，不可恢复。确定吗？'
        : '确定删除该用户上传的「' + g.original + '」（' + g.subject + '，' + g.uniqueCount + ' 题）吗？不可恢复。',
      confirmText: '删除', confirmColor: '#d92d20',
      success: (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '删除中…' })
        cloudStore.deleteSource(g.subject, g.original, g.scope, g.studentId || undefined)
          .then(r => {
            wx.hideLoading()
            wx.showToast({ title: '已删除 ' + (r.deleted || 0) + ' 行', icon: 'success' })
            this.loadLibrary()
          })
          .catch(err => {
            wx.hideLoading()
            this.showErr(err)
          })
      }
    })
  },

  onLibPromote(e) {
    const key = e.currentTarget.dataset.key
    const g = this.data.libGroups.find(x => x.key === key)
    if (!g) return
    wx.showModal({
      title: '转为系统试卷',
      content: '把该用户上传的「' + g.original + '」（' + g.subject + '，' + g.uniqueCount + ' 题）转为系统试卷？转换后将进入公共试卷库并分发给所有用户，该用户自己的副本也转为系统试卷。',
      confirmText: '转为系统', confirmColor: '#5b6cf6',
      success: (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '转换中…' })
        cloudStore.promoteSourceToSystem(g.subject, g.original, g.studentId || undefined)
          .then(r => {
            wx.hideLoading()
            wx.showModal({ title: '转换完成', content: r.message || '已转为系统试卷', showCancel: false })
            this.loadLibrary()
          })
          .catch(err => {
            wx.hideLoading()
            this.showErr(err)
          })
      }
    })
  },

  onLibDelQuestion(e) {
    const id = e.currentTarget.dataset.id
    const g = this.data.libGroups.find(x => x.key === this.data.libOpenKey)
    wx.showModal({
      title: '删除题目',
      content: g && g.scope === 'system'
        ? '这是系统题，删除后所有用户的该题副本都会被移除，不可恢复。确定吗？'
        : '确定删除这道题吗？不可恢复。',
      confirmText: '删除', confirmColor: '#d92d20',
      success: (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '删除中…' })
        cloudStore.deleteQuestion(id)
          .then(r => {
            wx.hideLoading()
            wx.showToast({ title: r.deleted > 1 ? '已删除（含副本 ' + r.deleted + ' 行）' : '已删除', icon: 'success' })
            this.setData({ libQuestions: this.data.libQuestions.filter(q => q.id !== id) })
          })
          .catch(err => {
            wx.hideLoading()
            this.showErr(err)
          })
      }
    })
  },

  onSubjectTap(e) { this.setData({ subject: e.currentTarget.dataset.s }) },

  showExcelHelp() {
    wx.showModal({
      title: 'Excel 列头格式',
      content: '第一行列名：stem,q_type,options,answer,analysis,knowledge_tags,subject,score,original,year,grade,region。\n\n选项 / 答案 / 标签用 | 分隔；题型 q_type 支持 single/multiple/judge/blank/solve/calculation/reading/experiment/translation/essay。\n\n题目自带 subject 列时以列值为准，否则用上方「默认学科」。',
      showCancel: false,
      confirmText: '知道了'
    })
  },

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
