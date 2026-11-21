/**
 * 云函数 submitAnswer —— 批改 + 掌握度更新 + 错题间隔重刷排期（PostgreSQL 版）
 *
 * 使用 @cloudbase/js-sdk v3 的 app.rdb() 访问 PG；云函数环境自动注入管理员凭证。
 * 表：zx_answer_record / zx_mastery / zx_wrongbook / zx_daily_tasks
 *
 * 入参：{ studentId, questionId, answer, correct, knowledgeTags, subject, taskId }
 * 出参：{
 *   code:0,
 *   deltas:[{tag,d}],                 // 每个知识点分数增减，供前端即时反馈
 *   mastery:[...], wrongbook:[...],   // 更新后快照，前端回写本地缓存供展示页读取
 *   taskProgress:{doneCount,totalCount,finished}
 * }
 */
const cloudbase = require('@cloudbase/js-sdk')

/** 取微信云调用注入的真实身份 openid（唯一可信来源）；取不到返回 '' */
function getCallerOpenId() {
  try {
    const wx = require('wx-server-sdk')
    wx.init({ env: wx.DYNAMIC_CURRENT_ENV })
    const ctx = wx.getWXContext() || {}
    if (ctx.OPENID) return ctx.OPENID
  } catch (e) { /* 非微信云调用环境 */ }
  return process.env.WX_OPENID || ''
}

/** HTTP 网关适配：HTTP 触发时参数在 event.body（可能 base64）；wx.cloud 直传时在 event 上。 */
function parseEvent(event) {
  if (!event || !event.body) return event || {}
  let raw = event.body
  if (event.isBase64Encoded) {
    try { raw = Buffer.from(raw, 'base64').toString('utf8') } catch (e) { /* 保持原样 */ }
  }
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch (e) { return {} }
  }
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

function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}
function parseArr(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') { try { return JSON.parse(v) } catch (e) { return [] } }
  return []
}
function addDays(base, days) {
  const d = new Date(base); d.setDate(d.getDate() + days); return d.toISOString()
}

exports.main = async (event) => {
  const p = parseEvent(event)
  const { questionId, answer, correct, knowledgeTags, subject, taskId } = p
  // 【安全】身份只认微信云调用注入的 openid，忽略前端传入的 studentId
  const studentId = getCallerOpenId()
  if (!studentId) return respond(event, { code: -401, message: '无法验证微信身份，请通过 wx.cloud.callFunction 调用', needWxCall: true })
  if (!questionId) return respond(event, { code: -1, message: '缺少 questionId' })
  const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
  const db = app.rdb()
  const nowIso = new Date().toISOString()

  try {
    // 1) 写作答记录
    await db.from('zx_answer_record').insert({
      id: genId('a'), student_id: studentId, question_id: questionId,
      task_id: taskId || null, answer: answer == null ? null : JSON.stringify(answer),
      is_correct: !!correct, attempts: 1, answered_at: nowIso
    })

    // 2) 更新每个知识点掌握度，并记录增减 delta
    const deltas = []
    for (const kid of (knowledgeTags || [])) {
      const cur = await db.from('zx_mastery')
        .select('*').eq('student_id', studentId).eq('knowledge_id', kid).limit(1)
      const row = cur.data && cur.data[0]
      if (row) {
        const s = Number(row.score)
        let score = correct ? s + 12 * (1 - s / 100) : s - 15
        score = Math.max(0, Math.min(100, Math.round(score)))
        const total = Number(row.total_answered || 0) + 1
        const corr = Number(row.total_correct || 0) + (correct ? 1 : 0)
        const trend = score > s ? 'rising' : (score < s ? 'falling' : 'stable')
        await db.from('zx_mastery').update({
          score, total_answered: total, total_correct: corr, trend, updated_at: nowIso
        }).eq('id', row.id)
        deltas.push({ tag: kid, d: Math.round(score - s) })
      } else {
        const score = correct ? 62 : 35
        await db.from('zx_mastery').insert({
          id: genId('m'), student_id: studentId, knowledge_id: kid,
          subject: subject || null, score, total_answered: 1,
          total_correct: correct ? 1 : 0, trend: correct ? 'rising' : 'falling',
          updated_at: nowIso
        })
        deltas.push({ tag: kid, d: correct ? 12 : -15 })
      }
    }

    // 3) 维护错题本（答错新增/重置排期；答对按 1/3/7 天递进，连续答对 2 次且 3 阶段后攻克）
    const wb = await db.from('zx_wrongbook')
      .select('*').eq('student_id', studentId).eq('question_id', questionId).limit(1)
    const w = wb.data && wb.data[0]

    if (!correct) {
      if (!w) {
        await db.from('zx_wrongbook').insert({
          id: genId('w'), student_id: studentId, question_id: questionId,
          knowledge_tags: JSON.stringify(knowledgeTags || []),
          wrong_count: 1, continuous_correct: 0, review_stage: 0,
          next_review_at: addDays(nowIso, 1), status: 'active',
          first_wrong_at: nowIso, last_wrong_at: nowIso
        })
      } else {
        await db.from('zx_wrongbook').update({
          wrong_count: Number(w.wrong_count || 0) + 1, continuous_correct: 0,
          review_stage: 0, next_review_at: addDays(nowIso, 1),
          status: 'active', last_wrong_at: nowIso
        }).eq('id', w.id)
      }
    } else if (w && w.status === 'active') {
      const stage = Number(w.review_stage || 0) + 1
      const gap = [1, 3, 7][Math.min(stage - 1, 2)]
      const cc = Number(w.continuous_correct || 0) + 1
      const status = (cc >= 2 && stage >= 3) ? 'conquered' : 'active'
      await db.from('zx_wrongbook').update({
        review_stage: stage, continuous_correct: cc, status,
        next_review_at: addDays(nowIso, gap)
      }).eq('id', w.id)
    }

    // 4) 推进每日任务进度
    let taskProgress = { doneCount: 0, totalCount: 0, finished: false }
    if (taskId) {
      const tr = await db.from('zx_daily_tasks').select('*').eq('id', taskId).limit(1)
      const task = tr.data && tr.data[0]
      if (task) {
        const doneCount = Number(task.done_count || 0) + 1
        const totalCount = Number(task.total_count || 0)
        // 仅当本次提交让任务“从未完成→完成”时结算打卡奖励，避免重复提交重复加能量
        const finished = doneCount >= totalCount && task.status !== 'done'
        await db.from('zx_daily_tasks').update({
          done_count: doneCount,
          status: finished ? 'done' : task.status,
          finished_at: finished ? nowIso : task.finished_at || null,
          started_at: task.started_at || nowIso
        }).eq('id', taskId)
        taskProgress = { doneCount, totalCount, finished }
      }
    }

    // 5) 养成数据上云（服务端权威）：答对 +2 能量；任务完成额外 +20 并记打卡/连续天数
    let gamification = null
    try {
      const gmRes = await db.from('zx_gamification').select('*').eq('student_id', studentId).limit(1)
      const gm = gmRes.data && gmRes.data[0]
      if (gm) {
        let energy = Number(gm.energy || 0) + (correct ? 2 : 0)
        let level = Number(gm.level || 1)
        let streak = Number(gm.streak || 0)
        let dates = parseArr(gm.checkin_dates)
        if (taskProgress.finished) {
          energy += 20
          const todayIso = new Date().toISOString()
          const today = todayIso.slice(0, 10)
          if (dates.indexOf(today) < 0) dates.push(today)
          // 连续天数：上次打卡是昨天则 +1，否则重置为 1
          const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
          const lastDate = gm.last_checkin_date ? String(gm.last_checkin_date).slice(0, 10) : ''
          streak = lastDate === yesterday ? streak + 1 : (lastDate === today ? streak : 1)
          await db.from('zx_gamification').update({ last_checkin_date: today }).eq('student_id', studentId)
        }
        // 等级由能量推导（与新星星球分档对齐），只升不降
        const derived = energy < 500 ? 1 : (energy < 1500 ? 4 : 7)
        level = Math.max(level, derived)
        await db.from('zx_gamification').update({
          energy, level, streak, checkin_dates: JSON.stringify(dates), updated_at: nowIso
        }).eq('student_id', studentId)
        gamification = { energy, level, streak, checkinDates: dates, badges: parseArr(gm.badges) }
      }
    } catch (e) { console.warn('[submitAnswer] 养成数据更新失败：', e && e.message) }

    // 6) 回读快照，供前端把缓存刷新为云端最新状态
    const [masteryRes, wrongRes] = await Promise.all([
      db.from('zx_mastery').select('*').eq('student_id', studentId).limit(200),
      db.from('zx_wrongbook').select('*').eq('student_id', studentId).limit(200)
    ])

    return respond(event, {
      code: 0, deltas,
      mastery: masteryRes.data || [], wrongbook: wrongRes.data || [],
      taskProgress, gamification
    })
  } catch (e) {
    return respond(event, { code: -1, message: e && e.message })
  }
}
