// pages/admin/admin.js —— 题库批量导入（管理员；仅拍照 / PDF / Excel 三种方式，识别后进入 check 校对页发布为系统题）
const cloud = require('../../utils/cloud.js')
const cloudStore = require('../../utils/cloudStore.js')
const store = require('../../utils/store.js')
const grade = require('../../utils/grade.js')
const spaceLevels = require('../../utils/spaceLevels.js')

// 学科 → 可选教材版本（与学习设置 pages/subjects 的 SUBJECT_BOOKS、云端 recognize 校验表保持一致）
const SUBJECT_BOOKS = {
  '语文': ['人教版', '部编版', '北师大版', '苏教版', '语文版'],
  '数学': ['人教版', '北师大版', '华师大版', '苏科版', '沪科版'],
  '英语': ['人教版', '外研版', '译林版', '沪教版', '北师大版'],
  '物理': ['人教版', '沪科版', '苏科版', '北师大版'],
  '化学': ['人教版', '沪教版', '苏教版', '鲁科版'],
  '生物': ['人教版', '北师大版', '苏教版', '济南版'],
  '历史': ['部编版', '人教版', '北师大版', '华东师大版'],
  '地理': ['人教版', '湘教版', '鲁教版', '苏教版'],
  '道德与法治': ['部编版', '人教版']
}
const META_SUBJECTS = Object.keys(SUBJECT_BOOKS)
const META_GRADES = ['未标注', '小学一年级', '小学二年级', '小学三年级', '小学四年级', '小学五年级', '小学六年级', '七年级', '八年级', '九年级', '高一', '高二', '高三']

Page({
  data: {
    checking: true,
    isAdmin: false,
    openid: '',
    hint: '',
    tab: 'import',           // import=题库导入 | users=用户管理 | library=试卷管理（管理端入口带 tab 进入）
    importing: false,        // 文件导入进行中
    users: [], shownUsers: [], usersTotal: 0, adminTotal: 0, usersLoading: false, usersLoaded: false,
    userQuery: '',
    libLoaded: false, libOwnerFilter: '', libOwnerName: '',
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
    // 试卷元数据编辑（整组）与试题详情/编辑（复用 question-editor 组件，交互与校对页一致）
    libMetaEdit: null,          // {key, subjectOptions, books, gradeOptions, gradeIndex, form:{original,subject,year,grade,region,textbook}}
    libDetailId: '', libDetail: null, libDetailLoading: false,
    qEditing: false, qEditQuestion: null, qSaving: false,
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

  // 页内页签切换（门户带参进入后也可互切；首次切到某页签才加载数据）
  setTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (!tab || tab === this.data.tab) return
    this.setData({ tab })
    if (!this.data.isAdmin) return
    if (tab === 'users' && !this.data.usersLoaded) this.loadUsers()
    if (tab === 'library' && !this.data.libLoaded) this.loadLibrary()
  },

  loadUsers() {
    this.setData({ usersLoading: true })
    cloud.call('login', { action: 'listUsers' })
      .then(r => {
        const KIND = { env: '系统预置', appointed: '管理员', session: '管理员·授权' }
        const d10 = s => s ? String(s).slice(0, 10) : '-'
        const users = (r.users || []).map(u => {
          const gl = grade.currentLabel(u.grade_index, u.grade_base_year)
          const region = [u.province, u.city].filter(Boolean).join(' ')
          let energyLine = ''
          try {
            const lv = spaceLevels.levelOf(u.totalEarned || 0)
            energyLine = 'Lv.' + lv.level + ' ' + lv.name + ' · 能量 ' + (u.energy || 0)
          } catch (e) {}
          return Object.assign({}, u, {
            metaLine: [gl, region].filter(Boolean).join(' · ') || '未设置年级',
            dateLine: '注册 ' + d10(u.createdAt) + ' · 最近登录 ' + d10(u.lastLoginAt),
            energyLine,
            adminKindLabel: KIND[u.adminKind] || '管理员'
          })
        })
        this.setData({
          usersLoading: false, users, usersLoaded: true,
          usersTotal: r.total || users.length, adminTotal: r.adminTotal || 0
        })
        this._applyUserFilter()
      })
      .catch(e => {
        this.setData({ usersLoading: false })
        this.showErr(e)
      })
  },

  _applyUserFilter() {
    const q = (this.data.userQuery || '').trim().toLowerCase()
    const shown = (this.data.users || []).filter(u => {
      if (!q) return true
      return (u.nickname || '').toLowerCase().indexOf(q) >= 0 ||
        (u.openid || '').toLowerCase().indexOf(q) >= 0
    })
    this.setData({ shownUsers: shown })
  },

  onUserQuery(e) {
    this.setData({ userQuery: e.detail.value })
    this._applyUserFilter()
  },

  // 设为管理员：任命后对方用本人微信打开管理端直通，无需密码（云端 adminAuth.setAdmin 落库）
  onSetAdmin(e) {
    const oid = e.currentTarget.dataset.openid
    const name = e.currentTarget.dataset.name || '该用户'
    wx.showModal({
      title: '设为管理员',
      content: '把「' + name + '」设为管理员？TA 用本人微信打开管理端即可直接进入，无需密码；可随时在名单里取消。',
      // 注意：微信 showModal 的 confirmText 最多 4 个字，超长会静默失败（弹窗根本不出现）
      confirmText: '确认设置', confirmColor: '#5b6cf6',
      success: (res) => {
        if (!res.confirm) return
        cloud.call('adminAuth', { action: 'setAdmin', targetOpenid: oid, admin: true })
          .then(() => {
            wx.showToast({ title: '已设为管理员', icon: 'success' })
            this.loadUsers()
          })
          .catch(err => this.showErr(err))
      }
    })
  },

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
            this.loadUsers()
          })
          .catch(err => this.showErr(err))
      }
    })
  },

  // 看某用户的试卷：切到试卷管理并按归属预筛选
  onUserPapers(e) {
    const oid = e.currentTarget.dataset.openid
    const name = e.currentTarget.dataset.name || ''
    this.setData({ tab: 'library', libOwnerFilter: oid, libOwnerName: name })
    if (!this.data.libLoaded) this.loadLibrary()
    else this._applyLibFilter()
  },

  clearLibOwner() {
    this.setData({ libOwnerFilter: '', libOwnerName: '' })
    this._applyLibFilter()
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
        this.setData({ libLoading: false, libLoaded: true, libGroups: groups, libSubjectOptions: subjects, libTotalRows: r.totalRows || 0, libOpenKey: '', libQuestions: [] })
        this._applyLibFilter()
      })
      .catch(e => {
        this.setData({ libLoading: false })
        this.showErr(e)
      })
  },

  // 筛选逻辑与试卷中心一致：科目多选（空=全部）、范围单选；另支持从用户管理带入的归属筛选
  _applyLibFilter() {
    const sel = this.data.libSelSubject || {}
    const hasSel = Object.keys(sel).some(k => sel[k])
    const scope = this.data.libFilterScope || ''
    const owner = this.data.libOwnerFilter || ''
    const shown = (this.data.libGroups || []).filter(g => {
      if (owner && g.studentId !== owner) return false
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

  // ===== 试卷元数据编辑（整组生效：名称/科目/年级/年份/地区/教材类型） =====
  onLibEditMeta(e) {
    const key = e.currentTarget.dataset.key
    const g = this.data.libGroups.find(x => x.key === key)
    if (!g) return
    const subject = META_SUBJECTS.indexOf(g.subject) >= 0 ? g.subject : META_SUBJECTS[0]
    const gradeOptions = META_GRADES
    const gi = Math.max(0, gradeOptions.indexOf(g.grade || '未标注'))
    this.setData({
      libMetaEdit: {
        key,
        subjectOptions: META_SUBJECTS,
        books: SUBJECT_BOOKS[subject] || [],
        gradeOptions, gradeIndex: gi,
        form: {
          original: g.original === '未标注来源' ? '' : g.original,
          subject,
          year: g.year ? String(g.year) : '',
          grade: g.grade || '',
          region: g.region || '',
          textbook: g.textbook || ''
        }
      }
    })
  },

  onMetaClose() { this.setData({ libMetaEdit: null }) },

  onMetaInput(e) {
    const f = e.currentTarget.dataset.f
    const m = Object.assign({}, this.data.libMetaEdit)
    m.form = Object.assign({}, m.form, { [f]: e.detail.value })
    this.setData({ libMetaEdit: m })
  },

  onMetaSubject(e) {
    const subject = e.currentTarget.dataset.v
    const m = Object.assign({}, this.data.libMetaEdit)
    const books = SUBJECT_BOOKS[subject] || []
    const form = Object.assign({}, m.form, { subject })
    if (form.textbook && books.indexOf(form.textbook) < 0) form.textbook = ''
    m.form = form
    m.books = books
    this.setData({ libMetaEdit: m })
  },

  onMetaTextbook(e) {
    const m = Object.assign({}, this.data.libMetaEdit)
    m.form = Object.assign({}, m.form, { textbook: e.currentTarget.dataset.v || '' })
    this.setData({ libMetaEdit: m })
  },

  onMetaGrade(e) {
    const m = Object.assign({}, this.data.libMetaEdit)
    const gi = Number(e.detail.value)
    m.gradeIndex = gi
    m.form = Object.assign({}, m.form, { grade: gi === 0 ? '' : m.gradeOptions[gi] })
    this.setData({ libMetaEdit: m })
  },

  onMetaSave() {
    const m = this.data.libMetaEdit
    if (!m) return
    const g = this.data.libGroups.find(x => x.key === m.key)
    if (!g) return
    const f = m.form
    const patch = {
      original: f.original.trim(), subject: f.subject,
      year: f.year === '' ? 0 : Number(f.year),
      grade: f.grade || '', region: (f.region || '').trim(), textbook: f.textbook || ''
    }
    wx.showLoading({ title: '保存中…' })
    cloud.call('recognize', {
      action: 'updateSourceMeta', subject: g.subject, original: g.original,
      scope: g.scope, targetStudentId: g.studentId || undefined, patch
    }).then(r => {
      wx.hideLoading()
      wx.showToast({ title: '已更新 ' + (r.updated || 0) + ' 行', icon: 'success' })
      this.setData({ libMetaEdit: null })
      this.loadLibrary()
    }).catch(err => {
      wx.hideLoading()
      this.showErr(err)
    })
  },

  // ===== 试题详情与编辑：点题目展开详情（与试卷中心进校对页同一套交互），编辑复用 question-editor 组件 =====
  onLibQuestionTap(e) {
    const id = e.currentTarget.dataset.id
    if (this.data.libDetailId === id) { this.setData({ libDetailId: '', libDetail: null }); return }
    this.setData({ libDetailId: id, libDetail: null, libDetailLoading: true })
    cloud.call('recognize', { action: 'getQuestionDetail', questionId: id })
      .then(r => {
        if (this.data.libDetailId !== id) return
        const q = r.question || {}
        // 详情展示视图：选项带字母、答案转可读文本
        const opts = (q.options || []).map((o, i) => ({ k: String.fromCharCode(65 + i), t: String(o), correct: this._isCorrectOpt(q, i) }))
        this.setData({
          libDetailLoading: false,
          libDetail: Object.assign({}, q, {
            optViews: opts,
            answerText: this._answerText(q),
            typeLabel: q.q_type || '',
            syncNote: q.scope === 'system' ? '系统试卷：保存后同步到该题的全部用户副本' : '仅修改这一条记录'
          })
        })
      })
      .catch(err => {
        this.setData({ libDetailLoading: false, libDetailId: '' })
        this.showErr(err)
      })
  },

  _isCorrectOpt(q, i) {
    const a = q.answer
    if (typeof a === 'number') return a === i
    if (Array.isArray(a)) return a.indexOf(i) >= 0
    return false
  },

  _answerText(q) {
    const a = q.answer
    if (typeof a === 'number') return String.fromCharCode(65 + a)
    if (Array.isArray(a)) {
      if (a.length && typeof a[0] === 'number') return a.map(i => String.fromCharCode(65 + i)).join('、')
      return a.join(' / ')
    }
    return a == null ? '' : String(a)
  },

  onLibQuestionEdit() {
    const d = this.data.libDetail
    if (!d) return
    this.setData({ qEditing: true, qEditQuestion: d, qSaving: false })
  },

  onQEditorCancel() { this.setData({ qEditing: false, qEditQuestion: null, qSaving: false }) },

  onQEditorSave(ev) {
    const patch = ev && ev.detail && ev.detail.patch
    const q = this.data.qEditQuestion
    if (!patch || !q) return
    this.setData({ qSaving: true })
    cloud.call('recognize', { action: 'updateQuestion', questionId: q.id, patch })
      .then((r) => {
        wx.showToast({ title: r && r.synced > 1 ? '已同步 ' + r.synced + ' 份副本' : '已保存', icon: 'success' })
        this.setData({ qEditing: false, qEditQuestion: null, qSaving: false, libDetailId: '', libDetail: null })
        // 题干可能变了：刷新当前展开试卷的题目列表
        const g = this.data.libGroups.find(x => x.key === this.data.libOpenKey)
        if (g) {
          this.setData({ libQLoading: true })
          cloudStore.listGroupQuestions(g.subject, g.original, g.scope, g.studentId || undefined)
            .then(r => this.setData({ libQLoading: false, libQuestions: r.questions || [] }))
            .catch(() => this.setData({ libQLoading: false }))
        }
      })
      .catch(err => {
        this.setData({ qSaving: false })
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
