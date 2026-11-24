/**
 * 智学星球 · 核心数据层与算法层
 * 说明：Demo 阶段使用本地 Storage 持久化，算法与 Web Demo 一致。
 * 迁移到云开发时，只需把 load/save 替换为云数据库读写，算法函数可直接复用。
 */

const STORE_KEY = 'zhixue_demo_v1'
const qt = require('./questionTypes.js')
const badges = require('./badges.js')

const KNOWLEDGE = [
  { id: 'k1', name: '全等三角形', sub: 'SAS判定' },
  { id: 'k2', name: '一元二次方程', sub: '韦达定理' },
  { id: 'k3', name: '勾股定理', sub: '逆定理' },
  { id: 'k4', name: '二次函数', sub: '图像平移' },
  { id: 'k5', name: '一次函数', sub: '斜率' },
  { id: 'k6', name: '圆', sub: '切线性质' },
  { id: 'k7', name: '相似三角形', sub: '判定' },
  { id: 'k8', name: '实数运算', sub: '二次根式' }
]

function kName(id) {
  const k = KNOWLEDGE.find(x => x.id === id)
  return k ? k.name + '-' + k.sub : id
}

const SEED_QUESTIONS = [
  { id: 'q1', stem: '下列条件中，能判定△ABC≌△DEF 的是（　）', options: ['AB=DE，BC=EF，∠A=∠D', 'AB=DE，∠A=∠D，AC=DF', '∠A=∠D，∠B=∠E，BC=EF', 'AB=DE，BC=EF，∠C=∠F'], answer: 1, analysis: '两边及其夹角（SAS）可判定全等，选 B。A 为“边边角”不能判定。', tags: ['k1'], confirmed: true },
  { id: 'q2', stem: '已知 x² − 5x + 6 = 0，则两根之和为______。', options: ['5', '-5', '6', '-6'], answer: 0, analysis: '由韦达定理，两根之和 = −b/a = 5。', tags: ['k2'], confirmed: true },
  { id: 'q3', stem: '直角三角形两直角边为 3、4，则斜边长为（　）', options: ['5', '6', '7', '25'], answer: 0, analysis: '勾股定理：√(3²+4²)=5。', tags: ['k3'], confirmed: true },
  { id: 'q4', stem: '将抛物线 y=x² 向右平移 2 个单位，解析式为（　）', options: ['y=(x+2)²', 'y=(x−2)²', 'y=x²+2', 'y=x²−2'], answer: 1, analysis: '左加右减，向右平移 2 得 y=(x−2)²。', tags: ['k4'], confirmed: true },
  { id: 'q5', stem: '直线 y=2x+1 的斜率为（　）', options: ['1', '2', '-2', '0'], answer: 1, analysis: '一次函数 y=kx+b 中 k 为斜率，故 k=2。', tags: ['k5'], confirmed: true },
  { id: 'q6', stem: '圆 O 的半径为 5，点 P 在圆上，则 OP =（　）', options: ['5', '10', '25', '2.5'], answer: 0, analysis: '圆上任意点到圆心距离等于半径。', tags: ['k6'], confirmed: true },
  { id: 'q7', stem: '若 √x 有意义，则 x 的取值范围是（　）', options: ['x>0', 'x≥0', 'x<0', '任意实数'], answer: 1, analysis: '二次根式被开方数须非负，x≥0。', tags: ['k8'], confirmed: true },
  { id: 'q8', stem: '两个三角形对应角相等，则它们（　）', options: ['全等', '相似', '面积相等', '形状不同'], answer: 1, analysis: '三角对应相等可判定相似，不一定全等。', tags: ['k7'], confirmed: true },
  { id: 'q9', stem: '方程 x²=9 的解为（　）', options: ['x=3', 'x=-3', 'x=±3', '无解'], answer: 2, analysis: 'x²=9 的解为 x=±3。', tags: ['k2'], confirmed: true },
  { id: 'q10', stem: '等腰三角形顶角 80°，底角为（　）', options: ['50°', '80°', '100°', '40°'], answer: 0, analysis: '(180−80)/2 = 50°。', tags: ['k1'], confirmed: true },
  { id: 'q11', stem: '点 A(1,2) 与 B(4,6) 的距离为（　）', options: ['3', '4', '5', '√7'], answer: 2, analysis: '距离 = √((4−1)²+(6−2)²)=5。', tags: ['k3'], confirmed: true },
  { id: 'q12', stem: '抛物线 y=−x² 的开口方向（　）', options: ['向上', '向下', '向左', '向右'], answer: 1, analysis: '二次项系数为负，开口向下。', tags: ['k4'], confirmed: true }
]

const NEW_PAPER_QUESTIONS = [
  { id: 'n1', stem: '若 a−b=3，ab=2，则 a²+b² 的值为（　）', options: ['5', '9', '13', '11'], answer: 2, analysis: 'a²+b²=(a−b)²+2ab=9+4=13。', tags: ['k2'], confidence: 0.96 },
  { id: 'n2', stem: '已知 AB=AC，∠A=60°，则△ABC 是（　）', options: ['直角三角形', '等边三角形', '等腰直角三角形', '钝角三角形'], answer: 1, analysis: '有一个角60°的等腰三角形是等边三角形。', tags: ['k1', 'k7'], confidence: 0.91 },
  { id: 'n3', stem: '函数 y=−3x+4 的图象经过（　）', options: ['一、二、四象限', '一、三象限', '二、四象限', '一、二、三象限'], answer: 0, analysis: 'k<0,b>0，经过一、二、四象限。', tags: ['k5'], confidence: 0.88 },
  { id: 'n4', stem: '切线与过切点的半径的位置关系是（　）', options: ['平行', '垂直', '相交', '重合'], answer: 1, analysis: '圆的切线垂直于过切点的半径。', tags: ['k6'], confidence: 0.93 }
]

/* ============ 时间工具 ============ */
function offsetNow() { const s = getState(); return new Date(Date.now() + (s.dayOffset || 0) * 86400000) }
function dateStr(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }
function isoAdd(dateStrBase, days) { const d = new Date(dateStrBase + 'T00:00:00'); d.setDate(d.getDate() + days); return d.toISOString() }
function isDue(w) { return new Date(w.nextReviewAt) <= offsetNow() }
function fmtDue(w) {
  const diff = Math.ceil((new Date(w.nextReviewAt) - offsetNow()) / 86400000)
  if (diff <= 0) return '今日重刷'
  if (diff === 1) return '明日重刷'
  return diff + '天后重刷'
}
function uniq(arr) { return [...new Set(arr)] }

/* ============ 状态读写 ============ */
function seedState() {
  const scores = [58, 72, 86, 45, 63, 90, 70, 88]
  const mastery = {}
  KNOWLEDGE.forEach((k, i) => {
    mastery[k.id] = { score: scores[i], total: 10 + i, correct: Math.round((10 + i) * scores[i] / 100), trend: 'stable' }
  })
  const today = dateStr(new Date())
  return {
    dayOffset: 0,
    questions: JSON.parse(JSON.stringify(SEED_QUESTIONS)),
    papers: [{ id: 'p1', title: '九年级数学·月考卷（二）', subject: '数学', grade: '九年级', count: 12, status: 'confirmed' }],
    mastery,
    wrongbook: [
      { questionId: 'q1', errorType: 'knowledge', wrongCount: 3, continuousCorrect: 0, reviewStage: 0, nextReviewAt: isoAdd(today, 0), status: 'active', firstWrongAt: today },
      { questionId: 'q4', errorType: 'concept', wrongCount: 2, continuousCorrect: 1, reviewStage: 1, nextReviewAt: isoAdd(today, 2), status: 'active', firstWrongAt: today }
    ],
    gamification: { energy: 0, level: 1, streak: 0, checkinDates: [], badges: ['b1', 'b2', 'b3'], energyLedger: [] },
    dailyTask: null,
    pendingQuestions: [],
    pendingPaperId: null,
    lastQuiz: null
  }
}

const ENERGY_RESET_FLAG = 'zx_energy_reset_v193'

function getState() {
  let s
  try { s = wx.getStorageSync(STORE_KEY) } catch (e) { s = null }
  if (!s) { s = seedState(); saveState(s) }
  // 一次性迁移：能量从今天答题起算，清零历史能量/等级/连续天数/账本/签到
  try {
    if (!wx.getStorageSync(ENERGY_RESET_FLAG)) {
      const g = s.gamification || {}
      s.gamification = {
        energy: 0, level: 1, streak: 0,
        checkinDates: [], badges: g.badges || [], energyLedger: []
      }
      saveState(s)
      wx.setStorageSync(ENERGY_RESET_FLAG, true)
    }
  } catch (e) { /* 迁移失败不影响主流程 */ }
  return s
}
function saveState(s) { try { wx.setStorageSync(STORE_KEY, s || getState()) } catch (e) {} }
function resetState() { const s = seedState(); saveState(s); return s }

/* ============ 核心算法 ============ */
function updateMastery(s, knowledgeId, correct) {
  const m = s.mastery[knowledgeId]; if (!m) return 0
  const before = m.score
  if (correct) m.score += 12 * (1 - m.score / 100)
  else m.score -= 15 * (1 + (m.wrongBoost || 0) * 0.1)
  m.score = Math.max(0, Math.min(100, Math.round(m.score)))
  m.total++; if (correct) m.correct++; else m.wrongBoost = (m.wrongBoost || 0) + 1
  m.trend = m.score > before ? 'rising' : (m.score < before ? 'falling' : 'stable')
  return Math.round(m.score - before)
}

// 科目宽松匹配（本地降级用）：无 subject 的历史题视为数学；综合=全部
function _matchSubject(q, want) {
  if (!want || want === '综合') return true
  const s = String((q && q.subject) || '数学').trim().toLowerCase()
  const w = String(want).trim().toLowerCase()
  const ALIAS = {
    '英语': ['英语', 'english'], '数学': ['数学', 'math'], '语文': ['语文', 'chinese'],
    '物理': ['物理', 'physics'], '化学': ['化学', 'chemistry'], '生物': ['生物', 'biology'],
    '历史': ['历史', 'history'], '地理': ['地理', 'geography']
  }
  if (s === w || s.indexOf(w) >= 0 || w.indexOf(s) >= 0) return true
  return (ALIAS[want] || []).some(a => s.indexOf(a) >= 0)
}

function composeTask(s, subject) {
  const today = dateStr(offsetNow())
  const want = subject && subject !== '综合' ? subject : ''
  const subj = want || '综合'
  // 当天任务必须科目一致才复用，避免切科后沿用上一科任务
  if (s.dailyTask && s.dailyTask.date === today && (s.dailyTask.subject || '综合') === subj) return s.dailyTask
  // 题池先按科目过滤：后续错题只在本科目题池内查找，杜绝跨科错题（如历史混入物理）混入
  const bank = s.questions.filter(q => q.confirmed && _matchSubject(q, want))
  const blind = Object.entries(s.mastery).filter(([id, m]) => m.score < 60).sort((a, b) => a[1].score - b[1].score)
  const blindQs = []
  blind.forEach(([id]) => { const q = bank.find(q => q.tags.indexOf(id) >= 0); if (q) blindQs.push(q) })
  const dueWrong = s.wrongbook.filter(w => w.status === 'active' && isDue(w))
  const wrongQs = dueWrong.map(w => bank.find(q => q.id === w.questionId)).filter(Boolean)
  const cons = bank.find(q => q.tags.some(t => s.mastery[t] && s.mastery[t].score >= 85))
  let ids = uniq([...blindQs.map(q => q.id), ...wrongQs.map(q => q.id), ...(cons ? [cons.id] : [])])
  bank.forEach(q => { if (ids.length < 10 && ids.indexOf(q.id) < 0) ids.push(q.id) })
  ids = ids.slice(0, 10)
  s.dailyTask = { date: today, subject: subj, questionIds: ids, composition: { wrong: wrongQs.length, bank: ids.length - wrongQs.length, goal: 10, actual: ids.length, subject: subj }, status: 'pending', idx: 0, results: [] }
  saveState(s)
  return s.dailyTask
}

function submitAnswer(s, qid, sel) {
  const q = s.questions.find(x => x.id === qid)
  const t = s.dailyTask
  // 本地降级：客观题按题型判分；主观题无 AI，按「自评通过」处理（本地 Demo 不阻塞）
  let correct
  const jr = qt.judgeObjective(q, sel)
  if (jr) correct = jr.correct
  else correct = true // 主观题本地模式默认按已作答通过（云端模式走 AI / 自评）
  const deltas = q.tags.map(tag => ({ tag, d: updateMastery(s, tag, correct) }))
  s.gamification.energy += correct ? 2 : 0
  if (!correct) {
    let w = s.wrongbook.find(x => x.questionId === qid)
    if (!w) { w = { questionId: qid, errorType: 'knowledge', wrongCount: 0, continuousCorrect: 0, reviewStage: 0, status: 'active', firstWrongAt: dateStr(offsetNow()) }; s.wrongbook.push(w) }
    w.wrongCount++; w.continuousCorrect = 0; w.reviewStage = 0; w.status = 'active'
    w.nextReviewAt = isoAdd(dateStr(offsetNow()), 1)
  } else {
    const w = s.wrongbook.find(x => x.questionId === qid)
    if (w && w.status === 'active') {
      w.continuousCorrect++; w.reviewStage++
      const gap = [1, 3, 7][Math.min(w.reviewStage - 1, 2)]
      w.nextReviewAt = isoAdd(dateStr(offsetNow()), gap)
      if (w.continuousCorrect >= 2 && w.reviewStage >= 3) w.status = 'conquered'
    }
  }
  t.results.push({ qid, sel, correct, deltas })
  saveState(s)
  return { correct, q, deltas }
}

function finishTask(s) {
  const t = s.dailyTask
  t.status = 'done'; t.finishedAt = new Date().toISOString()
  const g = s.gamification
  g.energy += 20
  // 补签任务按补签日记账，普通任务按当天记账，避免补签日答题却把"今天"标成已打卡
  const markDate = t.isMakeup && t.makeupDate ? t.makeupDate : dateStr(offsetNow())
  if (g.checkinDates.indexOf(markDate) < 0) g.checkinDates.push(markDate)
  const correctCount = t.results.filter(r => r.correct).length
  const conquered = t.results.filter(r => r.correct && r.deltas.some(d => d.d >= 1)).length
  g.energy += conquered * 30
  s.lastQuiz = { total: t.questionIds.length, correct: correctCount, energy: 20 + correctCount * 2 + conquered * 30 }
  // 本地降级也触发徽章判定（与云端规则一致）
  try {
    const allCorrect = Object.values(s.mastery).reduce(function (n, m) { return n + (m.correct || 0) }, 0)
    const ctx = {
      energy: g.energy || 0, streak: g.streak || 0,
      checkinCount: (g.checkinDates || []).length,
      correctTotal: allCorrect,
      conqueredCount: (s.wrongbook || []).filter(w => w.status === 'conquered').length,
      masteredCount: Object.values(s.mastery).filter(m => (m.score || 0) >= 85).length
    }
    g.badges = badges.merge(g.badges || [], badges.evaluate(ctx))
  } catch (e) { /* 徽章判定失败不影响打卡 */ }
  saveState(s)
}

function advanceDay(s) {
  s.dayOffset = (s.dayOffset || 0) + 1
  s.dailyTask = null
  const g = s.gamification
  const prev = dateStr(new Date(Date.now() + (s.dayOffset - 1) * 86400000))
  if (g.checkinDates.indexOf(prev) >= 0) g.streak++
  saveState(s)
  return s
}

function loadSamplePaper(s) {
  const pid = 'p' + (s.papers.length + 1)
  s.papers.push({ id: pid, title: '数学·几何与函数专项卷', subject: '数学', grade: '九年级', count: NEW_PAPER_QUESTIONS.length, status: 'pending' })
  s.pendingPaperId = pid
  s.pendingQuestions = JSON.parse(JSON.stringify(NEW_PAPER_QUESTIONS)).map(q => Object.assign({}, q, { confirmed: false }))
  saveState(s)
  return s
}

// 从云函数 recognize 的返回结果装载待校对试卷（兼容 knowledge_tags → tags）
function loadCloudPaper(s, questions, meta) {
  // 云函数 recognize 会返回云端 paperId（形如 p_xxx），保留它以便「确认入库」回调云端
  const pid = (meta && (meta.paperId || meta.id)) || ('p' + (s.papers.length + 1))
  const title = (meta && meta.title) || 'AI 识别·云试卷'
  const arr = (questions || []).map((q, i) => {
    const type = qt.normalizeType(q.q_type)
    const m = qt.meta(type)
    return {
      id: (q.id || 'c' + Date.now() + '_' + i),
      q_type: type,
      stem: q.stem || '',
      options: q.options || [],
      answer: (q.answer != null ? q.answer : (m.answerKind === 'textArray' ? [] : '')),
      scoring_points: q.scoring_points || [],
      score: Number(q.score) || (m.family === 'subjective' ? 10 : 2),
      analysis: q.analysis || '',
      original: q.original || '',
      needFix: !!q.needFix,
      issues: q.issues || [],
      tags: q.tags || q.knowledge_tags || [],
      knowledge_points: q.knowledge_points || [],
      confidence: typeof q.confidence === 'number' ? q.confidence : 0.9,
      confirmed: false
    }
  })
  s.papers.push({
    id: pid, title,
    subject: (meta && meta.subject) || '数学',
    grade: (meta && meta.grade) || '九年级',
    count: arr.length, status: 'pending'
  })
  s.pendingPaperId = pid
  s.pendingQuestions = arr
  saveState(s)
  return s
}

function confirmQ(s, id) {
  const q = s.pendingQuestions.find(x => x.id === id)
  if (q) { q.confirmed = true; saveState(s) }
  return s
}
function removePendingQuestion(s, id) {
  const i = s.pendingQuestions.findIndex(x => x.id === id)
  if (i >= 0) { s.pendingQuestions.splice(i, 1); saveState(s) }
  return s
}

// 人工校对：更新待校对题目的字段（本地缓存）
function editPendingQ(s, id, patch) {
  const q = s.pendingQuestions.find(x => x.id === id)
  if (q) {
    Object.assign(q, patch)
    if (Array.isArray(patch.tags) && !Array.isArray(patch.knowledge_tags)) q.knowledge_tags = patch.tags
    saveState(s)
  }
  return s
}

function confirmAll(s) {
  const add = s.pendingQuestions.filter(q => !s.questions.some(x => x.id === q.id))
  add.forEach(q => s.questions.push(Object.assign({}, q, { confirmed: true })))
  const p = s.papers.find(x => x.id === s.pendingPaperId)
  if (p) {
    p.status = 'confirmed'
    // 重编辑已入库试卷时，题目已存在于 s.questions，add 为 0；以待校对题目数为准，避免计数被清零
    p.count = s.pendingQuestions.length || add.length
  }
  s.pendingQuestions = []; s.pendingPaperId = null
  saveState(s)
  return add.length
}

// 打开已有试卷进入编辑：把云端加载的题目装入待校对缓存（不重复 push 试卷）
function openPaperForEdit(s, paper, questions) {
  const pid = (paper && paper.id) || ('p_' + Date.now().toString(36))
  const arr = (questions || []).map(q => Object.assign({}, q, {
    confirmed: !!q.confirmed,
    tags: q.tags || q.knowledge_tags || [],
    knowledge_points: q.knowledge_points || [],
    options: q.options || [],
    scoring_points: q.scoring_points || [],
    issues: q.issues || [],
    needFix: !!q.needFix
  }))
  // 试卷若不在本地缓存（如换设备），补一条，避免标题为空
  if (!s.papers.find(p => p.id === pid)) {
    s.papers.push({
      id: pid, title: (paper && paper.title) || '云试卷',
      subject: (paper && paper.subject) || '数学', grade: (paper && paper.grade) || '九年级',
      count: arr.length, status: (paper && paper.status) || 'confirmed'
    })
  }
  s.pendingPaperId = pid
  s.pendingQuestions = arr
  saveState(s)
  return s
}

// 用云端养成快照覆盖本地（云端为权威源，换设备也能恢复）
function applyCloudGamification(s, g) {
  if (!g || typeof g !== 'object') return s
  const cur = s.gamification || {}
  s.gamification = {
    energy: typeof g.energy === 'number' ? g.energy : (cur.energy || 0),
    level: typeof g.level === 'number' ? g.level : (cur.level || 1),
    streak: typeof g.streak === 'number' ? g.streak : (cur.streak || 0),
    checkinDates: Array.isArray(g.checkinDates) ? g.checkinDates : (cur.checkinDates || []),
    badges: Array.isArray(g.badges) ? g.badges : (cur.badges || []),
    energyLedger: Array.isArray(g.energyLedger) ? g.energyLedger : (cur.energyLedger || []),
    weekAccuracy: typeof g.weekAccuracy === 'number' ? g.weekAccuracy : cur.weekAccuracy,
    conqueredCount: typeof g.conqueredCount === 'number' ? g.conqueredCount : cur.conqueredCount,
    totalEarned: typeof g.totalEarned === 'number' ? g.totalEarned : (cur.totalEarned || 0),
    leaderboard: Array.isArray(g.leaderboard) && g.leaderboard.length ? g.leaderboard : (cur.leaderboard || [])
  }
  saveState(s)
  return s
}

// 能量/积分规则说明（供积分说明页展示，与云端 submitAnswer 保持一致）
const ENERGY_RULES = [
  { icon: '✅', title: '答对一道题', delta: '+2', desc: '客观题自动判分 / 主观题经 AI 或自评通过' },
  { icon: '🎯', title: '完成每日打卡', delta: '+20', desc: '当天该科 10 题作答完毕' },
  { icon: '📕', title: '攻克一道错题', delta: '+30', desc: '错题按 1/3/7 天复习连续答对后攻克' }
]

// 晋级路线：与 submitAnswer 的 derived 分级与 planetStage 阈值一致
const PLANET_PATH = [
  { level: 1, min: 0, name: '萌芽星球', emoji: '🌱', desc: '初来乍到，坚持打卡开启学习之旅' },
  { level: 4, min: 500, name: '繁茂星球', emoji: '🌍', desc: '积累 500 能量，星球枝繁叶茂' },
  { level: 7, min: 1500, name: '星河形态', emoji: '🌌', desc: '积累 1500 能量，进化为璀璨星河' }
]

function planetStage(energy) {
  if (energy < 500) return { name: '萌芽星球', emoji: '🌱', next: '距繁茂 ' + Math.max(0, 500 - energy) + '⚡' }
  if (energy < 1500) return { name: '繁茂星球', emoji: '🌍', next: '距星河 ' + Math.max(0, 1500 - energy) + '⚡' }
  return { name: '星河形态', emoji: '🌌', next: '已臻成熟 ✨' }
}

function weekAccuracy(s) {
  // 云端权威口径优先（login 快照按本周作答记录计算）；本地仅作离线兜底（最近一次测验）
  const g = s.gamification || {}
  if (typeof g.weekAccuracy === 'number') return g.weekAccuracy
  if (!s.lastQuiz || !s.lastQuiz.total) return 0
  return Math.round(s.lastQuiz.correct / s.lastQuiz.total * 100)
}

/* ============ 科目农场（本地降级，v1.9.8）============
 * 正常模式走 farm 云函数（服务端权威扣能量）；此处供无云端 Demo 使用，
 * 结构保持与云端 zx_farms 一致，便于切换。农场状态单独 key，避免污染养成存档。
 */
const FARM_KEY = 'zx_farms_v198'
function getFarms() {
  try { return wx.getStorageSync(FARM_KEY) || {} } catch (e) { return {} }
}
function saveFarms(m) { try { wx.setStorageSync(FARM_KEY, m || {}) } catch (e) {} }
/** 取某科农场（不存在则建档） */
function ensureLocalFarm(subject) {
  const m = getFarms()
  if (!m[subject]) {
    m[subject] = { subject, animalOwned: false, growth: 0, feedCount: 0, decorIds: [], createdAt: new Date().toISOString() }
    saveFarms(m)
  }
  return m[subject]
}
/** 本地扣能量并写账本，返回 {ok, energy}；能量不足返回 {ok:false, need} */
function localFarmSpend(cost, reason) {
  const s = getState()
  const g = s.gamification
  let energy = Number(g.energy || 0)
  if (energy < cost) return { ok: false, need: cost - energy, energy }
  energy -= cost
  const ledger = (g.energyLedger || []).concat([{ id: 'e_' + Date.now() + Math.random().toString(36).slice(2, 6), delta: -cost, reason, at: new Date().toISOString() }]).slice(-200)
  g.energy = energy
  g.energyLedger = ledger
  saveState(s)
  return { ok: true, energy }
}

module.exports = {
  STORE_KEY, KNOWLEDGE, kName,
  getState, saveState, resetState,
  dateStr, isoAdd, isDue, fmtDue, offsetNow,
  composeTask, submitAnswer, finishTask, advanceDay,
  loadSamplePaper, loadCloudPaper, confirmQ, removePendingQuestion, confirmAll, editPendingQ, openPaperForEdit,
  applyCloudGamification, planetStage, weekAccuracy, ENERGY_RULES, PLANET_PATH,
  getFarms, saveFarms, ensureLocalFarm, localFarmSpend
}
