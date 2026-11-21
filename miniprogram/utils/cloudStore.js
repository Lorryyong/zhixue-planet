/**
 * 云端数据层 · 答题闭环（recognize / composeTask / submitAnswer）
 *
 * 设计原则：
 * - 云端是权威数据源；本地 Storage 退化为「缓存 + 降级兜底」。
 * - 每个方法成功后把云端结果同步进本地缓存，供首页/错题本/雷达/星球页读取。
 * - 云端不可用（未部署 / 权限未通 / 网络问题）时直接 throw，
 *   由调用页面 catch 后降级到原 store 的本地逻辑，保证 Demo 始终可跑。
 */
const cloud = require('./cloud.js')
const store = require('./store.js')

// 与「我的 → 云函数联调」保持一致；生产应替换为 openid 登录后的真实 studentId
const STUDENT_ID = 'demo_student'

function toArr(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') { try { return JSON.parse(v) } catch (e) { return [] } }
  return []
}
function toObj(v) {
  if (v && typeof v === 'object') return v
  if (typeof v === 'string') { try { return JSON.parse(v) } catch (e) { return {} } }
  return {}
}

/* ============ 缓存同步 ============ */
function cacheQuestions(questions) {
  const s = store.getState()
  ;(questions || []).forEach(cq => {
    const q = {
      id: cq.id, stem: cq.stem || '', options: toArr(cq.options),
      answer: Number(cq.answer) || 0, analysis: cq.analysis || '',
      tags: toArr(cq.tags || cq.knowledge_tags),
      subject: cq.subject || '', confidence: Number(cq.confidence) || 1,
      confirmed: true
    }
    const i = s.questions.findIndex(x => x.id === q.id)
    if (i >= 0) s.questions[i] = Object.assign({}, s.questions[i], q)
    else s.questions.push(q)
  })
  store.saveState(s)
}

function cacheTask(task, questions) {
  const s = store.getState()
  const ids = toArr(task.question_ids)
  const old = s.dailyTask
  const same = old && (old.date === (task.task_date || task.date))
  s.dailyTask = {
    cloudId: task.id,
    date: task.task_date || task.date,
    questionIds: ids,
    composition: toObj(task.composition),
    status: task.status || 'pending',
    idx: same ? old.idx : 0,
    results: same ? (old.results || []) : []
  }
  // 云端题目同步进缓存，避免本地题库缺题导致渲染失败
  if (questions && questions.length) {
    ;(questions || []).forEach(cq => {
      const q = {
        id: cq.id, stem: cq.stem || '', options: toArr(cq.options),
        answer: Number(cq.answer) || 0, analysis: cq.analysis || '',
        tags: toArr(cq.tags || cq.knowledge_tags), subject: cq.subject || '',
        confirmed: true
      }
      const i = s.questions.findIndex(x => x.id === q.id)
      if (i >= 0) s.questions[i] = Object.assign({}, s.questions[i], q)
      else s.questions.push(q)
    })
  }
  store.saveState(s)
  return s.dailyTask
}

function cacheSnapshots(masteryRows, wrongRows) {
  const s = store.getState()
  if (Array.isArray(masteryRows)) {
    const m = {}
    masteryRows.forEach(r => {
      m[r.knowledge_id] = {
        score: Number(r.score) || 0,
        total: Number(r.total_answered) || 0,
        correct: Number(r.total_correct) || 0,
        trend: r.trend || 'stable'
      }
    })
    if (Object.keys(m).length) s.mastery = m
  }
  if (Array.isArray(wrongRows)) {
    s.wrongbook = wrongRows.map(r => ({
      questionId: r.question_id,
      errorType: toArr(r.knowledge_tags).length > 1 ? 'concept' : 'knowledge',
      wrongCount: Number(r.wrong_count) || 0,
      continuousCorrect: Number(r.continuous_correct) || 0,
      reviewStage: Number(r.review_stage) || 0,
      nextReviewAt: r.next_review_at,
      status: r.status || 'active',
      firstWrongAt: r.first_wrong_at
    }))
  }
  store.saveState(s)
}

/* ============ 云端闭环方法 ============ */

// 组卷：云端返回任务 + 题目详情，全部同步进缓存
async function composeTask() {
  const r = await cloud.call('composeTask', { studentId: STUDENT_ID })
  if (!r || r.code !== 0) throw new Error('云端组卷失败')
  const questions = r.questions || []
  cacheQuestions(questions)
  const task = cacheTask(r.task || {}, questions)
  return { task, questions, fromCloud: true }
}

// 提交单题作答：云端批改/更新掌握度/维护错题，回写快照与反馈
async function submitAnswer(qid, sel) {
  const s = store.getState()
  const t = s.dailyTask
  const q = s.questions.find(x => x.id === qid)
  if (!q) throw new Error('题目不在缓存中，无法提交')
  const correct = sel === q.answer
  const r = await cloud.call('submitAnswer', {
    studentId: STUDENT_ID, questionId: qid,
    answer: sel, correct, knowledgeTags: q.tags || [],
    subject: q.subject || '数学', taskId: t && t.cloudId
  })
  if (!r || r.code !== 0) throw new Error('云端批改失败')
  cacheSnapshots(r.mastery, r.wrongbook)

  const deltas = (r.deltas || []).map(d => ({ tag: d.tag, d: d.d }))
  const s2 = store.getState()
  if (s2.dailyTask) {
    s2.dailyTask.results = s2.dailyTask.results || []
    const rec = { qid, sel, correct, deltas }
    const exist = s2.dailyTask.results.findIndex(x => x.qid === qid)
    if (exist >= 0) s2.dailyTask.results[exist] = rec
    else s2.dailyTask.results.push(rec)
    if (r.taskProgress && r.taskProgress.finished) s2.dailyTask.status = 'done'
    store.saveState(s2)
  }
  return { correct, q, deltas, fromCloud: true }
}

// 识别试卷：先尽力把本地文件上传到云存储拿 fileID，再调 recognize 云函数
async function recognize(filePath, fileName, subject) {
  let fileID = ''
  // 上传只依赖 wx.cloud（且仅用于拿 fileID）；HTTP 主链路不依赖它，失败即降级
  const uploadReady = !!(wx.cloud && getApp() && getApp().globalData && getApp().globalData.cloudUploadReady)
  if (filePath && uploadReady) {
    try {
      const ext = (fileName || '').split('.').pop() || 'pdf'
      const up = await wx.cloud.uploadFile({
        cloudPath: 'papers/' + Date.now() + '.' + ext,
        filePath
      })
      fileID = up.fileID || ''
    } catch (e) { fileID = '' }
  }
  const r = await cloud.call('recognize', {
    studentId: STUDENT_ID, fileID,
    fileName: fileName || '示例试卷.pdf', subject: subject || '数学'
  })
  if (!r || r.code !== 0) throw new Error('云端识别失败')
  return r
}

// 确认入库：把云端 pending 题目置为 confirmed，随后即可被组卷
async function confirmPaper(paperId) {
  const r = await cloud.call('recognize', {
    action: 'confirm', studentId: STUDENT_ID, paperId
  })
  if (!r || r.code !== 0) throw new Error('云端入库失败')
  return r
}

module.exports = {
  STUDENT_ID,
  composeTask, submitAnswer, recognize, confirmPaper,
  cacheQuestions, cacheTask, cacheSnapshots
}
