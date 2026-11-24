/**
 * 云函数 parent —— 家长绑定 + 学情周报云端化
 *
 * 身份来源：仅微信云调用注入的 openid（前端传入的 openid/studentId 一律忽略）。
 *
 * 学生端动作：
 *   - getBinding  ：读取本人绑定记录（含绑定码 code）
 *   - bind        ：绑定监护人（upsert，生成/保留 6 位绑定码），同步周报订阅设置
 *   - unbind      ：解除绑定（删除记录）
 *   - weeklyReport：读取/生成本人本周周报（forStudent 省略）
 *
 * 家长端动作：
 *   - claim       ：用孩子提供的 6 位绑定码认领（写入 parent_openid，绑定关系云端建立）
 *   - myChildren  ：读取本人已认领的孩子列表
 *   - weeklyReport：查看孩子周报（forStudent = 孩子 openid，须已认领）
 *
 * 周报数据全部来自云端：zx_gamification / zx_mastery / zx_wrongbook / zx_answer_record，
 * 按周（周一为起点）聚合后 upsert 到 zx_weekly_reports，同一周重复读取返回缓存快照。
 */
const cloudbase = require('@cloudbase/js-sdk')

function getCallerOpenId() {
  try {
    const wx = require('wx-server-sdk')
    wx.init({ env: wx.DYNAMIC_CURRENT_ENV })
    const ctx = wx.getWXContext() || {}
    if (ctx.OPENID) return ctx.OPENID
  } catch (e) { /* 非微信云调用环境 */ }
  return process.env.WX_OPENID || ''
}
function parseEvent(event) {
  if (!event || !event.body) return event || {}
  let raw = event.body
  if (event.isBase64Encoded) { try { raw = Buffer.from(raw, 'base64').toString('utf8') } catch (e) {} }
  if (typeof raw === 'string') { try { return JSON.parse(raw) } catch (e) { return {} } }
  return raw || {}
}
function respond(event, result) {
  if (event && event.httpMethod) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      isBase64Encoded: false,
      body: JSON.stringify(result)
    }
  }
  return result
}
function parseArr(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') { try { return JSON.parse(v) } catch (e) { return [] } }
  return []
}
function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}
function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

/** 返回 { weekKey, weekStart, weekEnd }，周一为一周起点，均 YYYY-MM-DD（北京时间 UTC+8） */
function weekRange(base) {
  // 云函数运行在 UTC：先按北京时间(UTC+8)偏移，再用 UTC 系列方法取日期，避免凌晨算成前一天
  const d = new Date((base ? new Date(base).getTime() : Date.now()) + 8 * 3600 * 1000)
  const day = d.getUTCDay() || 7
  const monday = new Date(d.getTime())
  monday.setUTCDate(d.getUTCDate() - day + 1)
  monday.setUTCHours(0, 0, 0, 0)
  const sunday = new Date(monday.getTime())
  sunday.setUTCDate(monday.getUTCDate() + 6)
  sunday.setUTCHours(0, 0, 0, 0)
  // ISO week number
  const thursday = new Date(monday.getTime()); thursday.setUTCDate(monday.getUTCDate() + 3)
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4))
  const fday = firstThursday.getUTCDay() || 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fday + 1)
  const weekNo = 1 + Math.round((thursday - firstThursday) / (7 * 86400000))
  const y = thursday.getUTCFullYear()
  const weekKey = y + '-W' + String(weekNo).padStart(2, '0')
  const fmt = x => x.getUTCFullYear() + '-' + String(x.getUTCMonth() + 1).padStart(2, '0') + '-' + String(x.getUTCDate()).padStart(2, '0')
  return { weekKey, weekStart: fmt(monday), weekEnd: fmt(sunday) }
}

function rowToBinding(r) {
  if (!r) return null
  return {
    guardian: r.guardian || '', relation: r.relation || '妈妈', phone: r.phone || '',
    weekly: !!r.weekly, weeklyDay: r.weekly_day || '周日',
    code: r.code || '', bound: true, boundAt: r.bound_at || r.created_at,
    claimed: !!r.parent_openid, claimedAt: r.claimed_at || '',
    studentOpenid: r.student_openid
  }
}

exports.main = async (event) => {
  const p = parseEvent(event)
  const me = getCallerOpenId()
  if (!me) return respond(event, { code: -401, message: '无法验证微信身份，请通过 wx.cloud.callFunction 调用', needWxCall: true })
  const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
  const db = app.rdb()
  const action = p.action || 'getBinding'
  const nowIso = new Date().toISOString()

  try {
    // ===== 学生：确保有绑定码（资料页展示用；无记录/无码时自动生成，只生成码、不需要先填监护人）=====
    if (action === 'ensureCode') {
      const r = await db.from('zx_parent_bindings').select('*').eq('student_openid', me).limit(1)
      const old = r.data && r.data[0]
      if (old && old.code) {
        return respond(event, { code: 0, bindCode: old.code, claimed: !!old.parent_openid })
      }
      const newCode = genCode()
      if (old) {
        const up = await db.from('zx_parent_bindings').update({ code: newCode, updated_at: nowIso }).eq('id', old.id)
        if (up && up.error) return respond(event, { code: -1, message: '绑定码生成失败：' + (up.error.message || '') })
      } else {
        const ins = await db.from('zx_parent_bindings').insert({
          id: genId('pb'), student_openid: me, code: newCode, created_at: nowIso, updated_at: nowIso
        })
        if (ins && ins.error) return respond(event, { code: -1, message: '绑定码生成失败：' + (ins.error.message || '') })
      }
      return respond(event, { code: 0, bindCode: newCode, claimed: false })
    }

    // ===== 学生：读取自己的绑定 =====
    if (action === 'getBinding') {
      const r = await db.from('zx_parent_bindings').select('*').eq('student_openid', me).limit(1)
      return respond(event, { code: 0, binding: rowToBinding(r.data && r.data[0]) })
    }

    // ===== 学生：绑定监护人（upsert，保留绑定码）=====
    if (action === 'bind') {
      const guardian = String(p.guardian || '').trim().slice(0, 20)
      if (!guardian) return respond(event, { code: -2, message: '请填写监护人称呼' })
      const phone = String(p.phone || '').trim().slice(0, 11)
      if (phone && !/^1\d{10}$/.test(phone)) return respond(event, { code: -3, message: '手机号格式不正确' })
      const relation = String(p.relation || '妈妈').slice(0, 12)
      const weekly = !!p.weekly
      const weeklyDay = String(p.weeklyDay || '周日').slice(0, 6)
      const r = await db.from('zx_parent_bindings').select('*').eq('student_openid', me).limit(1)
      const old = r.data && r.data[0]
      const code = (old && old.code) || genCode()
      const patch = {
        guardian, relation, phone, weekly, weekly_day: weeklyDay,
        bound_at: old ? (old.bound_at || nowIso) : nowIso,
        updated_at: nowIso
      }
      let row
      if (old) {
        await db.from('zx_parent_bindings').update(patch).eq('student_openid', me)
        row = Object.assign({}, old, patch, { code })
      } else {
        const ins = Object.assign({
          id: genId('pb'), student_openid: me, code, created_at: nowIso
        }, patch)
        await db.from('zx_parent_bindings').insert(ins)
        row = ins
      }
      return respond(event, { code: 0, binding: rowToBinding(row), note: '家长绑定已保存到云端，把绑定码告诉家长即可认领' })
    }

    // ===== 学生：解除绑定（置空而非物理删除，rdb 兼容性更稳妥）=====
    if (action === 'unbind') {
      const r = await db.from('zx_parent_bindings').select('id').eq('student_openid', me).limit(1)
      if (r.data && r.data.length) {
        await db.from('zx_parent_bindings').update({
          guardian: '', phone: '', parent_openid: null, claimed_at: null,
          code: null, weekly: false, bound_at: null, updated_at: nowIso
        }).eq('id', r.data[0].id)
      }
      return respond(event, { code: 0, note: '已解除家长绑定' })
    }

    // ===== 家长：用绑定码认领孩子 =====
    if (action === 'claim') {
      const code = String(p.code || '').trim()
      if (!/^\d{6}$/.test(code)) return respond(event, { code: -2, message: '请输入 6 位绑定码' })
      const r = await db.from('zx_parent_bindings').select('*').eq('code', code).limit(1)
      const row = r.data && r.data[0]
      if (!row) return respond(event, { code: -4, message: '绑定码不存在，请核对后重试' })
      // 不能认领自己的绑定（自己是学生）
      if (row.student_openid === me) return respond(event, { code: -5, message: '不能认领自己的绑定码，绑定码在个人资料页查看' })
      // 关系由家长在认领时选择（我和学生的关系），覆盖学生侧旧值
      const relation = String(p.relation || '').trim().slice(0, 12)
      const patch = { parent_openid: me, claimed_at: nowIso, updated_at: nowIso }
      if (relation) patch.relation = relation
      await db.from('zx_parent_bindings').update(patch).eq('id', row.id)
      return respond(event, {
        code: 0,
        child: { openid: row.student_openid, guardian: row.guardian, relation: relation || row.relation },
        note: '认领成功，现在可以查看孩子的学情周报'
      })
    }

    // ===== 家长：解除与某个孩子的绑定（只释放认领关系，学生的绑定码保留，可重新认领）=====
    if (action === 'unclaim') {
      const target = String(p.studentOpenid || '')
      if (!target) return respond(event, { code: -2, message: '缺少要解除绑定的孩子' })
      const r = await db.from('zx_parent_bindings').select('id')
        .eq('student_openid', target).eq('parent_openid', me).limit(1)
      if (!(r.data && r.data.length)) return respond(event, { code: -4, message: '未找到你与该孩子的绑定' })
      const up = await db.from('zx_parent_bindings').update({
        parent_openid: null, claimed_at: null, updated_at: nowIso
      }).eq('id', r.data[0].id)
      if (up && up.error) return respond(event, { code: -1, message: '解除绑定失败：' + (up.error.message || '') })
      return respond(event, { code: 0, note: '已解除绑定' })
    }

    // ===== 家长：读取已认领的孩子列表（带孩子昵称，展示用）=====
    if (action === 'myChildren') {
      const r = await db.from('zx_parent_bindings').select('*').eq('parent_openid', me).limit(100)
      const rows = r.data || []
      const nickMap = {}
      if (rows.length) {
        try {
          const us = await db.from('zx_users').select('openid,nickname').limit(500)
          ;(us.data || []).forEach(function (u) { nickMap[u.openid] = u.nickname || '' })
        } catch (e) { /* 昵称读取失败不影响列表 */ }
      }
      const children = rows.map(function (row) {
        return {
          openid: row.student_openid, guardian: row.guardian, relation: row.relation,
          nickname: nickMap[row.student_openid] || '', claimedAt: row.claimed_at
        }
      })
      return respond(event, { code: 0, children })
    }

    // ===== 周报：读取/生成（学生本人 or 已认领家长）=====
    if (action === 'weeklyReport') {
      const target = p.forStudent ? String(p.forStudent) : me
      if (target !== me) {
        // 家长查看：必须已认领该孩子
        const br = await db.from('zx_parent_bindings').select('id')
          .eq('student_openid', target).eq('parent_openid', me).limit(1)
        if (!(br.data && br.data.length)) {
          return respond(event, { code: -403, message: '你尚未认领该孩子，无法查看其周报' })
        }
      }
      const wr = weekRange()
      // 命中缓存则直接返回
      const cached = await db.from('zx_weekly_reports').select('*')
        .eq('student_id', target).eq('week_key', wr.weekKey).limit(1)
      if (cached.data && cached.data.length && !p.refresh) {
        return respond(event, { code: 0, report: normalizeReport(cached.data[0]), cached: true })
      }

      // 聚合本周数据
      const [gmRes, mRes, wRes, aRes] = await Promise.all([
        db.from('zx_gamification').select('*').eq('student_id', target).limit(1),
        db.from('zx_mastery').select('*').eq('student_id', target).limit(500),
        db.from('zx_wrongbook').select('*').eq('student_id', target).limit(500),
        db.from('zx_answer_record').select('*').eq('student_id', target).gte('answered_at', wr.weekStart + 'T00:00:00').limit(1000)
      ])
      const gm = gmRes.data && gmRes.data[0]
      const energy = Number(gm && gm.energy) || 0
      const streak = Number(gm && gm.streak) || 0
      const checkins = parseArr(gm && gm.checkin_dates).filter(function (d) {
        return d >= wr.weekStart && d <= wr.weekEnd
      }).length
      const answers = aRes.data || []
      const answerCount = answers.length
      const correctCount = answers.filter(function (a) { return !!a.is_correct }).length
      const accuracy = answerCount ? Math.round(correctCount / answerCount * 100) : 0
      const wrongs = wRes.data || []
      const wrongActive = wrongs.filter(function (w) { return w.status === 'active' }).length
      const conquered = wrongs.filter(function (w) { return w.status === 'conquered' }).length
      const mastery = mRes.data || []
      const weakList = mastery.filter(function (m) { return Number(m.score) < 75 })
        .sort(function (a, b) { return Number(a.score) - Number(b.score) })
        .slice(0, 5)
        .map(function (m) { return { id: m.knowledge_id, name: m.knowledge_id, score: Number(m.score) || 0, subject: m.subject || '' } })
      // 分科平均掌握度
      const subjMap = {}
      mastery.forEach(function (m) {
        const s = m.subject || '综合'
        if (!subjMap[s]) subjMap[s] = { sum: 0, n: 0 }
        subjMap[s].sum += Number(m.score) || 0
        subjMap[s].n++
      })
      const subjectStats = Object.keys(subjMap).map(function (s) {
        return { subject: s, score: Math.round(subjMap[s].sum / subjMap[s].n) }
      }).sort(function (a, b) { return a.score - b.score })

      const report = {
        student_id: target, week_key: wr.weekKey, week_start: wr.weekStart, week_end: wr.weekEnd,
        energy, streak, checkins, answer_count: answerCount, correct_count: correctCount, accuracy,
        wrong_active: wrongActive, conquered,
        weak_list: JSON.stringify(weakList), subject_stats: JSON.stringify(subjectStats),
        generated_at: nowIso
      }
      const exist = await db.from('zx_weekly_reports').select('id').eq('student_id', target).eq('week_key', wr.weekKey).limit(1)
      if (exist.data && exist.data.length) {
        await db.from('zx_weekly_reports').update(report).eq('id', exist.data[0].id)
        report.id = exist.data[0].id
      } else {
        report.id = genId('wr')
        await db.from('zx_weekly_reports').insert(report)
      }
      return respond(event, { code: 0, report: normalizeReport(report), cached: false })
    }

    return respond(event, { code: -9, message: '未知 action: ' + action })
  } catch (e) {
    return respond(event, { code: -1, message: e && e.message })
  }
}

function normalizeReport(r) {
  if (!r) return null
  return {
    weekKey: r.week_key, weekStart: r.week_start, weekEnd: r.week_end,
    energy: Number(r.energy) || 0, streak: Number(r.streak) || 0,
    checkins: Number(r.checkins) || 0,
    answerCount: Number(r.answer_count) || 0, correctCount: Number(r.correct_count) || 0,
    accuracy: Number(r.accuracy) || 0,
    wrongActive: Number(r.wrong_active) || 0, conquered: Number(r.conquered) || 0,
    weakList: parseArr(r.weak_list), subjectStats: parseArr(r.subject_stats),
    generatedAt: r.generated_at
  }
}
