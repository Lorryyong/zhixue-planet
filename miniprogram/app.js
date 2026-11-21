// app.js
const store = require('./utils/store.js')

App({
  onLaunch() {
    // 1) 初始化本地种子数据（本地 Demo 模式始终可用）
    store.getState()
    // 2) 初始化云开发（开通云开发后可联调云函数；未开通时不影响本地 Demo）
    this.initCloud()
  },
  // 云开发初始化：主链路已走 HTTP 网关（见 utils/cloud.js），wx.cloud 仅用于
  // 「上传 PDF/图片拿 fileID」。此处失败不影响答题闭环，静默降级即可。
  initCloud() {
    if (!wx.cloud) {
      console.info('[智学星球] 当前基础库不支持 wx.cloud，HTTP 主链路不受影响')
      return
    }
    try {
      wx.cloud.init({
        // PG 环境 ID；仅用于云存储上传，HTTP 网关调用不依赖它
        env: 'progressive-zupu-d8eb6lsc7ee9feb',
        traceUser: true
      })
      this.globalData.cloudUploadReady = true
      console.info('[智学星球] wx.cloud 已初始化（仅用于文件上传）')
    } catch (e) {
      this.globalData.cloudUploadReady = false
      console.warn('[智学星球] wx.cloud 初始化失败，文件上传降级', e)
    }
  },
  globalData: { cloudUploadReady: false }
})
