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
const settings = require('./settings.js')
const qt = require('./questionTypes.js')

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
// 把云端题目归一化为本地缓存结构（全题型：透传 q_type/答案/评分要点/分值）
function normCloudQuestion(cq) {
  const type = qt.normalizeType(cq.q_type)
  const m = qt.meta(type)
  // answer：云端已按题型返回正确结构（数字/数组/文本），仅兼容 jsonb 字符串
  let answer = qt.asValue(cq.answer)
  if (answer == null) answer = m.answerKind === 'textArray' ? [] : ''
  return {
    id: cq.id, q_type: type, stem: cq.stem || '',
    stem_images: toArr(cq.stem_images),
    options: toArr(cq.options),
    answer: answer,
    scoring_points: qt.asValue(cq.scoring_points) || [],
    score: Number(cq.score) || (m.family === 'subjective' ? 10 : 2),
    analysis: cq.analysis || '',
    tags: toArr(cq.tags || cq.knowledge_tags),
    knowledge_points: toArr(cq.knowledge_points),
    subject: cq.subject || '', confidence: Number(cq.confidence) || 1,
    year: Number(cq.year) || 0, grade: cq.grade || '', region: cq.region || '',
    original: cq.original || '', confirmed: true
  }
}
function cacheQuestions(questions) {
  const s = store.getState()
  ;(questions || []).forEach(cq => {
    const q = normCloudQuestion(cq)
    const i = s.questions.findIndex(x => x.id === q.id)
    if (i >= 0) s.questions[i] = Object.assign({}, s.questions[i], q)
    else s.questions.push(q)
  })
  store.saveState(s)
}

// 首页「已打卡 ✓」标记：只认云端任务的日期与状态。
// 旧逻辑按本地任务日期记账，本地组卷用手机日期（与云端北京时间差一天）会串账，
// 出现没打卡的科目冒假✓。marks 存 zx_done_map: { 云端日期: [科目] }，
// zx_cloud_today 存最近一次云端任务的日期，首页只读这一天的标记。
function noteCloudTask(task) {
  if (!task) return
  const date = task.task_date || task.date
  if (!date) return
  try {
    const prev = wx.getStorageSync('zx_cloud_today') || ''
    if (date > prev) wx.setStorageSync('zx_cloud_today', date)
    if (task.status === 'done' && task.subject) {
      const map = wx.getStorageSync('zx_done_map') || {}
      const arr = map[date] || []
      if (arr.indexOf(task.subject) < 0) {
        arr.push(task.subject)
        map[date] = arr
        wx.setStorageSync('zx_done_map', map)
      }
    }
  } catch (e) {}
}

/* ============ 首页看板缓存（今日各科任务摘要） ============
 * 首页渲染只需要摘要（题数/已答/错题数/状态），不必每次进首页都等全量组卷。
 * 摘要来自 composeTask 的 board 动作（一次只查任务表的小查询），
 * 并在每次组卷/任务回写时本地同步，保持与云端一致。 */
const BOARD_KEY = 'zx_board_v1'
function getBoard() {
  try {
    const b = wx.getStorageSync(BOARD_KEY)
    if (!b || !b.date || !b.subjects) return null
    const cloudToday = wx.getStorageSync('zx_cloud_today') || ''
    if (cloudToday && b.date < cloudToday) return null // 云端已跨日，旧看板作废
    return b
  } catch (e) { return null }
}
function saveBoard(date, tasks) {
  if (!date) return
  const subjects = {}
  ;(tasks || []).forEach(function (t) {
    if (!t || !t.subject) return
    subjects[t.subject] = {
      count: Number(t.total != null ? t.total : t.total_count) || 0,
      done: Number(t.done != null ? t.done : t.done_count) || 0,
      wrong: Number(t.wrong) || 0,
      status: t.status || 'pending'
    }
    noteCloudTask({ task_date: date, subject: t.subject, status: t.status })
  })
  try { wx.setStorageSync(BOARD_KEY, { date: date, subjects: subjects }) } catch (e) {}
}
function boardApplyTask(task) {
  if (!task) return
  const date = task.task_date || task.date
  if (!date) return
  const b = getBoard()
  const subjects = (b && b.date === date) ? b.subjects : {}
  const comp = toObj(task.composition)
  const ids = toArr(task.question_ids)
  subjects[task.subject || '综合'] = {
    count: Number(task.total_count) || ids.length,
    done: Number(task.done_count) || 0,
    wrong: Number(comp.wrong) || 0,
    status: task.status || 'pending'
  }
  try { wx.setStorageSync(BOARD_KEY, { date: date, subjects: subjects }) } catch (e) {}
}
// 拉今日看板：一次小查询拿全部科目的任务摘要（不组卷、不传题目全文）
async function todayBoard() {
  const r = await cloud.call('composeTask', { action: 'board' })
  if (!r || r.code !== 0) throw new Error((r && r.message) || '看板加载失败')
  saveBoard(r.date, r.tasks || [])
  return getBoard()
}

function cacheTask(task, questions) {
  noteCloudTask(task)
  boardApplyTask(task)
  const s = store.getState()
  const ids = toArr(task.question_ids)
  const old = s.dailyTask
  const subject = task.subject || '综合'
  // 同一天且同一科目才复用本地进度（每科独立任务，避免进度串科）
  const same = old && (old.date === (task.task_date || task.date)) && (old.subject || '综合') === subject
  s.dailyTask = {
    cloudId: task.id,
    date: task.task_date || task.date,
    subject: subject,
    questionIds: ids,
    composition: toObj(task.composition),
    status: task.status || 'pending',
    idx: same ? old.idx : 0,
    results: same ? (old.results || []) : [],
    sessionGranted: same ? (old.sessionGranted || 0) : 0,
    sessionConquered: same ? (old.sessionConquered || 0) : 0,
    conqueredIds: same ? (old.conqueredIds || []) : [],
    isMakeup: task.is_makeup === true,
    makeupDate: task.makeup_date || ''
  }
  // 云端题目同步进缓存，避免本地题库缺题导致渲染失败（全题型）
  if (questions && questions.length) {
    ;(questions || []).forEach(cq => {
      const q = normCloudQuestion(cq)
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
      errorType: r.error_type || (toArr(r.knowledge_tags).length > 1 ? 'concept' : 'knowledge'),
      errorTypeSource: r.error_type_source || 'auto',
      stability: Number(r.stability) || 0,
      difficulty: Number(r.difficulty) || 5,
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
async function composeTask(subject, makeupDate) {
  await auth.ensureStudentId() // 触发首次登录建档；身份由云端注入，无需下传
  const payload = { subject: subject || '综合' }
  if (makeupDate) payload.makeupDate = makeupDate
  const r = await cloud.call('composeTask', payload)
  if (!r || r.code !== 0) {
    const err = new Error((r && r.message) || '云端组卷失败')
    err.code = r && r.code
    err.emptySubject = r && r.emptySubject
    throw err
  }
  const questions = r.questions || []
  cacheQuestions(questions)
  const task = cacheTask(r.task || {}, questions)
  // 刷新错题本缓存：首页三维度按「任务题目 × 错题本 active」实时交叉，需最新错题本
  if (Array.isArray(r.wrongbook)) cacheSnapshots(null, r.wrongbook)
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

// 提交单题作答：云端权威批改（客观题自动 / 主观题 AI，失败可自评），回写快照与反馈
// answer: 单选=下标数字, 多选=下标数组, 填空=文本数组, 主观题=文本
// selfGrade: 主观题 AI 不可用时的自评结果（true=答对）
async function submitAnswer(qid, answer, selfGrade) {
  const s = store.getState()
  const t = s.dailyTask
  const q = s.questions.find(x => x.id === qid)
  if (!q) throw new Error('题目不在缓存中，无法提交')
  await auth.ensureStudentId() // 触发首次登录建档；身份由云端注入，无需下传
  const payload = {
    questionId: qid, answer, knowledgeTags: q.tags || [],
    subject: q.subject || '数学', taskId: t && t.cloudId
  }
  if (typeof selfGrade === 'boolean') payload.selfGrade = selfGrade
  const r = await cloud.call('submitAnswer', payload)
  if (!r || r.code !== 0) throw new Error((r && r.message) || '云端批改失败')

  // 主观题 AI 不可用 → 需要学生自评：直接返回，不写掌握度/进度
  if (r.needSelfGrade) {
    return { needSelfGrade: true, reference: r.reference, scoring_points: r.scoring_points, maxScore: r.maxScore, q, fromCloud: true }
  }

  const correct = !!r.correct
  cacheSnapshots(r.mastery, r.wrongbook)
  if (r.gamification) {
    try { store.applyCloudGamification(store.getState(), r.gamification) } catch (e) {}
  }

  const deltas = (r.deltas || []).map(d => ({ tag: d.tag, d: d.d }))
  const s2 = store.getState()
  if (s2.dailyTask) {
    // 本场云端实际发放累计（首页/结果页展示口径 = 能量账本，避免本地公式估算）
    s2.dailyTask.sessionGranted = (s2.dailyTask.sessionGranted || 0) + (Number(r.granted) || 0)
    if (r.conqueredNow) s2.dailyTask.sessionConquered = (s2.dailyTask.sessionConquered || 0) + 1
    s2.dailyTask.results = s2.dailyTask.results || []
    const rec = { qid, answer, sel: Array.isArray(answer) ? answer : answer, correct, deltas,
      gradedBy: r.gradedBy, score: r.score, maxScore: r.maxScore, aiComment: r.aiComment }
    const exist = s2.dailyTask.results.findIndex(x => x.qid === qid)
    if (exist >= 0) s2.dailyTask.results[exist] = rec
    else s2.dailyTask.results.push(rec)
    if (r.taskProgress && r.taskProgress.finished) {
      s2.dailyTask.status = 'done'
      // 云端确认整科完成 → 按云端任务日期记 ✓（本地任务的 date 即云端 task_date）
      if (s2.dailyTask.cloudId) noteCloudTask({ task_date: s2.dailyTask.date, subject: s2.dailyTask.subject, status: 'done' })
    }
    store.saveState(s2)
  }
  // 补签任务答完：云端已扣卡+记账，这里同步本地补签卡状态并清空 active
  if (r.makeupResult) {
    try { settings.applyMakeupResult(r.makeupResult) } catch (e) {}
  }
  return { correct, q, deltas, granted: Number(r.granted) || 0, conqueredNow: !!r.conqueredNow, gradedBy: r.gradedBy, score: r.score, maxScore: r.maxScore, aiComment: r.aiComment, newBadges: r.newBadges || [], makeupResult: r.makeupResult || null, fromCloud: true }
}

// P0-1 错因自选：把某道错题的错因改为学生自选四分类（云端落库 + 本地缓存同步）
async function setErrorType(qid, errorType) {
  const r = await cloud.call('submitAnswer', { action: 'setErrorType', questionId: qid, errorType })
  if (!r || r.code !== 0) throw new Error((r && r.message) || '错因保存失败')
  const s = store.getState()
  const w = (s.wrongbook || []).find(x => x.questionId === qid)
  if (w) { w.errorType = errorType; w.errorTypeSource = 'self'; store.saveState(s) }
  return r
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
async function recognize(filePath, fileName, subject, asSystem) {
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
    fileName: fileName || '示例试卷.pdf', subject: subject || '数学',
    asSystem: !!asSystem
  })
  if (!r || r.code !== 0) {
    const e = new Error((r && r.message) || '云端识别失败')
    if (r && r.code) e.code = r.code
    throw e
  }
  return r
}

// 把云存储 fileID 换成公网临时 URL（PG 环境云函数 downloadFile 不可用，统一走 URL 下载）
function fileIDToTempUrl(fileID) {
  return new Promise(function (resolve) {
    if (!wx.cloud || !wx.cloud.getTempFileURL || !fileID) { resolve(''); return }
    wx.cloud.getTempFileURL({
      fileList: [fileID],
      success: function (res) {
        const item = res && res.fileList && res.fileList[0]
        resolve((item && item.tempFileURL) || '')
      },
      fail: function () { resolve('') }
    })
  })
}

// Excel 批量导入：前端读 base64 直传云函数解析（PG 环境主链路）→ 校验 + 写待确认题 → 返回同构 questions
// 同时尽力上传云存储拿 fileID 存档（失败不影响导入）；base64 读取失败时回退 fileID/fileUrl 链路。
async function importExcel(filePath, fileName, subject, asSystem) {
  await auth.ensureStudentId()
  if (!filePath) throw new Error('未选择 Excel 文件')
  // 主链路：直接把文件读成 base64（绕开 PG 环境云函数 downloadFile 限制）
  const excelBase64 = await readFileBase64(filePath)
  // 尽力上传云存储存档（仅用于 file_id 留痕；失败不阻断导入）
  const ext = (/\.xlsx$/i.test(fileName || '') ? 'xlsx' : (/\.xls$/i.test(fileName || '') ? 'xls' : 'xlsx'))
  const cloudPath = 'imports/' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext
  const fileID = await new Promise(function (resolve) {
    if (!wx.cloud || !wx.cloud.uploadFile) { resolve(''); return }
    wx.cloud.uploadFile({ cloudPath, filePath, success: function (r) { resolve((r && r.fileID) || '') }, fail: function () { resolve('') } })
  })
  const fileUrl = fileID ? await fileIDToTempUrl(fileID) : ''
  if (!excelBase64 && !fileID && !fileUrl) throw new Error('Excel 读取失败')
  const r = await cloud.call('recognize', {
    action: 'importExcel', excelBase64, fileID, fileUrl,
    fileName: fileName || '题目导入.xlsx', subject: subject || '数学',
    asSystem: !!asSystem
  })
  if (!r || r.code !== 0) {
    const e = new Error((r && r.message) || 'Excel 导入失败')
    if (r && r.code) e.code = r.code
    if (r && r.invalid) e.invalid = r.invalid
    throw e
  }
  return r
}

// 确认入库：把云端 pending 题目置为 confirmed，随后即可被组卷
async function confirmPaper(paperId) {
  await auth.ensureStudentId() // 触发首次登录建档；身份由云端注入，无需下传
  const r = await cloud.call('recognize', {
    action: 'confirm', paperId
  })
  if (!r || r.code !== 0) {
    const e = new Error((r && r.message) || '云端入库失败')
    if (r && r.code) e.code = r.code
    throw e
  }
  return r
}

// 加载已有试卷的全部题目（点击「我的试卷」进入编辑）
async function loadPaper(paperId) {
  await auth.ensureStudentId()
  const r = await cloud.call('recognize', { action: 'loadPaper', paperId })
  if (!r || r.code !== 0) throw new Error((r && r.message) || '加载试卷失败')
  return r
}

// 我的试卷：按「来源 + 学科」合并列举（云端聚合）
// filters: {subject, region, grade, scope:'system'|'user', brushed:'yes'|'no'} 可选；doInit: 是否按当前年级学段首次自动启用
async function listSources(filters, doInit) {
  await auth.ensureStudentId()
  // 优先走 composeTask 的 sources 动作（容器热 + 服务端聚合缓存）；异常时回退 recognize 老接口
  let r = null
  try {
    const payload = { action: 'sources' }
    if (filters) payload.filters = filters
    if (doInit) payload.doInit = true
    r = await cloud.call('composeTask', payload)
    if (!r || r.code !== 0) r = null
  } catch (e) { r = null }
  if (!r) {
    const p2 = { action: 'listSources' }
    if (filters) p2.filters = filters
    if (doInit) p2.doInit = true
    r = await cloud.call('recognize', p2)
  }
  if (!r || r.code !== 0) throw new Error((r && r.message) || '加载试卷列表失败')
  // 原始聚合顺手存一份：试卷页首次打开（或首页预热后）可先用它秒显，再后台刷新
  if (!filters) {
    try {
      wx.setStorageSync('papers_sources_raw_v1', {
        sources: r.sources || [], filterOptions: r.filterOptions || {}, lastSync: Date.now()
      })
    } catch (e) {}
  }
  return r
}

// 勾选启用/停用某个「来源 + 学科」下的全部题目
async function setSourceEnabled(subject, original, enabled, scope) {
  await auth.ensureStudentId()
  const r = await cloud.call('recognize', { action: 'setSourceEnabled', subject, original, enabled, scope })
  if (!r || r.code !== 0) throw new Error((r && r.message) || '设置启用状态失败')
  return r
}

// 加载某个「来源 + 学科」下的全部题目（点击试卷进入查看/编辑）
async function loadSource(subject, original, scope) {
  await auth.ensureStudentId()
  const r = await cloud.call('recognize', { action: 'loadSource', subject, original, scope })
  if (!r || r.code !== 0) throw new Error((r && r.message) || '加载试卷失败')
  return r
}

// 删除单题：普通用户仅限自己上传的题；管理员删系统题时连全部分发副本一并删（云端校验）
async function deleteQuestion(questionId) {
  await auth.ensureStudentId()
  const r = await cloud.call('recognize', { action: 'deleteQuestion', questionId })
  if (!r || r.code !== 0) {
    const e = new Error((r && r.message) || '删除题目失败')
    if (r && r.code) e.code = r.code
    throw e
  }
  return r
}

// 删除整份试卷（按「来源 + 学科 + 范围」分组）：普通用户仅限自己上传的；管理员可删系统试卷（全库）
// targetStudentId 仅管理员删他人用户试卷时传
async function deleteSource(subject, original, scope, targetStudentId) {
  await auth.ensureStudentId()
  const payload = { action: 'deleteSource', subject, original, scope }
  if (targetStudentId) payload.targetStudentId = targetStudentId
  const r = await cloud.call('recognize', payload)
  if (!r || r.code !== 0) {
    const e = new Error((r && r.message) || '删除试卷失败')
    if (r && r.code) e.code = r.code
    throw e
  }
  return r
}

// 管理员：把某位用户的个人试卷转为系统试卷（写公共主库 + 分发全体 + 本人副本转 system）
async function promoteSourceToSystem(subject, original, targetStudentId) {
  await auth.ensureStudentId()
  const r = await cloud.call('recognize', { action: 'promoteSourceToSystem', subject, original, targetStudentId })
  if (!r || r.code !== 0) {
    const e = new Error((r && r.message) || '转为系统试卷失败')
    if (r && r.code) e.code = r.code
    throw e
  }
  return r
}

// 管理员：全库试卷分组（跨用户），供管理端「试卷管理」
async function listAllSources() {
  await auth.ensureStudentId()
  const r = await cloud.call('recognize', { action: 'listAllSources' })
  if (!r || r.code !== 0) throw new Error((r && r.message) || '加载题库列表失败')
  return r
}

// 列出某个试卷分组下的题目摘要（逐题删除用）
async function listGroupQuestions(subject, original, scope, targetStudentId) {
  await auth.ensureStudentId()
  const payload = { action: 'listGroupQuestions', subject, original, scope }
  if (targetStudentId) payload.targetStudentId = targetStudentId
  const r = await cloud.call('recognize', payload)
  if (!r || r.code !== 0) throw new Error((r && r.message) || '加载题目列表失败')
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

/* ============ 题目错误反馈（v1.9.9） ============ */

// 学生提交题目反馈；snapshot 为题目快照（题干/科目/题型/来源/答案/解析等）
async function submitFeedback(questionId, feedbackType, snapshot) {
  await auth.ensureStudentId()
  const r = await cloud.call('feedback', { action: 'submit', questionId, feedbackType, snapshot })
  if (!r || r.code !== 0) throw new Error((r && r.message) || '提交反馈失败')
  return r
}

// 管理员：列出待处理反馈
async function listFeedback(status) {
  const r = await cloud.call('feedback', { action: 'list', status: status || 'pending' })
  if (!r || r.code !== 0) throw new Error((r && r.message) || '加载反馈清单失败')
  return r
}

// 管理员：处理反馈 handleAction=fix|delete|ignore
async function handleFeedback(id, handleAction, patch, note) {
  const r = await cloud.call('feedback', { action: 'handle', id, handleAction, patch: patch || null, note: note || '' })
  if (!r || r.code !== 0) throw new Error((r && r.message) || '处理反馈失败')
  return r
}

module.exports = {
  STUDENT_ID, getStudentId,
  composeTask, todayBoard, getBoard, submitAnswer, setErrorType, recognize, importExcel, confirmPaper, updateQuestion, loadPaper,
  listSources, setSourceEnabled, loadSource,
  deleteQuestion, deleteSource, listAllSources, listGroupQuestions, promoteSourceToSystem,
  submitFeedback, listFeedback, handleFeedback,
  getPreferredSubject, setPreferredSubject,
  cacheQuestions, cacheTask, cacheSnapshots
}
