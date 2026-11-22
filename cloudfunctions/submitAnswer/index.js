/**
 * 云函数 submitAnswer —— 批改 + 掌握度更新 + 错题间隔重刷排期（PostgreSQL 版 · 全题型）
 *
 * 使用 @cloudbase/js-sdk v3 的 app.rdb() 访问 PG；云函数环境自动注入管理员凭证。
 * 表：zx_answer_record / zx_mastery / zx_wrongbook / zx_daily_tasks / zx_questions
 *
 * 判分策略（题型与中考一致，见 questionTypes.js）：
 *   - 客观题(single/multiple/judge/blank)：以云端题目标准答案自动判分，不信任前端 correct。
 *   - 主观题(solve/calculation/reading/experiment/translation/essay)：AI 按评分要点给分；
 *     AI 不可用/失败 → 降级「学生自评」(self_graded=true)，保证闭环不中断。
 *
 * 入参：{ questionId, answer, selfGrade?, knowledgeTags?, subject?, taskId? }
 *   - answer: 客观题=下标/下标数组/填空文本数组；主观题=学生作答文本
 *   - selfGrade: 主观题降级自评时前端传入的 boolean（true=自评答对）
 * 出参：{
 *   code:0, correct, gradedBy:'auto'|'ai'|'self', score?, maxScore?, aiComment?,
 *   needSelfGrade?, reference?, scoring_points?, deltas, mastery, wrongbook, taskProgress, gamification
 * }
 */
const cloudbase = require('@cloudbase/js-sdk')
const qt = require('./questionTypes.js')

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

/** 主观题 AI 判分：返回 {score,maxScore,correct,comment,gradedBy:'ai'}；失败返回 null 由上层降级自评 */
async function aiGradeQuestion(q, answer) {
  try {
    const tcb = require('@cloudbase/node-sdk')
    const app = tcb.init({ env: tcb.SYMBOL_CURRENT_ENV, timeout: 120000 })
    const model = app.ai().createModel('cloudbase')
    const modelName = process.env.AI_GRADE_MODEL || process.env.AI_MODEL || 'glm-5.3-flash'
    const typeLabel = qt.meta(q.q_type).label
    const maxScore = Number(q.score) || 10
    const points = qt.asValue(q.scoring_points) || []
    const pointsText = Array.isArray(points) && points.length
      ? points.map((p, i) => (i + 1) + '. ' + (p.point || p.text || '') + (p.score ? '（' + p.score + '分）' : '')).join('\n')
      : '（无明确评分要点，请按参考答案整体给分）'
    const userText = [
      '学科：' + (q.subject || '未知'),
      '题型：' + typeLabel,
      '题干：' + (q.stem || ''),
      '参考答案：' + String(qt.asValue(q.answer) || ''),
      '评分要点：\n' + pointsText,
      '满分：' + maxScore,
      '学生作答：' + String(answer == null ? '' : answer)
    ].join('\n')
    const res = await model.generateText({
      model: modelName,
      messages: [
        { role: 'system', content: qt.AI_GRADE_SYSTEM },
        { role: 'user', content: userText }
      ]
    })
    const raw = res && res.text
    if (!raw) return null
    const s = String(raw).replace(/```(?:json)?/gi, '').trim()
    const a = s.indexOf('{'), b = s.lastIndexOf('}')
    if (a < 0 || b <= a) return null
    let obj
    try { obj = JSON.parse(s.slice(a, b + 1)) } catch (e) { return null }
    let score = Number(obj.score), maxScoreOut = Number(obj.maxScore)
    if (!Number.isFinite(score) || score < 0) return null
    if (!Number.isFinite(maxScoreOut) || maxScoreOut <= 0) maxScoreOut = maxScore
    score = Math.min(score, maxScoreOut)
    const correct = (typeof obj.correct === 'boolean') ? obj.correct : (score / maxScoreOut >= 0.6)
    return {
      score, maxScore: maxScoreOut, correct: !!correct,
      comment: String(obj.comment || '').slice(0, 60), gradedBy: 'ai'
    }
  } catch (e) {
    console.warn('[submitAnswer] AI 判分失败，降级自评：', e && e.message)
    return null
  }
}

exports.main = async (event) => {
  const p = parseEvent(event)
  const { questionId, answer, selfGrade, knowledgeTags, subject, taskId } = p
  // 【安全】身份只认微信云调用注入的 openid，忽略前端传入的 studentId
  const studentId = getCallerOpenId()
  if (!studentId) return respond(event, { code: -401, message: '无法验证微信身份，请通过 wx.cloud.callFunction 调用', needWxCall: true })
  if (!questionId) return respond(event, { code: -1, message: '缺少 questionId' })
  const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
  const db = app.rdb()
  const nowIso = new Date().toISOString()

  try {
    // 0) 读取云端题目，拿到题型与标准答案（判分以云端为准，绝不信任前端 correct）
    const qr = await db.from('zx_questions').select('*').eq('id', questionId).limit(1)
    const q = qr.data && qr.data[0]
    if (!q) return respond(event, { code: -404, message: '题目不存在' })
    const type = qt.normalizeType(q.q_type)
    const tags = (knowledgeTags && knowledgeTags.length) ? knowledgeTags : parseArr(q.knowledge_tags)

    let grading
    if (qt.isObjective(type)) {
      // ===== 客观题：云端自动判分 =====
      const jr = qt.judgeObjective(q, answer)
      grading = { correct: !!(jr && jr.correct), gradedBy: 'auto', maxScore: Number(q.score) || 2 }
    } else {
      // ===== 主观题：AI 判分，失败降级自评 =====
      if (typeof selfGrade === 'boolean') {
        grading = { correct: selfGrade, gradedBy: 'self', maxScore: Number(q.score) || 10, selfGraded: true, aiComment: '学生自评' }
      } else {
        const ai = await aiGradeQuestion(q, answer)
        if (ai) {
          grading = ai
        } else {
          // AI 不可用：落一条待自评记录并提示前端自评，暂不更新掌握度/错题/能量
          await db.from('zx_answer_record').insert({
            id: genId('a'), student_id: studentId, question_id: questionId,
            task_id: taskId || null, answer: JSON.stringify(answer == null ? null : answer),
            is_correct: false, self_graded: false, needs_self_grade: true,
            attempts: 1, answered_at: nowIso
          })
          return respond(event, {
            code: 0, needSelfGrade: true, gradedBy: 'pending',
            reference: String(qt.asValue(q.answer) || ''),
            scoring_points: qt.asValue(q.scoring_points) || [],
            maxScore: Number(q.score) || 10,
            message: 'AI 判分暂不可用，请对照参考答案自评'
          })
        }
      }
    }
    const correct = grading.correct

    // 1) 写作答记录（客观题 / AI 判分 / 自评最终态）
    await db.from('zx_answer_record').insert({
      id: genId('a'), student_id: studentId, question_id: questionId,
      task_id: taskId || null, answer: answer == null ? null : JSON.stringify(answer),
      is_correct: !!correct, self_graded: !!grading.selfGraded,
      graded_by: grading.gradedBy,
      ai_score: (typeof grading.score === 'number' ? grading.score : null),
      ai_max_score: (grading.maxScore || null),
      ai_comment: grading.aiComment || null,
      attempts: 1, answered_at: nowIso
    })

    // 2) 更新每个知识点掌握度，并记录增减 delta
    const deltas = []
    for (const kid of (tags || [])) {
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
          subject: subject || q.subject || null, score, total_answered: 1,
          total_correct: correct ? 1 : 0, trend: correct ? 'rising' : 'falling',
          updated_at: nowIso
        })
        deltas.push({ tag: kid, d: correct ? 12 : -15 })
      }
    }

    // 3) 维护错题本（答错新增/重置排期；答对按 1/3/7 天递进）
    const wb = await db.from('zx_wrongbook')
      .select('*').eq('student_id', studentId).eq('question_id', questionId).limit(1)
    const w = wb.data && wb.data[0]

    if (!correct) {
      if (!w) {
        await db.from('zx_wrongbook').insert({
          id: genId('w'), student_id: studentId, question_id: questionId,
          knowledge_tags: JSON.stringify(tags || []),
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

    // 5) 养成数据上云（服务端权威）
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
          const today = new Date().toISOString().slice(0, 10)
          if (dates.indexOf(today) < 0) dates.push(today)
          const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
          const lastDate = gm.last_checkin_date ? String(gm.last_checkin_date).slice(0, 10) : ''
          streak = lastDate === yesterday ? streak + 1 : (lastDate === today ? streak : 1)
          await db.from('zx_gamification').update({ last_checkin_date: today }).eq('student_id', studentId)
        }
        const derived = energy < 500 ? 1 : (energy < 1500 ? 4 : 7)
        level = Math.max(level, derived)
        await db.from('zx_gamification').update({
          energy, level, streak, checkin_dates: JSON.stringify(dates), updated_at: nowIso
        }).eq('student_id', studentId)
        gamification = { energy, level, streak, checkinDates: dates, badges: parseArr(gm.badges) }
      }
    } catch (e) { console.warn('[submitAnswer] 养成数据更新失败：', e && e.message) }

    // 6) 回读快照
    const [masteryRes, wrongRes] = await Promise.all([
      db.from('zx_mastery').select('*').eq('student_id', studentId).limit(200),
      db.from('zx_wrongbook').select('*').eq('student_id', studentId).limit(200)
    ])

    return respond(event, {
      code: 0, correct, gradedBy: grading.gradedBy,
      score: (typeof grading.score === 'number' ? grading.score : undefined),
      maxScore: grading.maxScore || undefined,
      aiComment: grading.aiComment || undefined,
      deltas,
      mastery: masteryRes.data || [], wrongbook: wrongRes.data || [],
      taskProgress, gamification
    })
  } catch (e) {
    return respond(event, { code: -1, message: e && e.message })
  }
}
