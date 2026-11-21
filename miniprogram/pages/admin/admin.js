// pages/admin/admin.js —— 题库批量导入（管理员）
const cloud = require('../../utils/cloud.js')

const JSON_SAMPLE = [
  {
    id: 'm001',
    stem: '已知 x²−5x+6=0，则两根之和为（　）',
    options: ['5', '-5', '6', '-6'],
    answer: 0,
    analysis: '由韦达定理，两根之和 = −b/a = 5。',
    knowledge_tags: ['k2'],
    difficulty: 3
  },
  {
    id: 'm002',
    stem: '圆 O 的半径为 5，点 P 在圆上，则 OP =（　）',
    options: ['5', '10', '25', '2.5'],
    answer: 0,
    analysis: '圆上任意点到圆心距离等于半径。',
    knowledge_tags: ['k6'],
    difficulty: 2
  }
]

const CSV_SAMPLE = [
  'stem,options,answer,analysis,knowledge_tags,subject',
  '等腰三角形顶角80°，底角为（　）,50°|80°|100°|40°,0,(180−80)/2=50°,k1,数学',
  '直线 y=2x+1 的斜率为（　）,1|2|-2|0,1,一次函数 y=kx+b 中 k 为斜率,k5,数学'
].join('\n')

Page({
  data: {
    checking: true,
    isAdmin: false,
    openid: '',
    hint: '',
    format: 'json',          // json | csv
    inputText: '',
    subject: '数学',
    syncToExisting: false,
    preview: null,           // { total, valid, invalid, invalidDetails, sample }
    result: null,            // commit 结果
    busy: false
  },

  onLoad() { this.checkIdentity() },

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
