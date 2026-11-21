const store = require('../../utils/store.js')
const cloudStore = require('../../utils/cloudStore.js')
const cloud = require('../../utils/cloud.js')
Page({
  data: {},
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
  chooseImage() {
    // 拍照/相册：视觉模型识别效果最佳（图片 base64 < 5MB）
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['camera', 'album'], sizeType: ['compressed'],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0]
        if (f) this.doRecognize(f.tempFilePath, '试卷图片.' + (/\.png$/i.test(f.tempFilePath) ? 'png' : 'jpg'))
      },
      fail: () => {}
    })
  },
  chooseFile() {
    wx.chooseMessageFile({
      count: 1, type: 'file',
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0]
        this.doRecognize(f ? f.path : null, f ? f.name : null)
      },
      fail: () => {}
    })
  },
  loadSample() { this.doRecognize(null, null) },
  doRecognize(filePath, fileName) {
    wx.showLoading({ title: 'AI 识别中…' })
    const done = (fromCloud, engine) => {
      wx.hideLoading()
      wx.navigateTo({ url: '/pages/check/check' })
      wx.showToast({
        title: engine === 'ai' ? 'AI 识别完成，请校对' : (fromCloud ? '已用示例题体验识别' : '已载入示例试卷'),
        icon: 'none'
      })
    }
    const fallback = () => {
      // 云不可用 → 本地模拟识别（保证 Demo 始终可跑）
      setTimeout(() => {
        store.loadSamplePaper(store.getState())
        done(false, 'demo')
      }, 1000)
    }
    // 优先云端识别（题目直接写入 PG，待人工校对）；未开通云自动降级
    if (!cloud.isCloudReady()) { fallback(); return }
    cloudStore.recognize(filePath, fileName || '示例试卷.pdf', '数学')
      .then(res => {
        const qs = res && res.questions
        if (!qs || !qs.length) { fallback(); return }
        store.loadCloudPaper(store.getState(), qs, {
          title: fileName || 'AI识别·云试卷', subject: res.subject || '数学',
          paperId: res.paperId
        })
        done(true, res.engine)
      })
      .catch(err => {
        // 频率限制/身份异常等业务拒绝：明确告知，不静默降级
        if (err && (err.code === -429 || (err.message && err.message.indexOf('上限') >= 0))) {
          wx.hideLoading()
          wx.showModal({ title: '识别受限', content: err.message || '今日识别次数已达上限', showCancel: false })
          return
        }
        fallback()
      })
  },
  onPaper(e) {
    if (e.currentTarget.dataset.status === 'pending') wx.navigateTo({ url: '/pages/check/check' })
    else wx.showToast({ title: '已入库试卷', icon: 'none' })
  }
})
