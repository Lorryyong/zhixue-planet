/**
 * 云函数 composeTask —— 按掌握度智能组卷（PostgreSQL 版）
 *
 * 使用 @cloudbase/js-sdk v3 的 app.rdb() 访问 PG。
 * 算法：薄弱知识点(score<60) + 到期错题 + 强项巩固，去重凑 10 题，写入 daily_tasks。
 *
 * 返回（关键）：除了 task，还返回题目详情 questions[]，前端直接用云端题目渲染，
 * 不再依赖本地题库（本地 Storage 仅作为展示缓存 / 降级兜底）。
 *
 * 入参：{ studentId }
 * 出参：{ code:0, task, questions:[{id, stem, options, answer, analysis, tags, subject, confidence}] }
 */
const cloudbase = require('@cloudbase/js-sdk')

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
  const { studentId } = event
  if (!studentId) return { code: -1, message: '缺少 studentId' }
  const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
  const db = app.rdb()
  const today = new Date().toISOString().slice(0, 10)

  try {
    // 已有当日任务则直接返回，保证一天一组、稳定复现
    const exist = await db.from('zx_daily_tasks')
      .select('*').eq('student_id', studentId).eq('task_date', today).limit(1)
    if (exist.data && exist.data.length) {
      const task = exist.data[0]
      return { code: 0, task, questions: await hydrateQuestions(db, task) }
    }

    // 1) 薄弱知识点（score < 60）
    const blind = await db.from('zx_mastery')
      .select('*').eq('student_id', studentId).lt('score', 60)
      .order('score', { ascending: true }).limit(6)
    // 2) 到期错题
    const wrongs = await db.from('zx_wrongbook')
      .select('*').eq('student_id', studentId).eq('status', 'active')
      .lte('next_review_at', new Date().toISOString()).limit(20)
    // 3) 强项巩固（score >= 85）
    const strong = await db.from('zx_mastery')
      .select('*').eq('student_id', studentId).gte('score', 85).limit(1)

    const blindTags = (blind.data || []).map(m => m.knowledge_id)
    const wrongQids = (wrongs.data || []).map(w => w.question_id)
    const strongTag = strong.data && strong.data.length ? strong.data[0].knowledge_id : null

    // 4) 取题：拉取该学生全部已确认题，再按标签/错题 id 在内存筛选（题量小，简单可靠）
    const poolRes = await db.from('zx_questions')
      .select('*').eq('student_id', studentId).eq('confirmed', true).limit(500)
    const pool = poolRes.data || []

    const picked = []
    const seen = new Set()
    // 优先到期错题
    for (const qid of wrongQids) {
      const q = pool.find(x => x.id === qid)
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

    const questions = picked.slice(0, 10).map(normalizeQuestion)
    const ids = questions.map(q => q.id)
    const task = {
      id: genId('t'), student_id: studentId, task_date: today,
      question_ids: JSON.stringify(ids),
      composition: JSON.stringify({ blind: blindTags.length, wrong: wrongQids.length, cons: strongTag ? 1 : 0 }),
      status: 'pending', total_count: ids.length, done_count: 0, created_at: new Date().toISOString()
    }
    await db.from('zx_daily_tasks').insert(task)
    // question_ids 以数组返回，前端免解析；同时保留字符串字段兼容老逻辑
    return { code: 0, task: Object.assign({}, task, { question_ids: ids }), questions }
  } catch (e) {
    return { code: -1, message: e && e.message }
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
