/**
 * 中考题型体系 · 共享判分模块（云函数 / 小程序通用，CommonJS）
 *
 * 设计目标：题型与中考保持一致，用「通用题型 q_type + 学科 subject」覆盖各科。
 * 判分分两族：
 *   - objective 客观题：单选/多选/判断/填空 —— 云端按标准答案自动判分
 *   - subjective 主观题：解答/计算/阅读/实验/翻译/作文 —— AI 辅助判分，失败降级学生自评
 *
 * 存储约定（兼容 PG jsonb 列里「对象」与「JSON 字符串」两种形态，见 asValue）：
 *   options: 选择题选项数组
 *   answer : 客观题为下标/下标数组/文本(数组，逐空比对，支持 | 分隔别名)；主观题为参考答案文本
 *   scoring_points: 主观题评分要点数组 [{point, score}]
 *   score: 题目满分（主观题按点给分）
 */
const TYPES = {
  single:      { label: '单选题',   family: 'objective',  control: 'choice', answerKind: 'index',      hasOptions: true },
  multiple:    { label: '多选题',   family: 'objective',  control: 'choice', answerKind: 'indexArray', hasOptions: true },
  judge:       { label: '判断题',   family: 'objective',  control: 'choice', answerKind: 'index',      hasOptions: true },
  blank:       { label: '填空题',   family: 'objective',  control: 'blank',  answerKind: 'textArray',  hasOptions: false },
  solve:       { label: '解答题',   family: 'subjective', control: 'text',   answerKind: 'reference',  hasOptions: false },
  calculation: { label: '计算题',   family: 'subjective', control: 'text',   answerKind: 'reference',  hasOptions: false },
  reading:     { label: '阅读理解', family: 'subjective', control: 'text',   answerKind: 'reference',  hasOptions: false },
  experiment:  { label: '实验题',   family: 'subjective', control: 'text',   answerKind: 'reference',  hasOptions: false },
  translation: { label: '翻译题',   family: 'subjective', control: 'text',   answerKind: 'reference',  hasOptions: false },
  essay:       { label: '作文',     family: 'subjective', control: 'text',   answerKind: 'reference',  hasOptions: false }
}

// 分科题型别名 → 规范题型（导入 / AI 拆题时用，方便按中考叫法填写）
const ALIAS = {
  '单选': 'single', '选择题': 'single', '完形填空': 'single', 'cloze': 'single',
  '多选': 'multiple', '不定项': 'multiple',
  '判断': 'judge', '判断题': 'judge', '是非题': 'judge',
  '填空': 'blank', '默写': 'blank', '古诗文默写': 'blank', 'dictation': 'blank',
  '解答': 'solve', '简答': 'solve', '证明题': 'solve', '证明': 'solve',
  '计算': 'calculation',
  '阅读': 'reading', '阅读理解': 'reading', '完形阅读理解': 'reading',
  '实验': 'experiment', '实验探究': 'experiment',
  '翻译': 'translation',
  '作文': 'essay', '书面表达': 'essay', '写作': 'essay', 'composition': 'essay'
}

function normalizeType(raw) {
  const k = String(raw || '').trim().toLowerCase()
  if (TYPES[k]) return k
  if (ALIAS[String(raw || '').trim()]) return ALIAS[String(raw || '').trim()]
  if (ALIAS[k]) return ALIAS[k]
  return 'single'
}
function meta(type) { return TYPES[normalizeType(type)] || TYPES.single }
function isObjective(type) { return meta(type).family === 'objective' }
function isSubjective(type) { return meta(type).family === 'subjective' }

/** PG jsonb 列里可能是对象、数组，也可能是 JSON.stringify 后的字符串，统一解成 JS 值 */
function asValue(v) {
  if (v == null) return v
  if (typeof v !== 'string') return v
  const s = v.trim()
  if (!s) return ''
  if (s[0] === '[' || s[0] === '{' || /^-?\d+(\.\d+)?$/.test(s) || s === 'true' || s === 'false') {
    try { return JSON.parse(s) } catch (e) { /* 当普通文本 */ }
  }
  return v
}

/** 文本归一化：全角转半角、去空白与标点、小写，用于填空答案比对 */
function normText(s) {
  return String(s == null ? '' : s)
    .replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, '')
    .replace(/[，,。．.；;：:！!？?、'"`“”‘’()（）\[\]【】{}]/g, '')
    .toLowerCase()
}

/** 单个空的答案匹配：标准可为字符串，含 | 表示多个可接受答案 */
function matchOne(user, standard) {
  const u = normText(user)
  if (!u) return false
  if (standard && typeof standard === 'object' && Array.isArray(standard.accept)) {
    return standard.accept.some(a => normText(a) === u)
  }
  return String(standard || '').split(/[|｜]/).some(a => normText(a) === u)
}

/**
 * 客观题判分。返回 { correct:boolean }；主观题返回 null（交由 AI / 自评）。
 * q: { q_type, options, answer, scoring_points, score }
 */
function judgeObjective(q, answer) {
  const type = normalizeType(q && q.q_type)
  const m = TYPES[type]
  if (!m || m.family !== 'objective') return null
  const std = asValue(q.answer)

  if (m.answerKind === 'index') {
    return { correct: Number(answer) === Number(asValue(std)) }
  }
  if (m.answerKind === 'indexArray') {
    const a = (Array.isArray(std) ? std : asValue(std) || []).map(Number).sort((x, y) => x - y)
    const b = (Array.isArray(answer) ? answer : [answer]).map(Number).sort((x, y) => x - y)
    if (!a.length || a.length !== b.length) return { correct: false }
    return { correct: a.every((v, i) => v === b[i]) }
  }
  if (m.answerKind === 'textArray') {
    const stdArr = Array.isArray(std) ? std : [std]
    const usrArr = Array.isArray(answer) ? answer : [answer]
    if (usrArr.length < stdArr.length) return { correct: false }
    return { correct: stdArr.every((s, i) => matchOne(usrArr[i], s)) }
  }
  return { correct: false }
}

/** 把答案格式化成可读文本（错题库 / 校对展示用） */
function formatAnswer(q) {
  const type = normalizeType(q && q.q_type)
  const m = TYPES[type]
  const std = asValue(q.answer)
  if (type === 'single' || type === 'judge') {
    const idx = Number(std)
    const opts = asValue(q.options) || []
    return String.fromCharCode(65 + idx) + (opts[idx] ? '. ' + opts[idx] : '')
  }
  if (type === 'multiple') {
    const arr = (Array.isArray(std) ? std : asValue(std) || [])
    return arr.map(i => String.fromCharCode(65 + Number(i))).join('、')
  }
  if (m && m.answerKind === 'textArray') {
    return (Array.isArray(std) ? std : [std]).join(' / ')
  }
  return String(std == null ? '' : std)
}

/** 主观题 AI 判分 system prompt（阅卷老师角色，严格 JSON 输出） */
const AI_GRADE_SYSTEM = '你是严谨的中考阅卷老师。根据题干、参考答案、评分要点，对学生的作答评分。只输出严格 JSON，不要任何解释文字或代码块标记。格式：{"score":得分数字,"maxScore":满分数字,"correct":是否达到及格线(得分/满分>=0.6)的布尔值,"comment":"20字以内简短点评"}。要给分有理有据，答对要点即给对应分数，意思相近即可，不要求与参考答案逐字一致。'

module.exports = {
  TYPES, ALIAS, normalizeType, meta, isObjective, isSubjective,
  asValue, normText, matchOne, judgeObjective, formatAnswer, AI_GRADE_SYSTEM
}
