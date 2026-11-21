// app.js
const store = require('./utils/store.js')

App({
  onLaunch() {
    // Demo 阶段：初始化本地种子数据
    store.getState()
  },
  globalData: {}
})
