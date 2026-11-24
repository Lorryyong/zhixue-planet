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
  knowledge_points: ['knowledge_points', '知识点明细', '知识点课本', '知识点与课本'],
  book: ['book', '课本', '课本册次', '教材'],
  subject: ['subject', '学科', '科目'],
  score: ['score', '分值', '分数'],
  scoring_points: ['scoring_points', '评分要点', '要点'],
  difficulty: ['difficulty', '难度'],
  original: ['original', '来源', '试卷来源', '题目来源', '出处'],
  year: ['year', '出题年份', '年份'],
  grade: ['grade', '年级', '适用年级'],
  region: ['region', '省市', '省份', '城市', '地区'],
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
  // 只认 | 为分隔符（模板规范）：选项/答案/标签文本内部的逗号是内容的一部分，
  // 曾用 /[|｜,，]/ 切分导致选项被拆碎、答案下标错位、填空答案被拆成多空（2026-11-24 修复）。
  return String(v).split(/[|｜]/).map(function (s) { return s.trim() }).filter(Boolean)
}

// 知识点明细：形如「全等三角形:八年级上册|勾股定理:八年级下册」→ [{name, book}]
// 支持全角/半角冒号，未写册次的条目前端会用词典自动推断。
function parseKnowledgePoints(v) {
  if (Array.isArray(v)) {
    return v.map(function (x) {
      if (typeof x === 'string') return { name: x, book: '' }
      return { name: String((x && x.name) || ''), book: String((x && x.book) || '') }
    }).filter(function (x) { return !!x.name })
  }
  if (v == null || !String(v).trim()) return []
  return String(v).split(/[|｜]/).map(function (s) {
    const parts = s.split(/[:：]/)
    return { name: (parts[0] || '').trim(), book: (parts[1] || '').trim() }
  }).filter(function (x) { return !!x.name }).slice(0, 8)
}

// 常见误填：把题型名称写进 options 列（如"单选题/填空题/解答题"）
const TYPE_LABEL_RE = /^(单选题|单选题目|单选|选择题|多项选择题?|多选题|多选|不定项|判断题|判断|是非题|填空题|填空|默写|解答题|解答|简答题|计算题|计算|证明题|阅读理解|实验题|翻译题|作文|书面表达)$/
function isTypeLabel(s) { return TYPE_LABEL_RE.test(String(s || '').trim()) }
// 从 options 里剔除误填的题型标签，保留真实选项
function cleanOptions(v) {
  return splitArr(v).slice(0, 6).map(function (o) { return String(o).trim() })
    .filter(function (o) { return o && !isTypeLabel(o) })
}

/** 把单元格原始值转成字符串（兼容数字、日期） */
function cell(v) {
  if (v == null) return ''
  if (typeof v === 'number') return String(v)
  return String(v).trim()
}

/**
 * 解析 workbook（xlsx 的 sheet_to_json 结果数组）为题目数组
 * 容错策略：只要题干非空就尽量导入，问题记录到 q.issues + q.needFix，
 * 交由「校对」页人工补齐（选项/答案），不再整行丢弃导致题目丢失。
 * 返回 { questions:[...], invalid:[{row,error}], total, needFixCount }
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
  const cKps = findCol(header, 'knowledge_points')
  const cBook = findCol(header, 'book')
  const cSub = findCol(header, 'subject')
  const cScore = findCol(header, 'score')
  const cSp = findCol(header, 'scoring_points')
  const cDif = findCol(header, 'difficulty')
  const cOriginal = findCol(header, 'original')
  const cYear = findCol(header, 'year')
  const cGrade = findCol(header, 'grade')
  const cRegion = findCol(header, 'region')
  const cId = findCol(header, 'id')

  if (cStem < 0) throw new Error('Excel 缺少「题干/stem」列')

  const questions = []
  const invalid = []
  let needFixCount = 0
  dataRows.forEach(function (row, idx) {
    const cells = Array.isArray(row) ? row : header.map(function (h) { return row[h] })
    const g = function (c) { return c >= 0 ? cells[c] : '' }
    const r = normalizeOne({
      stem: g(cStem), q_type: g(cType), options: g(cOpt), answer: g(cAns),
      analysis: g(cAna), knowledge_tags: g(cTag), knowledge_points: g(cKps), book: g(cBook), subject: g(cSub),
      score: g(cScore), scoring_points: g(cSp), difficulty: g(cDif),
      original: g(cOriginal), year: g(cYear), grade: g(cGrade), region: g(cRegion), id: g(cId)
    })
    if (r.q) {
      questions.push(r.q)
      if (r.q.needFix) needFixCount++
    } else {
      invalid.push({ row: idx + 2, error: r.error, stem: cell(g(cStem)).slice(0, 40) })
    }
  })
  return { questions: questions, invalid: invalid, total: dataRows.length, needFixCount: needFixCount }
}

/** 归一化并校验单条（全题型）——容错版：问题记录为 issues，不整行丢弃 */
function normalizeOne(raw) {
  const stem = cell(raw.stem).slice(0, 500)
  if (!stem) return { error: '题干为空' }
  const issues = []

  let type = qt.normalizeType(cell(raw.q_type))
  if (!cell(raw.q_type)) {
    const optCount = cleanOptions(raw.options).length
    type = optCount >= 2 ? 'single' : 'blank'
  }
  const m = qt.meta(type)
  const options = cleanOptions(raw.options)
  // options 列若填的是题型名称，明确提示
  if (m.hasOptions && options.length === 0 && isTypeLabel(raw.options)) {
    issues.push('「选项」列填成了题型名称，请补填真实选项')
  }

  let answer
  if (m.answerKind === 'index') {
    const ansRaw = cell(raw.answer)
    const n = Number(ansRaw)
    if (options.length < 2) issues.push('缺少选项（单选/判断需至少 2 个）')
    if (!ansRaw || !Number.isInteger(n) || n < 0 || n >= Math.max(options.length, 1)) {
      // 保留原始答案文本，交给校对页修正；下标越界时置 0 并标记
      answer = Number.isInteger(n) && n >= 0 ? n : 0
      if (ansRaw) issues.push('答案下标超出选项范围（0=A，1=B…）')
      else issues.push('答案为空')
    } else {
      answer = n
    }
  } else if (m.answerKind === 'indexArray') {
    if (options.length < 2) issues.push('缺少选项（多选需至少 2 个）')
    if (!cell(raw.answer)) { issues.push('答案为空'); answer = [] }
    else {
      const arr = splitArr(raw.answer).map(Number)
      if (!arr.length || arr.some(function (n) { return !Number.isInteger(n) || n < 0 || n >= options.length })) {
        issues.push('多选答案应为选项下标，如 0|2')
        answer = []
      } else answer = arr
    }
  } else if (m.answerKind === 'textArray') {
    const arr = splitArr(raw.answer).map(function (x) { return String(x).trim() }).filter(Boolean)
    if (!arr.length) { issues.push('答案为空（多空用 | 分隔）'); answer = [] }
    else answer = arr
  } else {
    answer = cell(raw.answer).slice(0, 2000)
  }

  // 评分要点：形如 "求交点:5|写顶点:5"
  let scoring_points = []
  if (raw.scoring_points != null && String(raw.scoring_points).trim()) {
    scoring_points = splitArr(raw.scoring_points).map(function (p) {
      const parts = String(p).split(/[:：]/)
      return { point: (parts[0] || '').trim().slice(0, 80), score: Number(parts[1]) || 0 }
    }).filter(function (p) { return p.point }).slice(0, 8)
  }
  // 主观题参考答案为空但给了评分要点：用要点拼出参考答案，供 AI 判分；仍标记待核对
  // 注意：此判空只适用于主观题（reference）。选择题答案下标 0（选项 A）是合法值，
  // 曾用统一的 else if (!answer) 把 0 误报为「参考答案为空」（2026-11-24 修复）；
  // 其余题型的空答案已在各自支路记录 issues，不在此重复。
  if (m.answerKind === 'reference' && !answer && scoring_points.length) {
    answer = scoring_points.map(function (p) { return p.point }).join('；').slice(0, 2000)
    issues.push('参考答案由评分要点生成，请核对')
  } else if (m.answerKind === 'reference' && !answer) {
    issues.push('参考答案为空')
  }

  const tags = splitArr(raw.knowledge_tags).slice(0, 5)
  // 结构化知识点明细：优先解析 knowledge_points 列；否则若只给了统一「课本」列，套用到每个标签
  let kps = parseKnowledgePoints(raw.knowledge_points)
  if (!kps.length && String(raw.book || '').trim()) {
    const b = String(raw.book).trim().slice(0, 30)
    kps = tags.map(function (t) { return { name: t, book: b } })
  }
  const scoreNum = Number(raw.score)
  const confNum = Number(raw.confidence)
  const yearNum = Number(raw.year)
  // 年级别名标准化（v1.9.18）：统一为 七年级/八年级/九年级，旧写法"初一"等也归一到新名称
  const gradeRaw = cell(raw.grade)
  const gradeMap = {
    '初三': '九年级', '九上': '九年级', '九下': '九年级', '九年级': '九年级',
    '初一': '七年级', '七上': '七年级', '七下': '七年级', '七年级': '七年级',
    '初二': '八年级', '八上': '八年级', '八下': '八年级', '八年级': '八年级',
    '一年级': '小学一年级', '二年级': '小学二年级',
    '三年级': '小学三年级', '四年级': '小学四年级', '五年级': '小学五年级', '六年级': '小学六年级'
  }
  const gradeStd = gradeMap[gradeRaw] || gradeRaw
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
      knowledge_points: kps,
      subject: cell(raw.subject) || '数学',
      original: cell(raw.original).slice(0, 200),
      year: (Number.isInteger(yearNum) && yearNum >= 1990 && yearNum <= 2100) ? yearNum : 0,
      grade: gradeStd.slice(0, 20),
      region: cell(raw.region).slice(0, 40),
      needFix: issues.length > 0,
      issues: issues,
      confidence: (Number.isFinite(confNum) && confNum > 0) ? confNum : 1
    }
  }
}

/** 内置 Excel 样例（列头 + 5 道全题型示例），供前端生成样例文件 */
const SAMPLE_ROWS = [
  ['stem', 'q_type', 'options', 'answer', 'analysis', 'knowledge_tags', 'knowledge_points', 'subject', 'score', 'scoring_points', 'original', 'year', 'grade', 'region'],
  ['若 a−b=3，ab=2，则 a²+b² 的值为（　）', 'single', '5|9|13|11', '2', 'a²+b²=(a−b)²+2ab=9+4=13', '整式乘法|完全平方', '整式乘法:八年级上册|完全平方公式:八年级上册', '数学', '2', '', '2024北京中考真题', '2024', '九年级', '北京'],
  ['下列数中为无理数的是（　）', 'multiple', '√2|0.5|π|3', '0|2', '√2 与 π 是无理数', '实数', '实数:七年级下册|无理数:七年级下册', '数学', '3', '', '2024北京中考真题', '2024', '九年级', '北京'],
  ['全等三角形的对应边相等。', 'judge', '正确|错误', '1', '全等三角形对应边、对应角都相等', '全等三角形', '全等三角形:八年级上册', '数学', '2', '', '人教版八上', '', '八年级', ''],
  ['计算：2x+3=7，则 x=___', 'blank', '', '2', '移项得 2x=4，x=2', '一元一次方程', '一元一次方程:七年级上册', '数学', '3', '', '人教版七上', '', '七年级', ''],
  ['已知 AB=AC，∠A=60°，求证△ABC 是等边三角形。', 'solve', '', '∵AB=AC 且∠A=60°，∴∠B=∠C=60°，三角形三角相等故为等边三角形', '有一个角60°的等腰三角形是等边三角形', '等边三角形', '等边三角形:八年级上册', '数学', '10', '说明AB=AC:3|得出∠B=∠C=60°:3|结论等边:4', '2024北京中考真题', '2024', '初三', '北京']
]

module.exports = { parseRows, normalizeOne, SAMPLE_ROWS, findCol }
