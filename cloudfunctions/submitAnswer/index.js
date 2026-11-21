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

function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}
function addDays(base, days) {
  const d = new Date(base); d.setDate(d.getDate() + days); return d.toISOString()
}

exports.main = async (event) => {
  const { studentId, questionId, answer, correct, knowledgeTags, subject, taskId } = event
  if (!studentId || !questionId) return { code: -1, message: '缺少 studentId/questionId' }
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
        const finished = doneCount >= totalCount
        await db.from('zx_daily_tasks').update({
          done_count: doneCount,
          status: finished ? 'done' : task.status,
          finished_at: finished ? nowIso : null,
          started_at: task.started_at || nowIso
        }).eq('id', taskId)
        taskProgress = { doneCount, totalCount, finished }
      }
    }

    // 5) 回读快照，供前端把缓存刷新为云端最新状态
    const [masteryRes, wrongRes] = await Promise.all([
      db.from('zx_mastery').select('*').eq('student_id', studentId).limit(200),
      db.from('zx_wrongbook').select('*').eq('student_id', studentId).limit(200)
    ])

    return {
      code: 0, deltas,
      mastery: masteryRes.data || [], wrongbook: wrongRes.data || [],
      taskProgress
    }
  } catch (e) {
    return { code: -1, message: e && e.message }
  }
}
