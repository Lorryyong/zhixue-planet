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
const auth = require('./auth.js')

// 真实身份：登录成功后为 openid，未配 AppSecret 时为匿名设备 ID，均从缓存读取。
// 兼容旧引用：getStudentId() 返回当前缓存 ID（可能为空，云端调用请走 ensureStudentId）。
function getStudentId() {
  try { return wx.getStorageSync(auth.STORAGE_KEY) || '' } catch (e) { return '' }
}
const STUDENT_ID = getStudentId()

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
    subject: task.subject || '综合',
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
// subject: '综合'(默认，全部科目) 或具体科目；同一天只允许一个任务，科目在开始答题前可换
async function composeTask(subject) {
  await auth.ensureStudentId() // 触发首次登录建档；身份由云端注入，无需下传
  const r = await cloud.call('composeTask', { subject: subject || '综合' })
  if (!r || r.code !== 0) {
    const err = new Error((r && r.message) || '云端组卷失败')
    err.code = r && r.code
    err.emptySubject = r && r.emptySubject
    throw err
  }
  const questions = r.questions || []
  cacheQuestions(questions)
  const task = cacheTask(r.task || {}, questions)
  return { task, questions, fromCloud: true, note: r.note }
}

// 科目偏好：本地持久化，首页选择后供组卷使用
const SUBJECT_KEY = 'zx_quiz_subject'
function getPreferredSubject() {
  try { return wx.getStorageSync(SUBJECT_KEY) || '综合' } catch (e) { return '综合' }
}
function setPreferredSubject(s) {
  try { wx.setStorageSync(SUBJECT_KEY, s || '综合') } catch (e) {}
}

// 提交单题作答：云端批改/更新掌握度/维护错题，回写快照与反馈
async function submitAnswer(qid, sel) {
  const s = store.getState()
  const t = s.dailyTask
  const q = s.questions.find(x => x.id === qid)
  if (!q) throw new Error('题目不在缓存中，无法提交')
  const correct = sel === q.answer
  await auth.ensureStudentId() // 触发首次登录建档；身份由云端注入，无需下传
  const r = await cloud.call('submitAnswer', {
    questionId: qid,
    answer: sel, correct, knowledgeTags: q.tags || [],
    subject: q.subject || '数学', taskId: t && t.cloudId
  })
  if (!r || r.code !== 0) throw new Error('云端批改失败')
  cacheSnapshots(r.mastery, r.wrongbook)
  // 养成数据以云端为准，覆盖本地
  if (r.gamification) {
    try { store.applyCloudGamification(store.getState(), r.gamification) } catch (e) {}
  }

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

// 读取本地文件为 base64（AI 视觉识别用；小程序跨环境无法共享 wx.cloud 文件，改走 base64）
function readFileBase64(filePath) {
  return new Promise(resolve => {
    if (!filePath || !wx.getFileSystemManager) { resolve(''); return }
    wx.getFileSystemManager().readFile({
      filePath, encoding: 'base64',
      success: res => resolve(res.data || ''),
      fail: () => resolve('')
    })
  })
}

// PDF 上传微信云存储换公网临时 URL（GLM 文件输入只接受公网 URL，不接受 base64 data URL）
function uploadPdfTempUrl(filePath) {
  return new Promise(resolve => {
    if (!wx.cloud || !wx.cloud.uploadFile || !wx.cloud.getTempFileURL) { resolve(''); return }
    const cloudPath = 'papers/' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.pdf'
    wx.cloud.uploadFile({
      cloudPath, filePath,
      success: up => {
        if (!up || !up.fileID) { resolve(''); return }
        wx.cloud.getTempFileURL({
          fileList: [up.fileID],
          success: res => {
            const item = res && res.fileList && res.fileList[0]
            resolve((item && item.tempFileURL) || '')
          },
          fail: () => resolve('')
        })
      },
      fail: () => resolve('')
    })
  })
}

// 识别试卷：图片走 base64（视觉模型支持）；PDF 走云存储公网临时 URL（GLM 文件输入要求）；无文件走样题
async function recognize(filePath, fileName, subject) {
  await auth.ensureStudentId() // 触发首次登录建档；身份由云端注入，无需下传
  let imageBase64 = '', fileUrl = '', mimeType = ''
  if (filePath) {
    const lower = (fileName || '').toLowerCase()
    if (/\.pdf$/.test(lower)) {
      fileUrl = await uploadPdfTempUrl(filePath)
      if (fileUrl) mimeType = 'application/pdf'
    } else {
      const b64 = await readFileBase64(filePath)
      if (b64) {
        imageBase64 = 'data:' + (/\.png$/.test(lower) ? 'image/png' : 'image/jpeg') + ';base64,' + b64
        mimeType = /\.png$/.test(lower) ? 'image/png' : 'image/jpeg'
      }
    }
  }
  const r = await cloud.call('recognize', {
    imageBase64, fileUrl, mimeType,
    fileName: fileName || '示例试卷.pdf', subject: subject || '数学'
  })
  if (!r || r.code !== 0) throw new Error('云端识别失败')
  return r
}

// 确认入库：把云端 pending 题目置为 confirmed，随后即可被组卷
async function confirmPaper(paperId) {
  await auth.ensureStudentId() // 触发首次登录建档；身份由云端注入，无需下传
  const r = await cloud.call('recognize', {
    action: 'confirm', paperId
  })
  if (!r || r.code !== 0) throw new Error('云端入库失败')
  return r
}

// 人工校对修改：把编辑后的题目字段写回云端 PG（本地缓存由调用页同步）
async function updateQuestion(questionId, patch) {
  await auth.ensureStudentId()
  const r = await cloud.call('recognize', {
    action: 'updateQuestion', questionId, patch
  })
  if (!r || r.code !== 0) throw new Error((r && r.message) || '云端修改失败')
  return r
}

module.exports = {
  STUDENT_ID, getStudentId,
  composeTask, submitAnswer, recognize, confirmPaper, updateQuestion,
  getPreferredSubject, setPreferredSubject,
  cacheQuestions, cacheTask, cacheSnapshots
}
