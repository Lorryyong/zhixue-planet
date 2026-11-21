/**
 * 云函数 composeTask —— 按掌握度智能组卷
 *
 * 生产版：从云数据库读取 mastery / wrongbook / questions，按权重组 10 题。
 * 算法与前端 utils/store.js 中 composeTask 一致，可直接对照移植。
 *
 * 集合：mastery(student_id, knowledge_id, score) / wrongbook / questions
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event) => {
  const { studentId } = event
  const today = new Date().toISOString().slice(0, 10)

  // 已有当日任务则直接返回，保证稳定
  const exist = await db.collection('daily_tasks').where({ student_id: studentId, task_date: today }).get()
  if (exist.data.length) return { code: 0, task: exist.data[0] }

  // 1) 薄弱知识点（score < 60）
  const blind = await db.collection('mastery').where({ student_id: studentId, score: _.lt(60) }).orderBy('score', 'asc').limit(6).get()
  // 2) 到期错题
  const wrongs = await db.collection('wrongbook').where({ student_id: studentId, status: 'active', next_review_at: _.lte(new Date()) }).get()
  // 3) 已掌握巩固题（score >= 85）
  const strong = await db.collection('mastery').where({ student_id: studentId, score: _.gte(85) }).limit(1).get()

  const blindTags = blind.data.map(m => m.knowledge_id)
  const wrongQids = wrongs.data.map(w => w.question_id)
  const strongTag = strong.data.length ? strong.data[0].knowledge_id : null

  // 取题（简化：按知识点/ id 命中）
  const pool = await db.collection('questions').where(_.or([
    { knowledge_tags: _.elemMatch(_.in(blindTags)) },
    { _id: _.in(wrongQids) },
    ...(strongTag ? [{ knowledge_tags: strongTag }] : [])
  ])).limit(20).get()

  let ids = pool.data.map(q => q._id).slice(0, 10)
  const task = {
    student_id: studentId,
    task_date: today,
    question_ids: ids,
    composition: { blind: blindTags.length, wrong: wrongQids.length, cons: strongTag ? 1 : 0 },
    status: 'pending',
    created_at: new Date()
  }
  const added = await db.collection('daily_tasks').add({ data: task })
  return { code: 0, task: Object.assign({ _id: added._id }, task) }
}
