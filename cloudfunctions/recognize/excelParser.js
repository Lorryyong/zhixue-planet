/**
 * Excel/CSV 导入题解析模块（用户态，全题型）
 * 把 Excel 工作簿解析为与 recognize AI 拆题同构的题目数组：
 *   { q_type, stem, options, answer, scoring_points, score, analysis, knowledge_tags, confidence }
 * 列头同时支持中文与英文别名；题型校验复用 questionTypes.js。
 */
const qt = require('./questionTypes.js')

// 列头别名映射（小写去空格后匹配）
const COL_ALIASES = {
  stem: ['stem', '题干', '题目', '问题'],
  q_type: ['q_type', 'qtype', 'type', '题型', '类型'],
  options: ['options', '选项'],
  answer: ['answer', '答案', '正确答案'],
  analysis: ['analysis', '解析', '答案解析'],
  knowledge_tags: ['knowledge_tags', 'knowledge', 'tags', '知识点', '标签'],
  subject: ['subject', '学科', '科目'],
  score: ['score', '分值', '分数'],
  scoring_points: ['scoring_points', '评分要点', '要点'],
  difficulty: ['difficulty', '难度'],
  id: ['id', '编号']
}

function normKey(k) { return String(k == null ? '' : k).toLowerCase().replace(/[\s_]/g, '') }

/** 在列头里找某个字段的列索引 */
function findCol(header, field) {
  const aliases = COL_ALIASES[field] || []
  const normHeader = header.map(normKey)
  for (let i = 0; i < aliases.length; i++) {
    const idx = normHeader.indexOf(normKey(aliases[i]))
    if (idx >= 0) return idx
  }
  return -1
}

function splitArr(v) {
  if (Array.isArray(v)) return v.map(String)
  if (v == null) return []
  return String(v).split(/[|｜,，]/).map(function (s) { return s.trim() }).filter(Boolean)
}

/** 把单元格原始值转成字符串（兼容数字、日期） */
function cell(v) {
  if (v == null) return ''
  if (typeof v === 'number') return String(v)
  return String(v).trim()
}

/**
 * 解析 workbook（xlsx 的 sheet_to_json 结果数组）为题目数组
 * 返回 { questions:[...], invalid:[{row,error}], total }
 */
function parseRows(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('Excel 内容为空')
  // 首行为列头：把对象行转成数组（保留列顺序）
  const first = rows[0]
  let header, dataRows
  if (Array.isArray(first)) {
    header = first.map(cell)
    dataRows = rows.slice(1)
  } else {
    header = Object.keys(first)
    dataRows = rows
  }
  const cStem = findCol(header, 'stem')
  const cType = findCol(header, 'q_type')
  const cOpt = findCol(header, 'options')
  const cAns = findCol(header, 'answer')
  const cAna = findCol(header, 'analysis')
  const cTag = findCol(header, 'knowledge_tags')
  const cSub = findCol(header, 'subject')
  const cScore = findCol(header, 'score')
  const cSp = findCol(header, 'scoring_points')
  const cDif = findCol(header, 'difficulty')
  const cId = findCol(header, 'id')

  if (cStem < 0) throw new Error('Excel 缺少「题干/stem」列')

  const questions = []
  const invalid = []
  dataRows.forEach(function (row, idx) {
    const cells = Array.isArray(row) ? row : header.map(function (h) { return row[h] })
    const g = function (c) { return c >= 0 ? cells[c] : '' }
    const r = normalizeOne({
      stem: g(cStem), q_type: g(cType), options: g(cOpt), answer: g(cAns),
      analysis: g(cAna), knowledge_tags: g(cTag), subject: g(cSub),
      score: g(cScore), scoring_points: g(cSp), difficulty: g(cDif), id: g(cId)
    })
    if (r.q) questions.push(r.q)
    else invalid.push({ row: idx + 2, error: r.error, stem: cell(g(cStem)).slice(0, 40) })
  })
  return { questions: questions, invalid: invalid, total: dataRows.length }
}

/** 归一化并校验单条（全题型），返回 {q} 或 {error} */
function normalizeOne(raw) {
  const stem = cell(raw.stem).slice(0, 500)
  if (!stem) return { error: '题干为空' }

  let type = qt.normalizeType(cell(raw.q_type))
  if (!cell(raw.q_type)) {
    const optCount = splitArr(raw.options).filter(Boolean).length
    type = optCount >= 2 ? 'single' : 'blank'
  }
  const m = qt.meta(type)
  const options = splitArr(raw.options).slice(0, 6).map(function (o) { return String(o).trim() }).filter(Boolean)

  let answer
  if (m.answerKind === 'index') {
    if (options.length < 2) return { error: '【' + m.label + '】选项少于 2 个' }
    const ansRaw = cell(raw.answer)
    if (!ansRaw) return { error: '【' + m.label + '】答案为空' }
    const n = Number(ansRaw)
    if (!Number.isInteger(n) || n < 0 || n >= options.length) {
      return { error: '【' + m.label + '】答案下标应为 0–' + (options.length - 1) + '（0=A，1=B…）' }
    }
    answer = n
  } else if (m.answerKind === 'indexArray') {
    if (options.length < 2) return { error: '【' + m.label + '】选项少于 2 个' }
    if (!cell(raw.answer)) return { error: '【' + m.label + '】答案为空' }
    const arr = splitArr(raw.answer).map(Number)
    if (!arr.length || arr.some(function (n) { return !Number.isInteger(n) || n < 0 || n >= options.length })) {
      return { error: '【' + m.label + '】多选答案应为下标，如 0|2' }
    }
    answer = arr
  } else if (m.answerKind === 'textArray') {
    const arr = splitArr(raw.answer).map(function (x) { return String(x).trim() }).filter(Boolean)
    if (!arr.length) return { error: '【' + m.label + '】答案不能为空（多空用 | 分隔）' }
    answer = arr
  } else {
    answer = cell(raw.answer).slice(0, 2000)
    if (!answer) return { error: '【' + m.label + '】参考答案不能为空' }
  }

  // 评分要点：形如 "求交点:5|写顶点:5"
  let scoring_points = []
  if (raw.scoring_points != null && String(raw.scoring_points).trim()) {
    scoring_points = splitArr(raw.scoring_points).map(function (p) {
      const parts = String(p).split(/[:：]/)
      return { point: (parts[0] || '').trim().slice(0, 80), score: Number(parts[1]) || 0 }
    }).filter(function (p) { return p.point }).slice(0, 8)
  }

  const tags = splitArr(raw.knowledge_tags).slice(0, 5)
  const scoreNum = Number(raw.score)
  const confNum = Number(raw.confidence)
  return {
    q: {
      id: cell(raw.id) || ('q_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
      q_type: type,
      stem: stem,
      options: m.hasOptions ? options : [],
      answer: answer,
      scoring_points: scoring_points,
      score: (Number.isFinite(scoreNum) && scoreNum > 0) ? scoreNum : (m.family === 'subjective' ? 10 : 2),
      analysis: cell(raw.analysis).slice(0, 800),
      knowledge_tags: tags,
      subject: cell(raw.subject) || '数学',
      confidence: (Number.isFinite(confNum) && confNum > 0) ? confNum : 1
    }
  }
}

/** 内置 Excel 样例（列头 + 5 道全题型示例），供前端生成样例文件 */
const SAMPLE_ROWS = [
  ['stem', 'q_type', 'options', 'answer', 'analysis', 'knowledge_tags', 'subject', 'score', 'scoring_points'],
  ['若 a−b=3，ab=2，则 a²+b² 的值为（　）', 'single', '5|9|13|11', '2', 'a²+b²=(a−b)²+2ab=9+4=13', '整式乘法|完全平方', '数学', '2', ''],
  ['下列数中为无理数的是（　）', 'multiple', '√2|0.5|π|3', '0|2', '√2 与 π 是无理数', '实数', '数学', '3', ''],
  ['全等三角形的对应边相等。', 'judge', '正确|错误', '1', '全等三角形对应边、对应角都相等', '全等三角形', '数学', '2', ''],
  ['计算：2x+3=7，则 x=___', 'blank', '', '2', '移项得 2x=4，x=2', '一元一次方程', '数学', '3', ''],
  ['已知 AB=AC，∠A=60°，求证△ABC 是等边三角形。', 'solve', '', '∵AB=AC 且∠A=60°，∴∠B=∠C=60°，三角形三角相等故为等边三角形', '有一个角60°的等腰三角形是等边三角形', '等边三角形', '数学', '10', '说明AB=AC:3|得出∠B=∠C=60°:3|结论等边:4']
]

module.exports = { parseRows, normalizeOne, SAMPLE_ROWS, findCol }
