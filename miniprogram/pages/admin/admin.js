// pages/admin/admin.js —— 题库批量导入（管理员，支持中考全题型；文件导入走校对后发布为系统题）
const cloud = require('../../utils/cloud.js')
const cloudStore = require('../../utils/cloudStore.js')
const store = require('../../utils/store.js')

// 题型别名见 questionTypes.js：single/multiple/judge/blank/solve/calculation/reading/experiment/translation/essay
// 也支持中考叫法：完形填空→单选、默写→填空、书面表达→作文、证明→解答 等
const JSON_SAMPLE = [
  {
    id: 'm001', q_type: 'single',
    stem: '已知 x²−5x+6=0，则两根之和为（　）',
    options: ['5', '-5', '6', '-6'], answer: 0,
    analysis: '由韦达定理，两根之和 = −b/a = 5。', knowledge_tags: ['k2'], difficulty: 3
  },
  {
    id: 'm002', q_type: 'multiple',
    stem: '下列各数中，是无理数的有（　）',
    options: ['√2', '0.5', 'π', '3'], answer: [0, 2],
    analysis: '√2 与 π 为无理数。', knowledge_tags: ['k8'], difficulty: 3
  },
  {
    id: 'm003', q_type: 'blank',
    stem: '一元二次方程 x²−5x+6=0 的两根之和为______，两根之积为______。',
    options: [], answer: ['5', '6'],
    analysis: '韦达定理：和5、积6。多空用数组，每空多个可接受值用 | 分隔，如 "5|five"。',
    knowledge_tags: ['k2'], difficulty: 3
  },
  {
    id: 'm004', q_type: 'solve',
    stem: '已知二次函数 y=x²−2x−3。（1）求与 x 轴交点；（2）写出顶点坐标。',
    options: [], answer: '令y=0得x=−1或3，交点(−1,0)、(3,0)；配方y=(x−1)²−4，顶点(1,−4)。',
    scoring_points: [{ point: '求出与x轴两个交点', score: 5 }, { point: '写出顶点坐标(1,−4)', score: 5 }],
    score: 10, analysis: '考查二次函数图象与坐标轴交点及顶点。', knowledge_tags: ['k4'], difficulty: 4
  },
  {
    id: 'm005', q_type: 'essay', subject: '语文',
    stem: '以「那一次，我懂得了______」为题，写一篇不少于600字的记叙文。',
    options: [], answer: '（作文无唯一答案，AI 按立意、内容、结构、语言四维评分）',
    scoring_points: [{ point: '立意切题、中心明确', score: 10 }, { point: '内容具体、感情真挚', score: 15 }, { point: '结构完整、条理清晰', score: 10 }, { point: '语言通顺、表达生动', score: 5 }],
    score: 40, analysis: '中考记叙文评分参考。', knowledge_tags: ['语文-写作'], difficulty: 4
  }
]

// CSV 新增 q_type / score / scoring_points 列；scoring_points 用 "要点:分|要点:分"
const CSV_SAMPLE = [
  'stem,q_type,options,answer,analysis,knowledge_tags,subject,score,scoring_points',
  '等腰三角形顶角80°，底角为（　）,single,50°|80°|100°|40°,0,(180−80)/2=50°,k1,数学,2,',
  '一元二次方程 x²−5x+6=0 两根之和为______,blank,,5,韦达定理,k2,数学,2,',
  '求抛物线 y=x²−2x−3 的顶点坐标,solve,,(1,−4),配方得顶点式,k4,数学,5,"求顶点横坐标:2|求顶点纵坐标:3"'
].join('\n')

Page({
  data: {
    checking: true,
    isAdmin: false,
    openid: '',
    hint: '',
    tab: 'import',           // import=题库导入 | users=用户管理
    importMode: 'file',      // file=文件导入(拍照/PDF/Excel,走校对) | paste=JSON/CSV粘贴(直接入库)
    importing: false,        // 文件导入进行中
    users: [], usersTotal: 0, usersLoading: false,
    format: 'json',          // json | csv
    inputText: '',
    subjects: ['数学', '英语', '物理', '化学', '语文', '生物', '历史', '政治'],
    subject: '数学',
    syncToExisting: false,
    preview: null,           // { total, valid, invalid, invalidDetails, sample }
    result: null,            // commit 结果
    busy: false
  },

  onLoad(options) {
    const tab = (options && options.tab) === 'users' ? 'users' : 'import'
    this.setData({ tab })
    this.checkIdentity()
  },

  onTab(e) {
    const tab = e.currentTarget.dataset.t
    this.setData({ tab })
    if (tab === 'users' && this.data.isAdmin) this.loadUsers()
  },

  onImportMode(e) {
    this.setData({ importMode: e.currentTarget.dataset.m })
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

  downloadSample() {
    const rows = [
      ['stem', 'q_type', 'options', 'answer', 'analysis', 'knowledge_tags', 'subject', 'score', 'original', 'year', 'grade', 'region'],
      ['若 a−b=3，ab=2，则 a²+b² 的值为（　）', 'single', '5|9|13|11', '2', 'a²+b²=(a−b)²+2ab=13', '整式乘法|完全平方', '数学', '2', '2024北京中考真题', '2024', '初三', '北京'],
      ['计算：2x+3=7，则 x=___', 'blank', '', '2', '移项得 x=2', '一元一次方程', '数学', '3', '人教版七上', '', '初一', '']
    ]
    const csv = '\ufeff' + rows.map(row => row.map(function (cell) {
      const s = String(cell == null ? '' : cell)
      return /[,\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
    }).join(',')).join('\n')
    const fs = wx.getFileSystemManager()
    const path = wx.env.USER_DATA_PATH + '/系统题库导入样例.csv'
    try {
      fs.writeFileSync(path, csv, 'utf8')
      if (wx.shareFileMessage) {
        wx.shareFileMessage({ filePath: path, fileName: '系统题库导入样例.csv', fail: () => {}, success: () => {} })
      } else {
        wx.showModal({ title: '样例已生成', content: '列头：stem,q_type,options,answer,analysis,knowledge_tags,subject,score,original,year,grade,region', showCancel: false })
      }
    } catch (e) {
      wx.showModal({ title: '样例列头', content: 'stem,q_type,options,answer,analysis,knowledge_tags,subject,score,original,year,grade,region（选项/答案/标签用 | 分隔）', showCancel: false })
    }
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

  onFormatChange(e) {
    const format = e.currentTarget.dataset.f
    const inputText = format === 'json' ? JSON.stringify(JSON_SAMPLE, null, 2) : CSV_SAMPLE
    this.setData({ format, inputText, preview: null, result: null })
  },

  onInput(e) { this.setData({ inputText: e.detail.value }) },
  onSubject(e) { this.setData({ subject: e.detail.value }) },
  onSubjectTap(e) { this.setData({ subject: e.currentTarget.dataset.s }) },
  onSync(e) { this.setData({ syncToExisting: e.detail.value }) },

  fillSample() {
    const inputText = this.data.format === 'json'
      ? JSON.stringify(JSON_SAMPLE, null, 2)
      : CSV_SAMPLE
    this.setData({ inputText, preview: null, result: null })
  },

  doPreview() {
    const text = (this.data.inputText || '').trim()
    if (!text) { wx.showToast({ title: '请先粘贴题目数据', icon: 'none' }); return }
    this.setData({ busy: true, preview: null, result: null })
    cloud.call('importQuestions', {
      action: 'preview', text, format: this.data.format, subject: this.data.subject
    })
      .then(r => {
        this.setData({ busy: false, preview: r })
        if (r.invalid) wx.showToast({ title: '校验完成，请查看结果', icon: 'none' })
      })
      .catch(e => {
        this.setData({ busy: false })
        this.showErr(e)
      })
  },

  doCommit() {
    const text = (this.data.inputText || '').trim()
    if (!text) { wx.showToast({ title: '请先粘贴题目数据', icon: 'none' }); return }
    const tip = this.data.syncToExisting
      ? '确认导入并重同步给所有已有用户？可能需要几秒。'
      : '确认将题目写入公共题库？新用户下次进入会自动获得。'
    wx.showModal({
      title: '确认导入', content: tip,
      success: (res) => {
        if (!res.confirm) return
        this.setData({ busy: true, result: null })
        cloud.call('importQuestions', {
          action: 'commit', text, format: this.data.format,
          subject: this.data.subject, syncToExisting: this.data.syncToExisting
        })
          .then(r => {
            this.setData({ busy: false, result: r })
            if (r.failed === 0 && r.invalid === 0) {
              wx.showToast({ title: '导入成功', icon: 'success' })
            }
          })
          .catch(e => {
            this.setData({ busy: false })
            this.showErr(e)
          })
      }
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
