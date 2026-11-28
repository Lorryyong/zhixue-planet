/**
 * 云函数 reminderSend —— 每日打卡提醒发送（订阅消息）。
 * 触发方式：定时触发器（建议每天 18:30 北京时间）或手动调用。
 * 规则：只给 settings.reminder.credits > 0 的用户发；今天已打卡的不发（不浪费授权）；
 * 发送成功扣 1 次授权。模板字段键名须与后台获批模板一致，可用环境变量覆盖：
 *   TPL_FIELD_TITLE（默认 thing1）/ TPL_FIELD_COUNT（默认 number2）/ TPL_FIELD_TIP（默认 thing3）
 * 数据口径：待复习错题 = zx_wrongbook 中 active 且 next_review_at <= now 的数量。
 */
const cloudbase = require('@cloudbase/js-sdk')

function beijingDate(base) {
  const ms = (base ? new Date(base).getTime() : Date.now()) + 8 * 3600 * 1000
  return new Date(ms).toISOString().slice(0, 10)
}
function parseSettings(v) {
  let st = v
  for (let i = 0; i < 3 && typeof st === 'string'; i++) { try { st = JSON.parse(st) } catch (e) { return {} } }
  return (st && typeof st === 'object') ? st : {}
}
function parseArr(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') { try { return JSON.parse(v) } catch (e) { return [] } }
  return []
}

exports.main = async () => {
  const wx = require('wx-server-sdk')
  wx.init({ env: wx.DYNAMIC_CURRENT_ENV })
  const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
  const db = app.rdb()
  const today = beijingDate()
  const nowIso = new Date().toISOString()
  const F_TITLE = process.env.TPL_FIELD_TITLE || 'thing1'
  const F_COUNT = process.env.TPL_FIELD_COUNT || 'number2'
  const F_TIP = process.env.TPL_FIELD_TIP || 'thing3'

  const usersRes = await db.from('zx_users').select('openid, settings').limit(500)
  const users = (usersRes.data || []).filter(function (u) {
    const rem = parseSettings(u.settings).reminder
    return rem && rem.tpl && (Number(rem.credits) || 0) > 0
  })
  let sent = 0, skipped = 0, failed = 0
  for (const u of users) {
    const settings = parseSettings(u.settings)
    const rem = settings.reminder
    try {
      const gmRes = await db.from('zx_gamification').select('checkin_dates').eq('student_id', u.openid).limit(1)
      const gm = gmRes.data && gmRes.data[0]
      const dates = parseArr(gm && gm.checkin_dates).map(function (d) { return String(d).slice(0, 10) })
      if (dates.indexOf(today) >= 0) { skipped++; continue }
      const wbRes = await db.from('zx_wrongbook').select('id')
        .eq('student_id', u.openid).eq('status', 'active').lte('next_review_at', nowIso).limit(200)
      const due = (wbRes.data || []).length
      const data = {}
      data[F_TITLE] = { value: '今天的打卡还没完成哦' }
      data[F_COUNT] = { value: due }
      data[F_TIP] = { value: due > 0 ? ('有 ' + due + ' 道错题到期待复习') : '来完成今天的打卡吧' }
      await wx.cloud.openapi.subscribeMessage.send({
        touser: u.openid, templateId: rem.tpl, page: 'pages/index/index', data, miniprogramState: 'formal'
      })
      rem.credits = Math.max(0, (Number(rem.credits) || 0) - 1)
      rem.lastSentAt = nowIso
      settings.reminder = rem
      await db.from('zx_users').update({ settings }).eq('openid', u.openid)
      sent++
    } catch (e) {
      failed++
      console.warn('[reminderSend] 发送失败', u.openid, e && e.message)
    }
  }
  return { code: 0, candidates: users.length, sent, skipped, failed }
}
