// app.js
const store = require('./utils/store.js')

App({
  onLaunch() {
    // 1) 初始化本地种子数据（本地 Demo 模式始终可用）
    store.getState()
    // 2) 初始化云开发（开通云开发后可联调云函数；未开通时不影响本地 Demo）
    this.initCloud()
  },
  // 云开发初始化：无云环境时静默降级，不阻塞本地使用
  initCloud() {
    if (!wx.cloud) {
      console.info('[智学星球] 当前基础库不支持云开发，使用本地 Demo 模式')
      return
    }
    try {
      wx.cloud.init({
        // env 省略 = 使用默认环境；多环境时改为具体环境 ID，如 env: 'zhixue-xxx'
        traceUser: true
      })
      this.globalData.cloudReady = true
      console.info('[智学星球] 云开发已初始化，可联调云函数')
    } catch (e) {
      this.globalData.cloudReady = false
      console.warn('[智学星球] 云开发初始化失败，使用本地 Demo 模式', e)
    }
  },
  globalData: { cloudReady: false }
})
