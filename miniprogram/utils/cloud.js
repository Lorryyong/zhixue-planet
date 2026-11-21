/**
 * 云端调用封装 —— HTTP 访问服务（HTTP 网关）模式
 *
 * 背景：微信云开发（wx.cloud）不支持 PostgreSQL 环境，本项目数据都在
 *      腾讯云 CloudBase 的 PG 环境里。因此走「HTTP 网关」：
 *      三个云函数各自挂一个 HTTPS 路由，小程序用 wx.request 调用。
 *
 * 使用：
 *   1) 控制台「HTTP 网关 → 路由管理」新建 3 条路由：
 *        /recognize     → recognize
 *        /composeTask   → composeTask
 *        /submitAnswer  → submitAnswer
 *   2) 若控制台显示的默认域名与下方 HTTP_BASE 不同，改 HTTP_BASE 即可。
 *   3) 小程序后台把该域名加入 request 合法域名；开发阶段可勾选「不校验合法域名」。
 *
 * 约定：
 *   - call(name, data) 返回 Promise，resolve 云函数业务结果（code:0），reject 错误对象。
 *   - 云函数对 HTTP 请求返回集成响应 { statusCode, headers, body }，
 *     body 是 JSON 字符串，这里统一解析并解包。
 *   - wx.cloud 仅保留用于「上传 PDF/图片到云存储」拿 fileID（recognize 用），
 *     上传失败也不影响主流程（Demo 识别用预置样题）。
 */

// HTTP 网关默认域名（不含具体路由，结尾不要斜杠）
// 若控制台「HTTP 网关」页显示的默认域名不同，改成那个域名即可
const HTTP_BASE = 'https://progressive-zupu-d8eb6lsc7ee9feb-1526320157.ap-shanghai.app.tcloudbase.com'

/** HTTP 模式是否可用：只要配了合法域名即可，不再依赖 wx.cloud */
function isCloudReady() {
  return !!(HTTP_BASE && HTTP_BASE.indexOf('http') === 0)
}

/**
 * 调用云函数（经 HTTP 网关），返回 Promise
 * @param {string} name 云函数名，对应网关路由 /<name>
 * @param {object} data 入参
 * @returns {Promise<object>} 云函数业务结果（code:0）
 */
function call(name, data) {
  return new Promise((resolve, reject) => {
    if (!isCloudReady()) {
      reject({ reason: 'NOT_READY', message: '未配置 HTTP 网关域名' })
      return
    }
    wx.request({
      url: HTTP_BASE + '/' + name,
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      data: data || {},
      success(res) {
        const http = res && res.statusCode
        let result = res && res.data
        // 云函数返回集成响应时 body 是 JSON 字符串；网关直连时可能已是对象
        if (typeof result === 'string') {
          try { result = JSON.parse(result) } catch (e) { /* 保持原样 */ }
        }
        if (http >= 200 && http < 300 && result && result.code === 0) {
          resolve(result)
        } else {
          const msg = (result && (result.message || result.error)) || ('HTTP ' + http)
          reject({ reason: 'BAD_RESULT', message: msg, detail: result })
        }
      },
      fail(err) {
        let message = (err && err.errMsg) || 'HTTP 网关请求失败'
        if (message.indexOf('domain') >= 0 || message.indexOf('url not in domain list') >= 0) {
          message = '域名未加入 request 合法域名：请在小程序后台配置，或开发者工具勾选「不校验合法域名」'
        } else if (message.indexOf('request') >= 0 && message.indexOf('fail') >= 0) {
          message = '网络请求失败：检查网络，以及 HTTP 网关路由是否已配置（/recognize 等）'
        }
        reject({ reason: 'CALL_FAIL', message, raw: message, detail: err })
      }
    })
  })
}

module.exports = { isCloudReady, call, HTTP_BASE }
