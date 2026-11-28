// app.js
const store = require('./utils/store.js')

App({
  onLaunch() {
    // 埋点：启动事件（非阻塞，隐私设置默认关闭统计时不采集）
    try { require('./utils/track.js').event('app_launch', {}) } catch (e) {}

    // 0) 手机端调试：仅开发版/体验版开启 vConsole；正式版强制关闭，避免线上用户看到调试面板。
    //    取不到版本信息时按"非 release"处理（保持老基础库兼容），但有版本信息时以环境变量为准。
    try {
      if (typeof wx.setEnableDebug === 'function' && typeof wx.getAccountInfoSync === 'function') {
        const env = (wx.getAccountInfoSync().miniProgram || {}).envVersion || ''
        wx.setEnableDebug({ enableDebug: env !== 'release' })
      }
    } catch (e) { /* 部分基础库不支持时忽略 */ }
    // 1) 初始化本地种子数据（本地 Demo 模式始终可用）
    store.getState()
    // 2) 初始化云开发（wx.cloud 为云函数调用 + 文件上传的主链路）
    this.initCloud()
    // 3) 预热登录：后台拿 openid 并建档+克隆种子题；不阻塞启动。
    //    各云端方法内部也有 ensureStudentId()，这里只是提前完成以减少首次等待。
    try {
      const auth = require('./utils/auth.js')
      auth.ensureStudentId()
    } catch (e) { /* 登录失败由各调用点兜底 */ }
    // 4) 预热知识点字典（英语/数学/语文）：标签代码翻译与校对点选器都靠它，非阻塞
    try { const kd = require('./utils/kdict.js'); kd.ALL_SUBJECTS.forEach(function (x) { kd.load(x) }) } catch (e) {}
  },
  onHide() {
    // 切后台时冲刷埋点缓冲，避免事件滞留
    try { require('./utils/track.js').flush() } catch (e) {}
  },
  // 云开发初始化：云函数调用 + 文件上传的主链路（见 utils/cloud.js）。
  // 初始化失败时各方法会降级到本地 Demo，不影响基础浏览。
  initCloud() {
    if (!wx.cloud) {
      console.info('[智学星球] 当前基础库不支持 wx.cloud，将使用本地 Demo')
      return
    }
    try {
      wx.cloud.init({
        env: 'progressive-zupu-d8eb6lsc7ee9feb',
        traceUser: true
      })
      this.globalData.cloudUploadReady = true
      console.info('[智学星球] wx.cloud 已初始化（云函数调用 + 文件上传）')
    } catch (e) {
      this.globalData.cloudUploadReady = false
      console.warn('[智学星球] wx.cloud 初始化失败，降级本地 Demo', e)
    }
  },
  globalData: { cloudUploadReady: false }
})
