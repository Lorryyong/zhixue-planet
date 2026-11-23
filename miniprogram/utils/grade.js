/**
 * 年级工具 —— 设置一次后，每年9月开学自动升一级。
 *
 * 数据结构（存在 zx_users）：
 *   grade_index ：设置时所选年级序号（1-12，见 GRADES）
 *   grade_base_year ：设置时所在的「学年」（如 2026 表示 2026年9月~2027年8月）
 * 计算：当前年级 = grade_index + (当前学年 - grade_base_year)，超过12为已毕业。
 */

// 年级序号 1-12：小学→初中→高中（v1.9.18 初一/初二/初三 改为 七年级/八年级/九年级）
const GRADES = [
  '小学一年级', '小学二年级', '小学三年级', '小学四年级', '小学五年级', '小学六年级',
  '七年级', '八年级', '九年级', '高一', '高二', '高三'
]

const SHORT = ['小一', '小二', '小三', '小四', '小五', '小六', '七年级', '八年级', '九年级', '高一', '高二', '高三']

/** 当前学年：9月及以后算新学年（如 2026-09 → 2026，2027-01 → 2026） */
function schoolYearNow() {
  const d = new Date()
  const m = d.getMonth() + 1
  return m >= 9 ? d.getFullYear() : d.getFullYear() - 1
}

/** 根据年级序号返回中文名 */
function labelOf(index) {
  const i = Number(index)
  return (i >= 1 && i <= GRADES.length) ? GRADES[i - 1] : '已毕业'
}

function shortOf(index) {
  const i = Number(index)
  return (i >= 1 && i <= SHORT.length) ? SHORT[i - 1] : '已毕业'
}

/**
 * 计算当前年级序号。
 * @param {number} gradeIndex 设置时年级序号
 * @param {number} baseYear 设置时学年
 * @returns {number} 当前年级序号（1-12，>12 返回 13 表示毕业）
 */
function currentIndex(gradeIndex, baseYear) {
  const gi = Number(gradeIndex)
  const by = Number(baseYear)
  if (!gi || !by) return 0
  const delta = schoolYearNow() - by
  const idx = gi + delta
  return Math.max(0, Math.min(13, idx)) // 0=未设置, 13=已毕业
}

/** 计算当前年级中文名 */
function currentLabel(gradeIndex, baseYear) {
  const idx = currentIndex(gradeIndex, baseYear)
  if (!idx) return ''
  if (idx > 12) return '已毕业'
  return labelOf(idx)
}

module.exports = { GRADES, SHORT, schoolYearNow, labelOf, shortOf, currentIndex, currentLabel }
