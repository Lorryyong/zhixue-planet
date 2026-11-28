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
const badges = require('./badges.js')

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

/** 北京时间（UTC+8）的 YYYY-MM-DD；云函数运行在 UTC，直接用 toISOString 会把凌晨算成前一天 */
function beijingDate(base) {
  const ms = (base ? new Date(base).getTime() : Date.now()) + 8 * 3600 * 1000
  return new Date(ms).toISOString().slice(0, 10)
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

// 2.0 探索等级（按累计星能量 total_earned；门槛与前端 utils/spaceLevels.js 保持一致）
const SPACE_LEVELS = [[1, '月球基地', 0], [2, '火星前哨', 200], [3, '木星空间站', 500], [4, '土星环站', 1000], [5, '比邻星站', 1800], [6, '天狼星站', 3000], [7, '昴星团空间站', 4800], [8, '猎户座星云', 7200], [9, '鹰状星云', 10500], [10, '银河探索站', 15000], [11, '仙女座星系', 21000], [12, '拉尼亚凯亚', 30000]]
function spaceLevelOf(total) {
  let lv = SPACE_LEVELS[0]
  for (let i = 0; i < SPACE_LEVELS.length; i++) { if (total >= SPACE_LEVELS[i][2]) lv = SPACE_LEVELS[i] }
  return { level: lv[0], name: lv[1] }
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

// 首页打卡正确率曲线预计算（本月按天 vs 上月同期）：答题只在完成打卡时变更曲线，
// 在此把聚合结果算好存进 zx_users.acc_cache，首页读取时不再实时聚合（用户 2026-11-27 要求）。
// 口径与 composeTask accuracyCurve 完全一致：未自评的主观题不计入。
async function refreshAccCache(db, studentId) {
  const nowBJ = new Date(Date.now() + 8 * 3600 * 1000)
  const y = nowBJ.getUTCFullYear(), mo = nowBJ.getUTCMonth()
  const dom = nowBJ.getUTCDate()
  const pad = function (n) { return n < 10 ? '0' + n : '' + n }
  const todayBJ = y + '-' + pad(mo + 1) + '-' + pad(dom)
  const curStart = y + '-' + pad(mo + 1) + '-01'
  const pm = mo === 0 ? 11 : mo - 1, py = mo === 0 ? y - 1 : y
  const prevStart = py + '-' + pad(pm + 1) + '-01'
  const fromISO = new Date(new Date(prevStart + 'T00:00:00Z').getTime() - 8 * 3600 * 1000).toISOString()
  const ar = await db.from('zx_answer_record').select('answered_at,is_correct,needs_self_grade,self_graded')
    .eq('student_id', studentId).gte('answered_at', fromISO).limit(20000)
  const rows = (ar && ar.data) || []
  const build = function (startStr) {
    const base = new Date(startStr + 'T00:00:00Z').getTime()
    const byDay = {}
    rows.forEach(function (a) {
      if (a.needs_self_grade && !a.self_graded) return
      const d = new Date(new Date(a.answered_at).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
      const idx = Math.round((new Date(d + 'T00:00:00Z').getTime() - base) / 86400000)
      if (idx < 0 || idx >= dom) return
      if (!byDay[idx]) byDay[idx] = { total: 0, correct: 0 }
      byDay[idx].total++
      if (a.is_correct) byDay[idx].correct++
    })
    const days = []
    let T = 0, C = 0
    for (let i = 0; i < dom; i++) {
      const b = byDay[i]
      const date = new Date(base + i * 86400000).toISOString().slice(0, 10)
      if (b) { T += b.total; C += b.correct; days.push({ d: i + 1, date: date, total: b.total, correct: b.correct, acc: Math.round(b.correct / b.total * 100) }) }
      else days.push({ d: i + 1, date: date, total: 0, correct: 0, acc: null })
    }
    return { start: startStr, days: days, avg: T ? Math.round(C / T * 100) : null, total: T }
  }
  const data = { days: dom, cur: build(curStart), prev: build(prevStart) }
  await db.from('zx_users').update({ acc_cache: { at: new Date().toISOString(), forDate: todayBJ, data: data } }).eq('openid', studentId)
  return data
}

exports.main = async (event) => {
  const p = parseEvent(event)
  const { questionId, answer, selfGrade, knowledgeTags, subject, taskId } = p
  // 【安全】身份只认微信云调用注入的 openid，忽略前端传入的 studentId
  const studentId = getCallerOpenId()
  if (!studentId) return respond(event, { code: -401, message: '无法验证微信身份，请通过 wx.cloud.callFunction 调用', needWxCall: true })
  const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
  const db = app.rdb()
  const nowIso = new Date().toISOString()

  // 【P0-1 错因自选】action=setErrorType：学生把某道错题的错因改为自选四分类
  // （knowledge 知识性 / method 方法性 / reading 审题性 / calc 计算性），覆盖系统推断值。
  if (p.action === 'setErrorType') {
    const ERROR_TYPES = ['knowledge', 'method', 'reading', 'calc']
    if (!questionId || ERROR_TYPES.indexOf(String(p.errorType || '')) < 0) {
      return respond(event, { code: -1, message: '参数不合法' })
    }
    try {
      const wb = await db.from('zx_wrongbook').select('id')
        .eq('student_id', studentId).eq('question_id', questionId).limit(1)
      const w = wb.data && wb.data[0]
      if (!w) return respond(event, { code: -3, message: '该题不在错题本中' })
      const up = await db.from('zx_wrongbook').update({
        error_type: String(p.errorType), error_type_source: 'self'
      }).eq('id', w.id)
      if (up && up.error) throw new Error(up.error.message || '更新错因失败')
      return respond(event, { code: 0, errorType: String(p.errorType), source: 'self' })
    } catch (e) {
      return respond(event, { code: -1, message: e && e.message })
    }
  }
  // 【快速复习】action=reviewAnswer：错题本过卡模式自评（记住了/没记住）。
  // 只做三件事：写作答记录（计入累计刷题）、按与打卡完全相同的方案推进错题排期
  // （FSRS-lite / 艾宾浩斯，攻克判定不变）、按同一规则发放能量（答对 +2、攻克 +30）。
  // 不推进每日任务、不算打卡连续天数。排期公式与下方主流程第 3 节保持一致，改一处须同步另一处。
  if (p.action === 'reviewAnswer') {
    const remembered = p.remembered === true
    if (!questionId) return respond(event, { code: -1, message: '缺少 questionId' })
    try {
      const qr = await db.from('zx_questions').select('*').eq('id', questionId).limit(1)
      const q = qr.data && qr.data[0]
      if (!q) return respond(event, { code: -404, message: '题目不存在' })
      if (q.student_id && q.student_id !== studentId && q.student_id !== 'demo_student') {
        return respond(event, { code: -403, message: '题目不属于当前用户' })
      }
      const wb = await db.from('zx_wrongbook').select('*')
        .eq('student_id', studentId).eq('question_id', questionId).limit(1)
      const w = wb.data && wb.data[0]
      if (!w) return respond(event, { code: -3, message: '该题不在错题本中' })
      if (w.status !== 'active') return respond(event, { code: 0, alreadyConquered: true, conqueredNow: false, granted: 0 })

      const ins = await db.from('zx_answer_record').insert({
        id: genId('a'), student_id: studentId, question_id: questionId,
        task_id: null, answer: JSON.stringify('__review__'),
        is_correct: remembered, self_graded: true, graded_by: 'review',
        attempts: 1, answered_at: nowIso
      })
      if (ins && ins.error) throw new Error('答题记录写入失败：' + (ins.error.message || ''))

      // —— 排期（与主流程第 3 节同公式） ——
      const PLAN_FACTOR = { intensive: 0.7, standard: 1.0, relaxed: 1.4 }
      let planFactor = 1.0
      let reviewPlan = 'standard'
      try {
        const uRes = await db.from('zx_users').select('settings').eq('openid', studentId).limit(1)
        const uRow = uRes.data && uRes.data[0]
        let st = uRow && uRow.settings
        if (typeof st === 'string') { try { st = JSON.parse(st) } catch (e) { st = null } }
        const plan = (st && typeof st === 'object' && st.checkin && st.checkin.reviewPlan) || 'standard'
        reviewPlan = plan
        if (PLAN_FACTOR[plan]) planFactor = PLAN_FACTOR[plan]
      } catch (e) { /* 设置读取失败用标准系数 */ }
      const EBB_LADDER = [1, 2, 4, 7, 15, 30]
      const isEbb = reviewPlan === 'ebbinghaus'
      const STAGE_STABILITY = [1, 3, 7, 15, 30]
      const s0 = Number(w.stability) > 0 ? Number(w.stability)
        : STAGE_STABILITY[Math.max(0, Math.min(4, Number(w.review_stage) || 0))]
      let conqueredNow = false
      let nextReviewAt = null
      let newStatus = 'active'
      if (!remembered) {
        const sFail = isEbb ? 1 : Math.max(0.5, s0 * 0.25)
        const dFail = isEbb ? (Number(w.difficulty) || 5) : Math.min(10, (Number(w.difficulty) || 5) + 1.5)
        nextReviewAt = addDays(nowIso, 1)
        const up = await db.from('zx_wrongbook').update({
          wrong_count: Number(w.wrong_count || 0) + 1, continuous_correct: 0,
          review_stage: 0, stability: sFail, difficulty: dFail,
          next_review_at: nextReviewAt, status: 'active', last_wrong_at: nowIso
        }).eq('id', w.id)
        if (up && up.error) throw new Error('错题更新失败：' + (up.error.message || ''))
      } else {
        const stage = Number(w.review_stage || 0) + 1
        const cc = Number(w.continuous_correct || 0) + 1
        newStatus = (cc >= 2 && stage >= 3) ? 'conquered' : 'active'
        conqueredNow = newStatus === 'conquered'
        const d0 = Number(w.difficulty) || 5
        let s1, d1, gap
        if (isEbb) {
          gap = EBB_LADDER[Math.min(Math.max(0, Number(w.review_stage || 0)), EBB_LADDER.length - 1)]
          s1 = gap; d1 = d0
        } else {
          let f = Math.max(1.2, Math.min(2.4, 2.4 - 0.15 * d0))
          if (w.next_review_at) {
            const overdueDays = (Date.now() - new Date(w.next_review_at).getTime()) / 86400000
            if (overdueDays >= 3) f = f * 1.1
          }
          s1 = Math.min(90, s0 * f)
          d1 = Math.max(1, d0 - 0.3)
          gap = Math.max(1, Math.round(s1 * planFactor))
        }
        nextReviewAt = addDays(nowIso, gap)
        const up = await db.from('zx_wrongbook').update({
          review_stage: stage, continuous_correct: cc, status: newStatus,
          stability: s1, difficulty: d1, next_review_at: nextReviewAt
        }).eq('id', w.id)
        if (up && up.error) throw new Error('错题排期失败：' + (up.error.message || ''))
      }

      // —— 能量（与主流程同规则：答对 +2、攻克 +30；账本裁剪 200 条；等级按累计重算） ——
      let granted = 0
      try {
        const gmRes = await db.from('zx_gamification').select('*').eq('student_id', studentId).limit(1)
        const gm = gmRes.data && gmRes.data[0]
        if (gm) {
          const ledger = parseArr(gm.energy_ledger)
          let energy = Number(gm.energy || 0)
          let earnedAdd = 0
          const addEntry = function (delta, reason) {
            if (!delta) return
            energy += delta
            if (delta > 0) earnedAdd += delta
            ledger.push({ id: genId('e'), delta: delta, reason: reason, at: nowIso })
          }
          if (remembered) addEntry(2, '快速复习答对 +2')
          if (conqueredNow) addEntry(30, '攻克错题 +30')
          granted = earnedAdd
          const totalEarned = Number(gm.total_earned || 0) + earnedAdd
          const lvInfo = spaceLevelOf(totalEarned)
          let level = Number(gm.level || 1)
          let levelHistory = parseArr(gm.level_history)
          if (lvInfo.level > level) {
            level = lvInfo.level
            levelHistory.push({ level: lvInfo.level, name: lvInfo.name, at: nowIso, totalEarned })
            levelHistory = levelHistory.slice(-50)
          }
          const gmUp = await db.from('zx_gamification').update({
            energy, level, total_earned: totalEarned,
            energy_ledger: JSON.stringify(ledger.slice(-200)),
            level_history: JSON.stringify(levelHistory), updated_at: nowIso
          }).eq('student_id', studentId)
          if (gmUp && gmUp.error) console.warn('[submitAnswer] 快速复习养成落库失败', gmUp.error.message || gmUp.error)
        }
      } catch (e) { console.warn('[submitAnswer] 快速复习养成更新失败：', e && e.message) }
      // 答题记录变了：清学情缓存并刷新正确率预计算（与打卡完成同口径）
      try { await db.from('zx_users').update({ study_cache: null }).eq('openid', studentId) } catch (e) {}
      try { await refreshAccCache(db, studentId) } catch (e) {}

      return respond(event, {
        code: 0, correct: remembered, conqueredNow, granted,
        status: newStatus, nextReviewAt
      })
    } catch (e) {
      return respond(event, { code: -1, message: e && e.message })
    }
  }

  if (!questionId) return respond(event, { code: -1, message: '缺少 questionId' })

  try {
    // 0) 读取云端题目，拿到题型与标准答案（判分以云端为准，绝不信任前端 correct）
    const qr = await db.from('zx_questions').select('*').eq('id', questionId).limit(1)
    const q = qr.data && qr.data[0]
    if (!q) return respond(event, { code: -404, message: '题目不存在' })

    // 【安全 v1.9.4】题目归属校验：只能是本人名下题或公共种子题，防止答他人题目刷分
    if (q.student_id && q.student_id !== studentId && q.student_id !== 'demo_student') {
      return respond(event, { code: -403, message: '题目不属于当前用户' })
    }
    // 【安全 v1.9.4】任务归属校验：题目必须在本次打卡任务内
    if (taskId) {
      const tr = await db.from('zx_daily_tasks').select('*').eq('id', taskId).limit(1)
      const taskRow = tr.data && tr.data[0]
      if (!taskRow || taskRow.student_id !== studentId) {
        return respond(event, { code: -403, message: '打卡任务不存在或无权访问' })
      }
      const taskQids = parseArr(taskRow.question_ids)
      if (taskQids.length && taskQids.indexOf(questionId) < 0) {
        return respond(event, { code: -403, message: '该题目不在当前打卡任务中' })
      }
    }

    // 【防刷 v1.9.4】幂等：同一题在同一任务（无 taskId 时按当天）内只允许计分一次。
    // needs_self_grade=true 的占位记录是「AI 判分失败待自评」，不算已答，允许自评后正式提交。
    const prior = await db.from('zx_answer_record').select('*')
      .eq('student_id', studentId).eq('question_id', questionId).limit(50)
    const todayKey = beijingDate()
    const already = (prior.data || []).find(function (r) {
      if (r.needs_self_grade === true) return false
      if (taskId) return r.task_id === taskId
      return String(r.answered_at || '').slice(0, 10) === todayKey
    })
    if (already) {
      const [mDup, wDup] = await Promise.all([
        db.from('zx_mastery').select('*').eq('student_id', studentId).limit(200),
        db.from('zx_wrongbook').select('*').eq('student_id', studentId).limit(200)
      ])
      let gDup = null
      try {
        const gRes = await db.from('zx_gamification').select('*').eq('student_id', studentId).limit(1)
        const grow = gRes.data && gRes.data[0]
        if (grow) gDup = {
          energy: Number(grow.energy || 0), level: Number(grow.level || 1),
          streak: Number(grow.streak || 0), checkinDates: parseArr(grow.checkin_dates),
          badges: parseArr(grow.badges), energyLedger: parseArr(grow.energy_ledger)
        }
      } catch (e) { /* 快照失败不影响幂等返回 */ }
      return respond(event, {
        code: 0, correct: !!already.is_correct, gradedBy: already.graded_by || 'auto',
        duplicate: true, deltas: [],
        mastery: mDup.data || [], wrongbook: wDup.data || [],
        taskProgress: { doneCount: 0, totalCount: 0, finished: false }, gamification: gDup,
        message: '该题本次已作答，未重复计分'
      })
    }

    const type = qt.normalizeType(q.q_type)
    const tags = (knowledgeTags && knowledgeTags.length) ? knowledgeTags : parseArr(q.knowledge_tags)
    // 自评入参归一化：旧版布尔（true=1 / false=0）或新版得分点比例 0..1（按勾选得分点加权）
    const selfRatio = (typeof selfGrade === 'number' && isFinite(selfGrade))
      ? Math.max(0, Math.min(1, selfGrade))
      : (typeof selfGrade === 'boolean' ? (selfGrade ? 1 : 0) : null)

    let grading
    // 自评最终态：定位此前 AI 判分失败写入的占位记录（needs_self_grade=true，当天本题），
    // 直接更新它而非新插一条，避免同一主观题产生两条作答记录。
    let selfPendingId = null
    if (qt.isSubjective(type) && selfRatio !== null) {
      const pendingRows = await db.from('zx_answer_record').select('id')
        .eq('student_id', studentId).eq('question_id', questionId)
        .eq('needs_self_grade', true).limit(10)
      const todayKey = beijingDate()
      const hit = (pendingRows.data || []).find(function (r) {
        return String(r.answered_at || '').slice(0, 10) === todayKey
      }) || (pendingRows.data || [])[0]
      if (hit) selfPendingId = hit.id
    }

    if (qt.isObjective(type)) {
      // ===== 客观题：云端自动判分 =====
      const jr = qt.judgeObjective(q, answer)
      grading = { correct: !!(jr && jr.correct), gradedBy: 'auto', maxScore: Number(q.score) || 2 }
    } else {
      // ===== 主观题：AI 判分，失败降级自评 =====
      if (selfRatio !== null) {
        const maxS = Number(q.score) || 10
        grading = {
          correct: selfRatio >= 0.6, gradedBy: 'self', maxScore: maxS, selfGraded: true,
          score: Math.round(maxS * selfRatio),
          aiComment: '学生自评（得分点 ' + Math.round(selfRatio * 100) + '%）'
        }
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
    const rec = {
      task_id: taskId || null, answer: answer == null ? null : JSON.stringify(answer),
      is_correct: !!correct, self_graded: !!grading.selfGraded,
      graded_by: grading.gradedBy,
      ai_score: (typeof grading.score === 'number' ? grading.score : null),
      ai_max_score: (grading.maxScore || null),
      ai_comment: grading.aiComment || null,
      attempts: 1, answered_at: nowIso
    }
    if (selfPendingId) {
      // 自评最终态：更新占位记录，消除双记录
      await db.from('zx_answer_record').update(Object.assign({}, rec, { needs_self_grade: false })).eq('id', selfPendingId)
    } else {
      await db.from('zx_answer_record').insert(Object.assign({ id: genId('a'), student_id: studentId, question_id: questionId }, rec))
    }

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

    // 3) 维护错题本（答错新增/重置排期；答对按简化 FSRS 递进，P0-2）
    // 调度模型：每道错题维护 stability（记忆稳定性，天）与 difficulty（1-10）。
    // 答对：stability 按难度增长（题越难涨越慢），逾期仍答对额外加成；
    // 答错：stability 回落到 1/4、难度 +1.5、次日再练。
    // 复习方案（密集/标准/舒缓）保留为间隔系数 planFactor。攻克判定不变（连对≥2 且阶段≥3）。
    const PLAN_FACTOR = { intensive: 0.7, standard: 1.0, relaxed: 1.4 }
    let planFactor = 1.0
    let reviewPlan = 'standard'
    try {
      const uRes = await db.from('zx_users').select('settings').eq('openid', studentId).limit(1)
      const uRow = uRes.data && uRes.data[0]
      let st = uRow && uRow.settings
      if (typeof st === 'string') { try { st = JSON.parse(st) } catch (e) { st = null } }
      const plan = (st && typeof st === 'object' && st.checkin && st.checkin.reviewPlan) || 'standard'
      reviewPlan = plan
      if (PLAN_FACTOR[plan]) planFactor = PLAN_FACTOR[plan]
    } catch (e) { /* 设置读取失败用标准系数 */ }
    // 艾宾浩斯方案：不走 FSRS，按遗忘曲线固定间隔阶梯（天）推进，答错回起点
    const EBB_LADDER = [1, 2, 4, 7, 15, 30]
    const isEbb = reviewPlan === 'ebbinghaus'
    const STAGE_STABILITY = [1, 3, 7, 15, 30] // 存量行 stability 缺失时按阶段兜底
    const stageStability = function (row) {
      const s = Number(row && row.stability)
      if (s > 0) return s
      const stg = Math.max(0, Math.min(4, Number(row && row.review_stage) || 0))
      return STAGE_STABILITY[stg]
    }

    const wb = await db.from('zx_wrongbook')
      .select('*').eq('student_id', studentId).eq('question_id', questionId).limit(1)
    const w = wb.data && wb.data[0]

    // 错因推断：多知识点→概念混淆(concept)，单知识点→知识漏洞(knowledge)
    // （更细的审题/计算错因需题型+作答文本分析，此处给出可落地的基础分类）
    const errorType = (tags && tags.length > 1) ? 'concept' : 'knowledge'
    // 本次答题是否让该错题「攻克」：仅当错题状态在本次由 active 变为 conquered 才算，
    // +30 奖励只在这一刻发放（规则：按 1/3/7 天复习、连续答对达标后攻克）
    let conqueredNow = false
    if (!correct) {
      if (!w) {
        // 新错题：stability=1（次日复习）；难度初值按错因——知识性 6、其余 5
        // （学生自选错因后 P0-1 的四分类初值：审题/计算类更易稳住，见 setErrorType 后的后续答题）
        const initDiff = (errorType === 'knowledge' || errorType === 'concept') ? 6 : 5
        const insW = await db.from('zx_wrongbook').insert({
          id: genId('w'), student_id: studentId, question_id: questionId,
          error_type: errorType, error_type_source: 'auto',
          knowledge_tags: JSON.stringify(tags || []),
          wrong_count: 1, continuous_correct: 0, review_stage: 0,
          stability: 1, difficulty: initDiff,
          next_review_at: addDays(nowIso, 1), status: 'active',
          first_wrong_at: nowIso, last_wrong_at: nowIso
        })
        if (insW && insW.error) throw new Error('错题写入失败：' + (insW.error.message || ''))
      } else {
        // 复习/新题再错：stability 回落到 1/4（下限 0.5），难度 +1.5，次日再练；
        // 艾宾浩斯方案回阶梯起点：stability=1、难度不动、次日重来（review_stage 已在下方归 0）
        const sFail = isEbb ? 1 : Math.max(0.5, stageStability(w) * 0.25)
        const dFail = isEbb ? (Number(w.difficulty) || 5) : Math.min(10, (Number(w.difficulty) || 5) + 1.5)
        const upW = await db.from('zx_wrongbook').update({
          wrong_count: Number(w.wrong_count || 0) + 1, continuous_correct: 0,
          review_stage: 0, stability: sFail, difficulty: dFail,
          next_review_at: addDays(nowIso, 1),
          status: 'active', last_wrong_at: nowIso
        }).eq('id', w.id)
        if (upW && upW.error) throw new Error('错题更新失败：' + (upW.error.message || ''))
      }
    } else if (w && w.status === 'active') {
      const stage = Number(w.review_stage || 0) + 1
      const cc = Number(w.continuous_correct || 0) + 1
      const status = (cc >= 2 && stage >= 3) ? 'conquered' : 'active'
      conqueredNow = status === 'conquered'
      const d0 = Number(w.difficulty) || 5
      let s1, d1, gap
      if (isEbb) {
        // 艾宾浩斯阶梯：按复习阶段（本次答对前的 stage）取固定间隔，stability 同步为间隔天数
        gap = EBB_LADDER[Math.min(Math.max(0, Number(w.review_stage || 0)), EBB_LADDER.length - 1)]
        s1 = gap
        d1 = d0
      } else {
        // FSRS 递进：增长因子随难度下降；逾期 ≥3 天仍答对额外 ×1.1
        const s0 = stageStability(w)
        let f = Math.max(1.2, Math.min(2.4, 2.4 - 0.15 * d0))
        if (w.next_review_at) {
          const overdueDays = (Date.now() - new Date(w.next_review_at).getTime()) / 86400000
          if (overdueDays >= 3) f = f * 1.1
        }
        s1 = Math.min(90, s0 * f)
        d1 = Math.max(1, d0 - 0.3)
        gap = Math.max(1, Math.round(s1 * planFactor))
      }
      const upW2 = await db.from('zx_wrongbook').update({
        review_stage: stage, continuous_correct: cc, status,
        stability: s1, difficulty: d1,
        next_review_at: addDays(nowIso, gap)
      }).eq('id', w.id)
      if (upW2 && upW2.error) throw new Error('错题排期失败：' + (upW2.error.message || ''))
    }

    // 4) 推进每日任务进度
    let taskProgress = { doneCount: 0, totalCount: 0, finished: false }
    let makeupResult = null
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
        taskProgress = { doneCount, totalCount, finished, isMakeup: task.is_makeup === true, makeupDate: task.makeup_date || '' }
      }
    }

    // 5) 养成数据上云（服务端权威）
    let gamification = null
    let grantedNow = 0 // 本次答题实际发放的正向能量（前端按场次累加展示，与账本严格一致）
    try {
      const gmRes = await db.from('zx_gamification').select('*').eq('student_id', studentId).limit(1)
      const gm = gmRes.data && gmRes.data[0]
      if (gm) {
        const ledger = parseArr(gm.energy_ledger)
        let energy = Number(gm.energy || 0)
        let earnedAdd = 0 // 本次发放的正向能量，累加进 total_earned（排行榜口径：累计获得，消费不扣）
        const addEntry = function (delta, reason) {
          if (!delta) return
          energy += delta
          if (delta > 0) earnedAdd += delta
          ledger.push({ id: genId('e'), delta: delta, reason: reason, at: nowIso })
        }
        // 答对 +2
        addEntry(correct ? 2 : 0, correct ? '答对题目 +2' : '答错题目 +0')
        // 攻克错题 +30：只在错题状态真正变为 conquered 的这次答题发放（原逻辑误放在
        // 「任务完成」分支里：最后一题恰好是错题重刷答对就发，未达标也发、非最后一题攻克反而不发）
        if (conqueredNow) addEntry(30, '攻克错题 +30')
        grantedNow = earnedAdd
        let level = Number(gm.level || 1)
        let streak = Number(gm.streak || 0)
        let dates = parseArr(gm.checkin_dates)
        if (taskProgress.finished) {
          // 完成打卡后答题记录变了：清掉试卷列表与学情聚合缓存，下次打开对应页面重算
          try { await db.from('zx_users').update({ sources_cache: null, study_cache: null }).eq('openid', studentId) } catch (e) {}
          // 正确率曲线改预计算：此刻把本月/上月同期聚合算好存缓存，首页只读不算
          try { await refreshAccCache(db, studentId) } catch (e) {}
          addEntry(20, '完成每日打卡 +20')
          grantedNow = earnedAdd
          if (taskProgress.isMakeup && taskProgress.makeupDate) {
            // 补签任务全部答完：把补签日计入打卡日期（延续连续性），并真正消耗 1 张补签卡。
            // 用 active 状态做幂等：只有 active.date 匹配且 status=pending 时才扣卡，避免多科/重复提交多扣。
            const mDate = taskProgress.makeupDate
            if (dates.indexOf(mDate) < 0) dates.push(mDate)
            try {
              const uRes = await db.from('zx_users').select('settings').eq('openid', studentId).limit(1)
              const uRow = uRes.data && uRes.data[0]
              let us = uRow && uRow.settings
              if (typeof us === 'string') { try { us = JSON.parse(us) } catch (e) { us = {} } }
              if (!us || typeof us !== 'object') us = {}
              const active = us.makeup && us.makeup.active
              if (active && active.date === mDate && active.status === 'pending') {
                const cards = Number(us.makeup.cards) || 0
                us.makeup.cards = Math.max(0, cards - 1)
                us.makeup.used = (us.makeup.used || []).concat([{ date: mDate, at: nowIso, status: 'done' }]).slice(-100)
                us.makeup.active = null
                await db.from('zx_users').update({ settings: us }).eq('openid', studentId)
                makeupResult = { date: mDate, cards: us.makeup.cards }
              }
            } catch (e) { console.warn('[submitAnswer] 补签结算失败：', e && e.message) }
          } else {
            const today = beijingDate()
            if (dates.indexOf(today) < 0) dates.push(today)
            const yesterday = beijingDate(Date.now() - 86400000)
            const lastDate = gm.last_checkin_date ? String(gm.last_checkin_date).slice(0, 10) : ''
            streak = lastDate === yesterday ? streak + 1 : (lastDate === today ? streak : 1)
            await db.from('zx_gamification').update({ last_checkin_date: today }).eq('student_id', studentId)
          }
          dates.sort()
        }
        // 账本最多保留 200 条
        const ledgerTrim = ledger.slice(-200)
        const totalEarned = Number(gm.total_earned || 0) + earnedAdd
        // 2.0 探索等级：按累计星能量重算（替代旧的按余额分级），只升不降、可跨级，升级写历史
        const lvInfo = spaceLevelOf(totalEarned)
        let levelHistory = parseArr(gm.level_history)
        if (lvInfo.level > level) {
          level = lvInfo.level
          levelHistory.push({ level: lvInfo.level, name: lvInfo.name, at: nowIso, totalEarned })
          levelHistory = levelHistory.slice(-50)
        }
        const gmUp = await db.from('zx_gamification').update({
          energy, level, streak, checkin_dates: JSON.stringify(dates),
          energy_ledger: JSON.stringify(ledgerTrim), total_earned: totalEarned,
          level_history: JSON.stringify(levelHistory), updated_at: nowIso
        }).eq('student_id', studentId)
        if (gmUp && gmUp.error) console.warn('[submitAnswer] 养成落库失败', gmUp.error.message || gmUp.error)
        gamification = { energy, level, streak, checkinDates: dates, badges: parseArr(gm.badges), energyLedger: ledgerTrim, totalEarned, levelHistory }
      }
    } catch (e) { console.warn('[submitAnswer] 养成数据更新失败：', e && e.message) }

    // 6) 回读快照（提高上限，避免掌握度/错题较多时截断）
    const [masteryRes, wrongRes] = await Promise.all([
      db.from('zx_mastery').select('*').eq('student_id', studentId).limit(500),
      db.from('zx_wrongbook').select('*').eq('student_id', studentId).limit(500)
    ])

    // 7) 成就徽章触发：基于权威快照判定应解锁徽章，合并去重后写回。
    //    幂等：每次答题都重算，已解锁的永久保留；新解锁的通过 newBadges 返回给前端弹窗。
    let newBadges = []
    try {
      const gmRes2 = await db.from('zx_gamification').select('*').eq('student_id', studentId).limit(1)
      const gm2 = gmRes2.data && gmRes2.data[0]
      if (gm2) {
        const owned = parseArr(gm2.badges)
        const masteryAll = masteryRes.data || []
        const wrongAll = wrongRes.data || []
        const correctTotalRes = await db.from('zx_answer_record').select('id')
          .eq('student_id', studentId).eq('is_correct', true).limit(1000)
        const ctx = {
          energy: Number(gm2.energy) || 0,
          streak: Number(gm2.streak) || 0,
          checkinCount: parseArr(gm2.checkin_dates).length,
          correctTotal: (correctTotalRes.data || []).length,
          conqueredCount: wrongAll.filter(function (w) { return w.status === 'conquered' }).length,
          masteredCount: masteryAll.filter(function (m) { return Number(m.score) >= 85 }).length
        }
        const earned = badges.evaluate(ctx)
        const merged = badges.merge(owned, earned)
        newBadges = merged.filter(function (id) { return owned.indexOf(id) < 0 })
        if (newBadges.length) {
          await db.from('zx_gamification').update({
            badges: JSON.stringify(merged), updated_at: nowIso
          }).eq('student_id', studentId)
        }
        if (gamification) gamification.badges = merged
      }
    } catch (e) { console.warn('[submitAnswer] 徽章判定失败：', e && e.message) }

    return respond(event, {
      code: 0, correct, granted: grantedNow, conqueredNow, gradedBy: grading.gradedBy,
      score: (typeof grading.score === 'number' ? grading.score : undefined),
      maxScore: grading.maxScore || undefined,
      aiComment: grading.aiComment || undefined,
      deltas,
      mastery: masteryRes.data || [], wrongbook: wrongRes.data || [],
      taskProgress, gamification, newBadges, makeupResult
    })
  } catch (e) {
    return respond(event, { code: -1, message: e && e.message })
  }
}
