/**
 * 云函数 composeTask —— 按掌握度智能组卷（PostgreSQL 版）
 *
 * 使用 @cloudbase/js-sdk v3 的 app.rdb() 访问 PG。
 * 算法（艾宾浩斯版）：每天固定 10 题 = 到期错题优先(最多5道) + 已启用题库按序补齐；
 *   科目宽松匹配(兼容 英语/English/初中英语/带空格)；当天任务题数不足10时自动重新组卷覆盖，
 *   修复早期只组到 1 题的历史任务；返回 composition/note 便于前端展示诊断信息。
 *
 * 返回（关键）：除了 task，还返回题目详情 questions[]，前端直接用云端题目渲染，
 * 不再依赖本地题库（本地 Storage 仅作为展示缓存 / 降级兜底）。
 *
 * 分科目：入参 subject（'综合'=全部科目混出，或具体科目如'数学'/'英语'）。
 *   题目池按科目过滤；薄弱点/强项只取该科目题目标签；错题只取该科目的。
 *   每天每科各一个独立任务：按 (student_id, task_date, subject) 唯一。
 *   各科互不干扰：当天本科目已有任务即复用（继续答/已完成），其它科目不受影响，
 *   可一天内分别为多个科目打卡。
 *
 * 入参：{ studentId(忽略，身份来自云端), subject? }
 * 出参：{ code:0, task(含 subject), questions:[{id, q_type, stem, options, answer, scoring_points, score, analysis, tags, subject, confidence}] }
 *   全题型透传：q_type 决定前端控件与判分方式；主观题带 scoring_points/score 供 AI 判分。
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

/**
 * HTTP 网关适配：HTTP 触发时业务参数在 event.body（字符串，可能 base64），
 * wx.cloud 直传时参数直接在 event 上。这里统一解析，让业务逻辑无需关心入口。
 */
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
// 出口：HTTP 触发返回集成响应；wx.cloud 直传返回原对象
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
// 把 PG 的一行题目归一化为前端可直接渲染/判题的结构
// 全题型：透传 q_type / 选项 / 答案(可为下标、下标数组或文本) / 评分要点 / 分值
function normalizeQuestion(q) {
  const qt = require('./questionTypes.js')
  const type = qt.normalizeType(q.q_type)
  const opts = parseArr(q.options)
  const ans = qt.asValue(q.answer) // 单选=数字, 多选=数组, 填空=字符串/数组, 主观题=参考答案文本
  return {
    id: q.id,
    q_type: type,
    stem: q.stem || '',
    stem_images: parseArr(q.stem_images),
    options: opts,
    answer: ans,
    scoring_points: qt.asValue(q.scoring_points) || [], // 主观题评分要点 [{point,score}]
    score: Number(q.score) || (qt.isSubjective(type) ? 10 : 2),
    analysis: q.analysis || '',
    tags: parseArr(q.knowledge_tags),
    knowledge_points: parseArr(q.knowledge_points),
    subject: q.subject || '',
    confidence: Number(q.confidence) || 1
  }
}

exports.main = async (event) => {
  const p = parseEvent(event)
  // 【安全】身份只认微信云调用注入的 openid，忽略前端传入的 studentId
  const studentId = getCallerOpenId()
  if (!studentId) return respond(event, { code: -401, message: '无法验证微信身份，请通过 wx.cloud.callFunction 调用', needWxCall: true })
  const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
  const db = app.rdb()
  const today = new Date().toISOString().slice(0, 10)
  const wantSubject = p.subject && p.subject !== '综合' ? String(p.subject).slice(0, 20) : ''
  const taskSubject = wantSubject || '综合' // 本任务归属科目（'综合'=混科）

  try {
    const DAILY_GOAL = 10      // 每天固定 10 题
    const WRONG_CAP = 5        // 艾宾浩斯到期错题最多取 5 道

    // 科目宽松匹配：兼容「英语 / English / 初中英语 / 带空格」等写法，修复精确匹配漏题
    const SUBJECT_ALIAS = {
      '英语': ['英语', 'english'], '数学': ['数学', 'math', 'maths'],
      '语文': ['语文', 'chinese'], '物理': ['物理', 'physics'],
      '化学': ['化学', 'chemistry'], '生物': ['生物', 'biology'],
      '历史': ['历史', 'history'], '地理': ['地理', 'geography']
    }
    function subjMatch(qs, want) {
      if (!want) return true // 综合=全部
      const s = String(qs == null ? '' : qs).trim().toLowerCase()
      const w = String(want).trim().toLowerCase()
      if (!s) return false
      if (s === w || s.indexOf(w) >= 0 || w.indexOf(s) >= 0) return true
      const aliases = SUBJECT_ALIAS[want] || SUBJECT_ALIAS[w] || []
      return aliases.some(function (a) { return s === a || s.indexOf(a) >= 0 })
    }

    // ===== 1) 当天该科已有任务：题数达标(≥10)才复用；不足则重新组卷并覆盖，修复早期只组到 1 题的历史任务 =====
    let existingTask = null
    const exist = await db.from('zx_daily_tasks')
      .select('*').eq('student_id', studentId).eq('task_date', today)
      .eq('subject', taskSubject).limit(1)
    if (exist.data && exist.data.length) {
      const t0 = exist.data[0]
      const oldIds = parseArr(t0.question_ids)
      if (oldIds.length >= DAILY_GOAL) {
        const questions = await hydrateQuestions(db, t0)
        if (questions.length >= DAILY_GOAL) return respond(event, { code: 0, task: t0, questions, subject: taskSubject })
      }
      existingTask = t0 // 题数不足，下面重新组卷并 update 覆盖
    }

    // ===== 2) 题池：本人已确认题，内存里做「启用过滤 + 科目宽松匹配」，避免 eq 精确匹配漏题 =====
    const poolRes = await db.from('zx_questions').select('*').eq('student_id', studentId).eq('confirmed', true).limit(500)
    const allConfirmed = poolRes.data || []
    // enabled=false 视为停用；默认 true 兼容老数据 null/undefined
    const pool = allConfirmed.filter(function (q) { return q.enabled !== false && subjMatch(q.subject, wantSubject) })
    const poolIds = new Set(pool.map(function (q) { return q.id }))
    const poolMap = {}
    pool.forEach(function (q) { poolMap[q.id] = q })

    // ===== 3) 艾宾浩斯到期错题：active + 到期(next_review_at<=now)，按到期时间升序，最多 WRONG_CAP 道 =====
    const wrongsAll = await db.from('zx_wrongbook')
      .select('*').eq('student_id', studentId).eq('status', 'active')
      .lte('next_review_at', new Date().toISOString()).limit(100)
    const wrongs = (wrongsAll.data || [])
      .filter(function (w) { return poolIds.has(w.question_id) })
      .sort(function (a, b) { return String(a.next_review_at || '').localeCompare(String(b.next_review_at || '')) })
      .slice(0, WRONG_CAP)
    const wrongQids = wrongs.map(function (w) { return w.question_id })

    // ===== 4) 组题：错题优先 → 已启用题库按「薄弱优先」自适应补齐到 10 题 =====
    // 自适应：读取学生掌握度，题目按其知识点平均掌握度升序排列（越薄弱越优先），
    // 掌握度越高越靠后（"毕业"机制）；同一知识点短时间内最多 2 道，避免重复消耗。
    let masteryMap = {}
    try {
      const mRes = await db.from('zx_mastery').select('knowledge_id,score').eq('student_id', studentId).limit(500)
      ;(mRes.data || []).forEach(function (m) { masteryMap[m.knowledge_id] = Number(m.score) || 50 })
    } catch (e) { /* 掌握度读取失败则退回按序补齐 */ }
    const tagScore = function (q) {
      const tags = parseArr(q.knowledge_tags)
      if (!tags.length) return 50
      let sum = 0, n = 0
      tags.forEach(function (t) { if (typeof masteryMap[t] === 'number') { sum += masteryMap[t]; n++ } })
      return n ? (sum / n) : 50
    }
    // 薄弱优先排序：掌握度低在前；同分保持原顺序（稳定排序）
    const ranked = pool.map(function (q, i) { return { q: q, i: i, s: tagScore(q) } })
      .sort(function (a, b) { return (a.s - b.s) || (a.i - b.i) })
      .map(function (x) { return x.q })

    const picked = []
    const seen = new Set()
    const tagCount = {}
    const TAG_CAP = 2
    for (const qid of wrongQids) {
      const q = poolMap[qid]
      if (q && !seen.has(q.id)) {
        picked.push(q); seen.add(q.id)
        parseArr(q.knowledge_tags).forEach(function (t) { tagCount[t] = (tagCount[t] || 0) + 1 })
      }
    }
    // 第一轮：薄弱优先，尊重同知识点 ≤2 上限
    for (const q of ranked) {
      if (picked.length >= DAILY_GOAL) break
      if (seen.has(q.id)) continue
      const tags = parseArr(q.knowledge_tags)
      if (tags.length && tags.every(function (t) { return (tagCount[t] || 0) >= TAG_CAP })) continue
      picked.push(q); seen.add(q.id)
      tags.forEach(function (t) { tagCount[t] = (tagCount[t] || 0) + 1 })
    }
    // 第二轮：若去重后不足 10 题，放宽知识点上限按序补足（保证每天满 10 题）
    for (const q of ranked) {
      if (picked.length >= DAILY_GOAL) break
      if (seen.has(q.id)) continue
      picked.push(q); seen.add(q.id)
    }

    if (!picked.length) {
      const enabledTotal = allConfirmed.filter(function (q) { return q.enabled !== false }).length
      return respond(event, {
        code: -2,
        message: '【' + (wantSubject || '综合') + '】科目暂无可用题目。已确认启用题共 ' + enabledTotal + ' 道，但本科目匹配 0 道。请在「我的试卷」确认该科题目已勾选启用，或导入并确认该科题目。',
        emptySubject: wantSubject || '综合',
        diag: { confirmedTotal: allConfirmed.length, enabledTotal: enabledTotal, subjectMatched: 0, wantSubject: wantSubject }
      })
    }

    const questions = picked.slice(0, DAILY_GOAL).map(normalizeQuestion)
    const ids = questions.map(function (q) { return q.id })
    const bankCount = picked.length - wrongQids.length
    const composition = {
      wrong: wrongQids.length, bank: bankCount, goal: DAILY_GOAL, subject: taskSubject,
      actual: ids.length, confirmedTotal: allConfirmed.length,
      enabledSubjectTotal: pool.length, rebuilt: !!existingTask, generatedAt: new Date().toISOString()
    }
    const taskPayload = {
      subject: taskSubject,
      question_ids: JSON.stringify(ids),
      composition: JSON.stringify(composition),
      status: 'pending', total_count: ids.length, done_count: 0,
      started_at: null, finished_at: null
    }
    let task
    if (existingTask) {
      // 覆盖旧任务（题数不足的历史任务），保留原 id / 创建时间
      await db.from('zx_daily_tasks').update(Object.assign({}, taskPayload, { updated_at: new Date().toISOString() })).eq('id', existingTask.id)
      task = Object.assign({}, existingTask, taskPayload)
    } else {
      taskPayload.created_at = new Date().toISOString()
      task = Object.assign({ id: genId('t'), student_id: studentId, task_date: today }, taskPayload)
      await db.from('zx_daily_tasks').insert(task)
    }
    const note = '本次组卷：到期错题 ' + wrongQids.length + ' 道 + 题库（薄弱优先）' + bankCount + ' 道 = ' + ids.length + ' 题；本科目已确认启用题共 ' + pool.length + ' 道' +
      (ids.length < DAILY_GOAL ? '（题库不足10题，已取全部）' : '') + (existingTask ? '；已刷新旧任务' : '')
    // question_ids 以数组返回，前端免解析；同时保留字符串字段兼容老逻辑
    return respond(event, { code: 0, task: Object.assign({}, task, { question_ids: ids }), questions, subject: taskSubject, note, composition })
  } catch (e) {
    return respond(event, { code: -1, message: e && e.message })
  }
}

// 已有任务时，按 question_ids 顺序把题目详情查出来一并返回
async function hydrateQuestions(db, task) {
  const ids = parseArr(task.question_ids)
  if (!ids.length) return []
  const res = await db.from('zx_questions').select('*').eq('student_id', task.student_id).limit(500)
  const map = {}
  ;(res.data || []).forEach(q => { map[q.id] = q })
  return ids.map(id => map[id]).filter(Boolean).map(normalizeQuestion)
}
