/**
 * 云函数 submitAnswer —— 批改 + 掌握度更新 + 错题间隔重刷排期
 *
 * 生产版：写入 answer_record，更新 mastery，维护 wrongbook 的 review_stage / next_review_at。
 * 算法与前端 utils/store.js 中 submitAnswer 一致。
 *
 * 入参：{ studentId, questionId, answer, correct, knowledgeTags }
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

function addDays(base, days) {
  const d = new Date(base); d.setDate(d.getDate() + days); return d
}

exports.main = async (event) => {
  const { studentId, questionId, answer, correct, knowledgeTags } = event
  const now = new Date()

  // 1) 写作答记录
  await db.collection('answer_record').add({
    data: { student_id: studentId, question_id: questionId, answer, is_correct: correct, answered_at: now }
  })

  // 2) 更新每个知识点的掌握度
  for (const kid of knowledgeTags) {
    const m = await db.collection('mastery').where({ student_id: studentId, knowledge_id: kid }).get()
    if (!m.data.length) continue
    const cur = m.data[0]
    let score = correct ? cur.score + 12 * (1 - cur.score / 100) : cur.score - 15
    score = Math.max(0, Math.min(100, Math.round(score)))
    await db.collection('mastery').doc(cur._id).update({
      data: { score, total: _.inc(1), correct: _.inc(correct ? 1 : 0), updated_at: now }
    })
  }

  // 3) 维护错题本
  const wb = await db.collection('wrongbook').where({ student_id: studentId, question_id: questionId }).get()
  if (!correct) {
    if (!wb.data.length) {
      await db.collection('wrongbook').add({
        data: { student_id: studentId, question_id: questionId, wrong_count: 1, continuous_correct: 0, review_stage: 0, next_review_at: addDays(now, 1), status: 'active' }
      })
    } else {
      const w = wb.data[0]
      await db.collection('wrongbook').doc(w._id).update({
        data: { wrong_count: _.inc(1), continuous_correct: 0, review_stage: 0, next_review_at: addDays(now, 1), status: 'active' }
      })
    }
  } else if (wb.data.length && wb.data[0].status === 'active') {
    const w = wb.data[0]
    const stage = w.review_stage + 1
    const gap = [1, 3, 7][Math.min(stage - 1, 2)]
    const cc = w.continuous_correct + 1
    const status = (cc >= 2 && stage >= 3) ? 'conquered' : 'active'
    await db.collection('wrongbook').doc(w._id).update({
      data: { review_stage: stage, continuous_correct: cc, status, next_review_at: addDays(now, gap) }
    })
  }

  return { code: 0 }
}
