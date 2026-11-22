const store = require('../../utils/store.js')
const cloudStore = require('../../utils/cloudStore.js')
const cloud = require('../../utils/cloud.js')

// Excel 导入样例（列头 + 全题型示例），与云函数 excelParser.SAMPLE_ROWS 一致
const SAMPLE_ROWS = [
  ['stem', 'q_type', 'options', 'answer', 'analysis', 'knowledge_tags', 'subject', 'score', 'scoring_points'],
  ['若 a−b=3，ab=2，则 a²+b² 的值为（　）', 'single', '5|9|13|11', '2', 'a²+b²=(a−b)²+2ab=13', '整式乘法|完全平方', '数学', '2', ''],
  ['下列数中为无理数的是（　）', 'multiple', '√2|0.5|π|3', '0|2', '√2 与 π 是无理数', '实数', '数学', '3', ''],
  ['全等三角形的对应边相等。', 'judge', '正确|错误', '1', '全等三角形对应边相等', '全等三角形', '数学', '2', ''],
  ['计算：2x+3=7，则 x=___', 'blank', '', '2', '移项得 x=2', '一元一次方程', '数学', '3', ''],
  ['已知 AB=AC，∠A=60°，求证△ABC 是等边三角形。', 'solve', '', '∵AB=AC 且∠A=60°，∴∠B=∠C=60°，故为等边三角形', '有一个角60°的等腰三角形是等边三角形', '等边三角形', '数学', '10', '说明AB=AC:3|得出∠B=∠C=60°:3|结论等边:4']
]

Page({
  data: {
    importing: false
  },
  onShow() { this.refresh() },
  refresh() {
    const s = store.getState()
    this.setData({
      papers: s.papers.map(p => Object.assign({}, p, {
        statusLabel: p.status === 'confirmed' ? '已确认' : (p.status === 'pending' ? '待校对' : '识别中'),
        statusClass: p.status === 'confirmed' ? 'g' : (p.status === 'pending' ? 'y' : 'r')
      })),
      confirmedCount: s.papers.filter(p => p.status === 'confirmed').length
    })
  },

  // ===== 方式一：拍照 / 选图识别 =====
  chooseImage() {
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['camera', 'album'], sizeType: ['compressed'],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0]
        if (f) this.doRecognize(f.tempFilePath, '试卷图片.' + (/\.png$/i.test(f.tempFilePath) ? 'png' : 'jpg'))
      },
      fail: () => {}
    })
  },

  // ===== 方式二：PDF 识别 =====
  chooseFile() {
    wx.chooseMessageFile({
      count: 1, type: 'file', extension: ['pdf'],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0]
        if (f) this.doRecognize(f.path, f.name)
      },
      fail: () => {}
    })
  },

  loadSample() { this.doRecognize(null, null) },

  // 进入待确认清单（check 页）
  gotoCheck(engine, title) {
    wx.navigateTo({ url: '/pages/check/check' })
    wx.showToast({
      title: engine === 'ai' ? 'AI 识别完成，请逐题校对' : (engine === 'excel' ? '导入完成，请逐题校对' : (title ? '已载入示例试卷' : '请校对')),
      icon: 'none'
    })
  },

  doRecognize(filePath, fileName) {
    wx.showLoading({ title: 'AI 识别中…' })
    const fallback = () => {
      setTimeout(() => {
        store.loadSamplePaper(store.getState())
        wx.hideLoading()
        this.gotoCheck('demo')
      }, 1000)
    }
    if (!cloud.isCloudReady()) { fallback(); return }
    cloudStore.recognize(filePath, fileName || '示例试卷.pdf', '数学')
      .then(res => {
        const qs = res && res.questions
        wx.hideLoading()
        if (!qs || !qs.length) { fallback(); return }
        store.loadCloudPaper(store.getState(), qs, {
          title: fileName || 'AI识别·云试卷', subject: res.subject || '数学', paperId: res.paperId
        })
        this.gotoCheck(res.engine)
      })
      .catch(err => {
        wx.hideLoading()
        if (err && (err.code === -429 || (err.message && err.message.indexOf('上限') >= 0))) {
          wx.showModal({ title: '识别受限', content: err.message || '今日识别次数已达上限', showCancel: false })
          return
        }
        fallback()
      })
  },

  // ===== 方式三：Excel 批量导入 =====
  chooseExcel() {
    if (this.data.importing) return
    wx.chooseMessageFile({
      count: 1, type: 'file', extension: ['xlsx', 'xls', 'csv'],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0]
        if (!f) return
        this.setData({ importing: true })
        wx.showLoading({ title: '解析 Excel 中…' })
        if (!cloud.isCloudReady()) {
          wx.hideLoading(); this.setData({ importing: false })
          wx.showModal({ title: '需要云开发', content: 'Excel 导入需先开通云开发并部署云函数', showCancel: false })
          return
        }
        cloudStore.importExcel(f.path, f.name, '数学')
          .then(r => {
            wx.hideLoading(); this.setData({ importing: false })
            store.loadCloudPaper(store.getState(), r.questions, {
              title: f.name || 'Excel导入', subject: r.subject || '数学', paperId: r.paperId
            })
            this.gotoCheck('excel')
            if (r.invalid && r.invalid.length) {
              setTimeout(() => wx.showModal({
                title: '部分行未导入',
                content: '共 ' + r.total + ' 行，' + r.invalid.length + ' 行格式有误已跳过（如答案下标越界、缺答案）。已进入校对页，请核对已导入题目。',
                showCancel: false
              }), 600)
            }
          })
          .catch(err => {
            wx.hideLoading(); this.setData({ importing: false })
            if (err && err.code === -2 && err.invalid) {
              wx.showModal({ title: '未导入有效题目', content: (err.message || '') + '\n\n首行错误：' + (err.invalid[0].error || ''), showCancel: false })
            } else {
              wx.showModal({ title: '导入失败', content: (err && err.message) || '请检查 Excel 格式', showCancel: false })
            }
          })
      },
      fail: () => {}
    })
  },

  // 下载/查看 Excel 样例：展示样例并保存到本地（Excel 可直接打开 csv）
  downloadSample() {
    const lines = SAMPLE_ROWS.map(row => row.map(function (cell) {
      const s = String(cell == null ? '' : cell)
      return /[,\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
    }).join(','))
    const csv = '\ufeff' + lines.join('\n') // BOM 让 Excel 正确识别中文
    const fs = wx.getFileSystemManager()
    const path = wx.env.USER_DATA_PATH + '/题目导入样例.csv'
    try {
      fs.writeFileSync(path, csv, 'utf8')
      wx.shareFileMessage
        ? wx.shareFileMessage({ filePath: path, fileName: '题目导入样例.csv', fail: () => {}, success: () => {} })
        : wx.showModal({ title: '样例已生成', content: '样例文件已保存到本地：' + path, showCancel: false })
    } catch (e) {
      wx.showModal({ title: '样例内容', content: '列头：stem,q_type,options,answer,analysis,knowledge_tags,subject,score,scoring_points\n（题型：single单选/multiple多选/judge判断/blank填空/solve解答…；选项与答案用 | 分隔）', showCancel: false })
    }
  },

  onPaper(e) {
    if (e.currentTarget.dataset.status === 'pending') wx.navigateTo({ url: '/pages/check/check' })
    else wx.showToast({ title: '已入库试卷', icon: 'none' })
  }
})
