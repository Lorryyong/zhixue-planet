/**
 * 云端调用封装 —— 微信云函数直通模式（wx.cloud.callFunction）
 *
 * 背景：小程序已开通云开发并绑定 PG 环境 progressive-zupu-d8eb6lsc7ee9feb。
 *       通过 wx.cloud.callFunction 调用云函数时，微信运行时会注入真实 openid，
 *       云函数据此识别用户身份（前端无法伪造），彻底消除越权风险。
 *       相比 HTTP 网关：无需配 request 合法域名、无需 AppSecret、身份天然可信。
 *
 * 约定：
 *   - call(name, data) 返回 Promise，resolve 云函数业务结果（code:0），reject 错误对象。
 *   - 云函数 return 的对象即 res.result；函数内已做 HTTP/直传双适配，这里按直传取 result。
 *   - wx.cloud 同时承担：云函数调用 + 文件上传（recognize 用）。
 */

// PG 环境 ID（与 project.config.json / 云开发环境一致）
const ENV = 'progressive-zupu-d8eb6lsc7ee9feb'

/** 云调用是否可用：基础库支持且已初始化 wx.cloud */
function isCloudReady() {
  return !!(wx.cloud && wx.cloud.callFunction)
}

/**
 * 调用云函数（wx.cloud.callFunction），返回 Promise
 * @param {string} name 云函数名
 * @param {object} data 业务入参（不要传 studentId，身份由云端注入）
 * @returns {Promise<object>} 云函数业务结果（code:0）
 */
function call(name, data) {
  return new Promise((resolve, reject) => {
    if (!isCloudReady()) {
      reject({ reason: 'NOT_READY', message: '当前基础库不支持 wx.cloud，请升级微信版本' })
      return
    }
    wx.cloud.callFunction({
      name,
      data: data || {},
      success(res) {
        const result = res && res.result
        if (result && result.code === 0) {
          resolve(result)
        } else {
          const msg = (result && (result.message || result.error)) || '云函数返回异常'
          reject({ reason: (result && result.code === -401) ? 'NO_IDENTITY' : 'BAD_RESULT', message: msg, detail: result })
        }
      },
      fail(err) {
        let message = (err && err.errMsg) || '云函数调用失败'
        if (message.indexOf('not found') >= 0 || message.indexOf('FunctionName') >= 0) {
          message = '云函数 ' + name + ' 不存在或未部署：请在开发者工具上传部署该云函数'
        } else if (message.indexOf('env') >= 0) {
          message = '云开发环境异常：请确认已绑定 ' + ENV
        }
        reject({ reason: 'CALL_FAIL', message, detail: err })
      }
    })
  })
}

module.exports = { isCloudReady, call, ENV }
