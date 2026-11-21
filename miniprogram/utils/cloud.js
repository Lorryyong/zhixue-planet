/**
 * 云函数调用封装 —— 带本地降级
 *
 * 设计原则：
 * - 未开通云开发 / 云函数未部署 / 调用失败时，统一 reject，
 *   由调用方降级到本地 store 逻辑，保证 Demo 始终可跑。
 * - 真机联调时，只要开通云开发并部署了 cloudfunctions，自动走云函数。
 *
 * 用法：
 *   cloud.call('recognize', { subject:'数学' })
 *     .then(res => { ... })          // res = 云函数 return 的对象（已解包 result）
 *     .catch(err => { ... })         // err = { reason, message, detail }
 */

function isCloudReady() {
  try {
    const app = getApp()
    return !!(wx.cloud && app && app.globalData && app.globalData.cloudReady)
  } catch (e) {
    return false
  }
}

/**
 * 调用云函数，返回 Promise
 * @param {string} name 云函数名
 * @param {object} data 入参
 * @returns {Promise<object>} 云函数返回值（result）
 */
function call(name, data) {
  return new Promise((resolve, reject) => {
    if (!isCloudReady()) {
      reject({ reason: 'NOT_READY', message: '云开发未初始化或未开通' })
      return
    }
    wx.cloud.callFunction({
      name,
      data: data || {},
      success(res) {
        const result = res && res.result
        if (result && result.code === 0) resolve(result)
        else reject({ reason: 'BAD_RESULT', message: '云函数返回异常', detail: result })
      },
      fail(err) {
        const raw = (err && err.errMsg) || ''
        let message = raw || '云函数调用失败'
        // 把常见云开发错误码翻译成可操作的中文引导
        if (raw.indexOf('-601034') >= 0 || raw.indexOf('没有权限') >= 0) {
          message = '未开通云开发：请在微信开发者工具左侧点「云开发」按钮开通并创建环境'
        } else if (raw.indexOf('-501000') >= 0 || raw.toLowerCase().indexOf('environment not found') >= 0) {
          message = '云环境不存在：请在 app.js 的 wx.cloud.init 中填入正确的 env 环境 ID'
        } else if (raw.indexOf('FunctionName') >= 0 || raw.toLowerCase().indexOf('function not found') >= 0) {
          message = '云函数未部署：请右键 cloudfunctions 下对应函数 → 上传并部署'
        }
        reject({ reason: 'CALL_FAIL', message, raw, detail: err })
      }
    })
  })
}

module.exports = { isCloudReady, call }
