const store = require('../../utils/store.js')
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
    const done = (fromCloud) => {
      wx.hideLoading()
      wx.navigateTo({ url: '/pages/check/check' })
      wx.showToast({ title: fromCloud ? '云函数识别完成' : '已载入示例试卷', icon: 'none' })
    }
    const fallback = () => {
      // 云不可用 → 本地模拟识别（保证 Demo 始终可跑）
      setTimeout(() => {
        store.loadSamplePaper(store.getState())
        done(false)
      }, 1000)
    }
    // 优先调用 recognize 云函数（真机联调 / 生产）；未开通云自动降级
    cloud.call('recognize', {
      fileID: filePath || '',
      fileName: fileName || '示例试卷.pdf',
      subject: '数学'
    }).then(res => {
      const qs = res && res.questions
      if (!qs || !qs.length) { fallback(); return }
      store.loadCloudPaper(store.getState(), qs, {
        title: fileName || 'AI识别·云试卷', subject: res.subject || '数学'
      })
      done(true)
    }).catch(() => fallback())
  },
  onPaper(e) {
    if (e.currentTarget.dataset.status === 'pending') wx.navigateTo({ url: '/pages/check/check' })
    else wx.showToast({ title: '已入库试卷', icon: 'none' })
  }
})
