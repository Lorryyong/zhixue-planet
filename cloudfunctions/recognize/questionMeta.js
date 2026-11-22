/**
 * questionMeta.js —— 题目元数据自动解析（recognize 云函数内使用）
 * 从「来源」文本推断：出题年份(year) / 年级(grade) / 省市(region)
 * 例："改编自2024年深圳中考数学卷" → { year: 2024, grade: '初三', region: '深圳' }
 *
 * 年级取值与 miniprogram/utils/grade.js 的 GRADES 保持一致。
 */
const GRADES = [
  '小学一年级', '小学二年级', '小学三年级', '小学四年级', '小学五年级', '小学六年级',
  '初一', '初二', '初三', '高一', '高二', '高三'
]

/** 学段：primary=小学, junior=初中, senior=高中, unknown=未识别 */
function stageOf(gradeLabel) {
  const i = GRADES.indexOf(String(gradeLabel || '').trim())
  if (i < 0) return 'unknown'
  if (i <= 5) return 'primary'
  if (i <= 8) return 'junior'
  return 'senior'
}

/** 汉字数字 → 阿拉伯数字 */
function cnNum(s) {
  const map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 }
  return map[s] || 0
}

// 省市关键词（长词优先，避免被短词抢先匹配）
const REGION_WORDS = [
  '黑龙江', '内蒙古', '新疆', '西藏', '宁夏', '青海', '海南', '香港', '澳门', '台湾',
  '北京', '上海', '天津', '重庆', '深圳', '广州', '杭州', '南京', '武汉', '成都', '西安',
  '苏州', '青岛', '大连', '宁波', '厦门', '长沙', '郑州', '济南', '合肥', '福州', '昆明',
  '贵阳', '沈阳', '哈尔滨', '长春', '石家庄', '太原', '南昌', '南宁', '兰州', '海口',
  '无锡', '常州', '温州', '佛山', '东莞', '珠海', '中山', '惠州', '汕头', '烟台', '潍坊',
  '徐州', '扬州', '嘉兴', '绍兴', '金华', '泉州', '洛阳', '襄阳', '宜昌', '株洲', '湘潭',
  '赣州', '芜湖', '绵阳', '遵义', '桂林', '三亚', '唐山', '保定', '邯郸', '秦皇岛', '大同',
  '包头', '呼和浩特', '乌鲁木齐', '拉萨', '西宁', '银川', '徐州', '连云港', '盐城', '南通',
  '广东', '江苏', '浙江', '山东', '四川', '河南', '河北', '湖南', '湖北', '福建', '安徽',
  '陕西', '江西', '辽宁', '吉林', '云南', '贵州', '广西', '山西', '甘肃'
]

/** 从文本推断年级（返回标准标签或 ''） */
function inferGrade(text) {
  const t = String(text || '')
  if (!t) return ''
  // 高中优先（含"高考"）
  if (/高三|高考/.test(t)) return '高三'
  if (/高二/.test(t)) return '高二'
  if (/高一/.test(t)) return '高一'
  // 中考 / 初三 / 九年级 / 九上九下
  if (/中考|九年级|初三|九上|九下/.test(t)) return '初三'
  if (/八年级|初二|八上|八下/.test(t)) return '初二'
  if (/七年级|初一|七上|七下/.test(t)) return '初一'
  // 小学：X年级 / 小X
  const small = t.match(/(小学|小)?([一二三四五六])(年级|上|下)/)
  if (small) {
    const n = cnNum(small[2])
    if (n >= 1 && n <= 6) return GRADES[n - 1]
  }
  return ''
}

/** 从文本推断年份（20xx，合理范围 1990~2100） */
function inferYear(text) {
  const m = String(text || '').match(/(?:19|20)\d{2}/)
  if (!m) return 0
  const y = Number(m[0])
  return (y >= 1990 && y <= 2100) ? y : 0
}

/** 从文本推断省市 */
function inferRegion(text) {
  const t = String(text || '')
  if (!t) return ''
  for (const w of REGION_WORDS) {
    if (t.indexOf(w) >= 0) return w
  }
  return ''
}

/**
 * 综合推断题目元数据。显式传入的值优先，否则从 original 自动解析。
 * @param {string} original 来源文本
 * @param {object} explicit 显式字段 {year, grade, region}
 */
function inferMeta(original, explicit) {
  const ex = explicit || {}
  const year = Number(ex.year) > 0 ? Number(ex.year) : inferYear(original)
  let grade = String(ex.grade || '').trim()
  if (!grade || GRADES.indexOf(grade) < 0) grade = inferGrade(original)
  const region = String(ex.region || '').trim() || inferRegion(original)
  return { year: year, grade: grade, region: region }
}

module.exports = { GRADES, stageOf, inferGrade, inferYear, inferRegion, inferMeta }
