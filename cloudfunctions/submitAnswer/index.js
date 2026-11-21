/**
 * 云函数 submitAnswer —— 批改 + 掌握度更新 + 错题间隔重刷排期（PostgreSQL 版）
 *
 * 使用 @cloudbase/js-sdk v3 的 app.rdb() 访问 PG；云函数环境自动注入管理员凭证。
 * 表：answer_record / mastery / wrongbook（字段见 cloudbase/migrations）
 *
 * 入参：{ studentId, questionId, answer, correct, knowledgeTags, subject, taskId }
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
    await db.from('answer_record').insert({
      id: genId('a'), student_id: studentId, question_id: questionId,
      task_id: taskId || null, answer: answer == null ? null : JSON.stringify(answer),
      is_correct: !!correct, attempts: 1, answered_at: nowIso
    })

    // 2) 更新每个知识点掌握度（upsert 后用 select 读回再算，或直接 read→update）
    for (const kid of (knowledgeTags || [])) {
      const cur = await db.from('mastery')
        .select('*').eq('student_id', studentId).eq('knowledge_id', kid).limit(1)
      let score, total, corr
      const row = cur.data && cur.data[0]
      if (row) {
        const s = Number(row.score)
        score = correct ? s + 12 * (1 - s / 100) : s - 15
        total = Number(row.total_answered || 0) + 1
        corr = Number(row.total_correct || 0) + (correct ? 1 : 0)
        score = Math.max(0, Math.min(100, Math.round(score)))
        const trend = score > s ? 'rising' : (score < s ? 'falling' : 'stable')
        await db.from('mastery').update({
          score, total_answered: total, total_correct: corr, trend, updated_at: nowIso
        }).eq('id', row.id)
      } else {
        score = correct ? 62 : 35
        await db.from('mastery').insert({
          id: genId('m'), student_id: studentId, knowledge_id: kid,
          subject: subject || null, score, total_answered: 1,
          total_correct: correct ? 1 : 0, trend: correct ? 'rising' : 'falling',
          updated_at: nowIso
        })
      }
    }

    // 3) 维护错题本
    const wb = await db.from('wrongbook')
      .select('*').eq('student_id', studentId).eq('question_id', questionId).limit(1)
    const w = wb.data && wb.data[0]

    if (!correct) {
      if (!w) {
        await db.from('wrongbook').insert({
          id: genId('w'), student_id: studentId, question_id: questionId,
          knowledge_tags: JSON.stringify(knowledgeTags || []),
          wrong_count: 1, continuous_correct: 0, review_stage: 0,
          next_review_at: addDays(nowIso, 1), status: 'active',
          first_wrong_at: nowIso, last_wrong_at: nowIso
        })
      } else {
        await db.from('wrongbook').update({
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
      await db.from('wrongbook').update({
        review_stage: stage, continuous_correct: cc, status,
        next_review_at: addDays(nowIso, gap)
      }).eq('id', w.id)
    }

    return { code: 0 }
  } catch (e) {
    return { code: -1, message: e && e.message }
  }
}
