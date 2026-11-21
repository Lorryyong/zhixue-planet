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
        reject({
          reason: 'CALL_FAIL',
          message: (err && err.errMsg) || '云函数调用失败（请确认已部署该云函数）',
          detail: err
        })
      }
    })
  })
}

module.exports = { isCloudReady, call }
