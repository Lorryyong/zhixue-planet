// 每日打卡提醒（订阅消息）：一次授权 = 一条消息，由云端 reminderSend 在傍晚发送。
// 模板 ID 需先在小程序后台「订阅消息」里选用/申请后填入 TEMPLATE_ID；未配置时静默不可用。
const cloud = require('./cloud.js')

const TEMPLATE_ID = '' // TODO: 后台申请通过后填入模板 ID

function isConfigured() { return !!TEMPLATE_ID }

// 请求一次授权（应在用户点击或完成打卡等正向时刻调用，不要在页面打开时弹）
function requestDailyReminder() {
  return new Promise(resolve => {
    if (!isConfigured()) { resolve({ ok: false, reason: 'not_configured' }); return }
    wx.requestSubscribeMessage({
      tmplIds: [TEMPLATE_ID],
      success: function (res) {
        if (res[TEMPLATE_ID] === 'accept') {
          cloud.call('login', { action: 'subscribeAck', templateId: TEMPLATE_ID })
            .then(() => resolve({ ok: true }))
            .catch(() => resolve({ ok: true, ackFailed: true }))
        } else {
          resolve({ ok: false, reason: res[TEMPLATE_ID] || 'reject' })
        }
      },
      fail: function () { resolve({ ok: false, reason: 'fail' }) }
    })
  })
}

module.exports = { TEMPLATE_ID, isConfigured, requestDailyReminder }
