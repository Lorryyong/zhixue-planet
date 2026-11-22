/**
 * 成就徽章：定义 + 触发判定（前端展示 / 云端判定共用同一份规则）
 *
 * 设计：声明式条件 { metric, op, value }，引擎在每次答题后由云端 submitAnswer 调用，
 * 计算出「应解锁」的徽章 id 集合，与已拥有徽章合并去重后写回 gamification.badges。
 * 幂等：条件不因重复提交而反复触发；已解锁的徽章永久保留（resetEnergy 也不清除）。
 *
 * metric 取值：
 *   checkins       累计打卡天数
 *   streak         当前连续打卡天数
 *   energy         累计能量
 *   correctTotal   累计答对题数
 *   conquered      已攻克错题数
 *   mastered       掌握度≥85 的知识点数
 */
const BADGES = [
  { id: 'b1', emoji: '🌱', name: '初来乍到', desc: '完成第一次每日打卡', metric: 'checkins', op: '>=', value: 1 },
  { id: 'b2', emoji: '✏️', name: '答题新秀', desc: '累计答对 10 道题', metric: 'correctTotal', op: '>=', value: 10 },
  { id: 'b3', emoji: '📕', name: '错题克星', desc: '攻克 5 道错题', metric: 'conquered', op: '>=', value: 5 },
  { id: 'b4', emoji: '🎯', name: '盲区克星', desc: '3 个知识点掌握度达到 85%', metric: 'mastered', op: '>=', value: 3 },
  { id: 'b5', emoji: '🔥', name: '坚持之星', desc: '连续打卡 7 天', metric: 'streak', op: '>=', value: 7 },
  { id: 'b6', emoji: '⚡', name: '能量达人', desc: '累计 500 点能量', metric: 'energy', op: '>=', value: 500 },
  { id: 'b7', emoji: '🏆', name: '月度达人', desc: '连续打卡 30 天', metric: 'streak', op: '>=', value: 30 },
  { id: 'b8', emoji: '🌌', name: '星河之旅', desc: '累计 1500 点能量', metric: 'energy', op: '>=', value: 1500 }
]

const METRICS = {
  checkins: function (c) { return Number(c.checkinCount) || 0 },
  streak: function (c) { return Number(c.streak) || 0 },
  energy: function (c) { return Number(c.energy) || 0 },
  correctTotal: function (c) { return Number(c.correctTotal) || 0 },
  conquered: function (c) { return Number(c.conqueredCount) || 0 },
  mastered: function (c) { return Number(c.masteredCount) || 0 }
}

function test(def, ctx) {
  const get = METRICS[def.metric]
  if (!get) return false
  const v = get(ctx)
  if (def.op === '>') return v > def.value
  if (def.op === '===') return v === def.value
  return v >= def.value
}

/** 根据上下文计算当前应解锁的徽章 id 列表 */
function evaluate(ctx) {
  ctx = ctx || {}
  return BADGES.filter(function (b) { return test(b, ctx) }).map(function (b) { return b.id })
}

/** 合并「已拥有」与「新解锁」，去重并按定义顺序返回 */
function merge(owned, earned) {
  const set = {}
  ;(owned || []).forEach(function (id) { set[id] = true })
  ;(earned || []).forEach(function (id) { set[id] = true })
  return BADGES.map(function (b) { return b.id }).filter(function (id) { return set[id] })
}

/** 前端展示：返回全部徽章并标注是否解锁，同时给出新解锁的 id（用于弹窗） */
function hydrate(owned) {
  const set = {}
  ;(owned || []).forEach(function (id) { set[id] = true })
  return BADGES.map(function (b) {
    return {
      id: b.id, emoji: b.emoji, name: b.name, desc: b.desc,
      unlocked: !!set[b.id],
      progressHint: b.desc
    }
  })
}

module.exports = { BADGES, evaluate, merge, hydrate }
