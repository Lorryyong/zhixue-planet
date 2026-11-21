/**
 * 云函数 composeTask —— 按掌握度智能组卷（PostgreSQL 版）
 *
 * 使用 @cloudbase/js-sdk v3 的 app.rdb() 访问 PG。
 * 算法：薄弱知识点(score<60) + 到期错题 + 强项巩固，去重凑 10 题，写入 daily_tasks。
 *
 * 返回（关键）：除了 task，还返回题目详情 questions[]，前端直接用云端题目渲染，
 * 不再依赖本地题库（本地 Storage 仅作为展示缓存 / 降级兜底）。
 *
 * 分科目：入参 subject（'综合'=全部科目混出，或具体科目如'数学'/'英语'）。
 *   题目池按科目过滤；薄弱点/强项只取该科目题目标签；错题只取该科目的。
 *   一天仍只一个任务。当天已有任务：科目相同→复用；科目不同且未开始→删除重建；
 *   已开始答题→返回原任务（附带实际 subject，前端据此显示）。
 *
 * 入参：{ studentId(忽略，身份来自云端), subject? }
 * 出参：{ code:0, task(含 subject), questions:[{id, stem, options, answer, analysis, tags, subject, confidence}] }
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
function normalizeQuestion(q) {
  const opts = parseArr(q.options)
  let ans = q.answer
  if (Array.isArray(ans)) ans = ans.length ? ans[0] : 0
  if (ans && typeof ans === 'object') ans = 0
  ans = Number(ans) || 0
  return {
    id: q.id,
    stem: q.stem || '',
    options: opts,
    answer: ans,
    analysis: q.analysis || '',
    tags: parseArr(q.knowledge_tags),
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
  let rebuildTaskId = '' // 科目变化且未开始时，复用该任务行做 update

  try {
    // 已有当日任务：同科目→复用；科目不同→看是否已开始答题
    const exist = await db.from('zx_daily_tasks')
      .select('*').eq('student_id', studentId).eq('task_date', today).limit(1)
    if (exist.data && exist.data.length) {
      const task = exist.data[0]
      const taskSubject = task.subject || '综合'
      const sameSubject = (!wantSubject && taskSubject === '综合') || (wantSubject === taskSubject)
      if (sameSubject) {
        return respond(event, { code: 0, task, questions: await hydrateQuestions(db, task) })
      }
      // 科目不同：只有尚未开始答题(done_count=0)才允许改科目重建
      if (Number(task.done_count || 0) > 0 || task.status === 'done') {
        return respond(event, {
          code: 0, task, questions: await hydrateQuestions(db, task),
          note: '今日已开始答题，科目锁定为「' + taskSubject + '」，明天可换科目'
        })
      }
      // 未开始：标记待重建，下面组卷后 update 这一行（避免依赖 delete）
      rebuildTaskId = task.id
    }

    // 4) 取题池：按科目过滤（综合=全部），一次查询后在内存做智能筛选
    const qb = db.from('zx_questions').select('*').eq('student_id', studentId).eq('confirmed', true)
    if (wantSubject) qb.eq('subject', wantSubject)
    const poolRes = await qb.limit(500)
    const pool = poolRes.data || []
    const poolIds = new Set(pool.map(function (q) { return q.id }))
    const subjectTags = new Set()
    pool.forEach(function (q) { parseArr(q.knowledge_tags).forEach(function (t) { subjectTags.add(t) }) })

    // 1) 薄弱知识点（score < 60），只保留本科目题目标签
    const blindAll = await db.from('zx_mastery')
      .select('*').eq('student_id', studentId).lt('score', 60)
      .order('score', { ascending: true }).limit(50)
    const blind = (blindAll.data || []).filter(function (m) { return subjectTags.has(m.knowledge_id) }).slice(0, 6)
    // 2) 到期错题，只保留本科目题目
    const wrongsAll = await db.from('zx_wrongbook')
      .select('*').eq('student_id', studentId).eq('status', 'active')
      .lte('next_review_at', new Date().toISOString()).limit(50)
    const wrongs = (wrongsAll.data || []).filter(function (w) { return poolIds.has(w.question_id) }).slice(0, 20)
    // 3) 强项巩固（score >= 85），只保留本科目题目标签
    const strongAll = await db.from('zx_mastery')
      .select('*').eq('student_id', studentId).gte('score', 85).limit(50)
    const strong = (strongAll.data || []).find(function (m) { return subjectTags.has(m.knowledge_id) })

    const blindTags = blind.map(function (m) { return m.knowledge_id })
    const wrongQids = wrongs.map(function (w) { return w.question_id })
    const strongTag = strong ? strong.knowledge_id : null

    const picked = []
    const seen = new Set()
    // 优先到期错题
    for (const qid of wrongQids) {
      const q = pool.find(function (x) { return x.id === qid })
      if (q && !seen.has(q.id)) { picked.push(q); seen.add(q.id) }
    }
    // 再按薄弱知识点标签补题
    for (const tag of blindTags) {
      for (const q of pool) {
        if (picked.length >= 10) break
        if (seen.has(q.id)) continue
        if (parseArr(q.knowledge_tags).indexOf(tag) >= 0) { picked.push(q); seen.add(q.id) }
      }
      if (picked.length >= 10) break
    }
    // 强项巩固
    if (strongTag && picked.length < 10) {
      for (const q of pool) {
        if (picked.length >= 10) break
        if (seen.has(q.id)) continue
        if (parseArr(q.knowledge_tags).indexOf(strongTag) >= 0) { picked.push(q); seen.add(q.id) }
      }
    }
    // 不足则按题库顺序补齐
    for (const q of pool) {
      if (picked.length >= 10) break
      if (seen.has(q.id)) continue
      picked.push(q); seen.add(q.id)
    }

    if (!picked.length) {
      return respond(event, { code: -2, message: '【' + (wantSubject || '综合') + '】科目暂无题目，请先在「题库批量导入」导入该科题目', emptySubject: wantSubject || '综合' })
    }

    const questions = picked.slice(0, 10).map(normalizeQuestion)
    const ids = questions.map(function (q) { return q.id })
    const taskSubject = wantSubject || '综合'
    const taskPayload = {
      subject: taskSubject,
      question_ids: JSON.stringify(ids),
      composition: JSON.stringify({ blind: blindTags.length, wrong: wrongQids.length, cons: strongTag ? 1 : 0, subject: taskSubject }),
      status: 'pending', total_count: ids.length, done_count: 0,
      started_at: null, finished_at: null, created_at: new Date().toISOString()
    }
    let task
    if (rebuildTaskId) {
      // 复用原任务行，仅更新内容（科目变化重建）
      await db.from('zx_daily_tasks').update(taskPayload).eq('id', rebuildTaskId)
      task = Object.assign({ id: rebuildTaskId, student_id: studentId, task_date: today }, taskPayload)
    } else {
      task = Object.assign({ id: genId('t'), student_id: studentId, task_date: today }, taskPayload)
      await db.from('zx_daily_tasks').insert(task)
    }
    // question_ids 以数组返回，前端免解析；同时保留字符串字段兼容老逻辑
    return respond(event, { code: 0, task: Object.assign({}, task, { question_ids: ids }), questions })
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
