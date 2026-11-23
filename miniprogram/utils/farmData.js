/**
 * 农场共享定义（v1.9.8）—— 科目农场 / 小动物 / 食物 / 装饰 / 成长规则
 *
 * 设计：每门科目一个农场，每个农场绑定一种固定的小动物（科目→动物映射）。
 *      用户用能量购买动物（解锁饲养）、购买食物喂养提升成长值、购买装饰装扮农场。
 *      所有价格、成长阈值在此集中定义，前端展示与云端扣费共用同一份规则（云函数目录各存一份副本）。
 *
 * 能量收支由云端 farm 云函数权威处理：前端只展示，不直接改能量。
 */

// 科目 → 小动物（每个农场一种）
const SUBJECT_ANIMALS = {
  '语文': { emoji: '🐼', name: '胖胖', kind: '熊猫', desc: '腹有诗书气自华的国学小熊猫' },
  '数学': { emoji: '🦊', name: '小思', kind: '狐狸', desc: '思维敏捷的推理小狐狸' },
  '英语': { emoji: '🐰', name: '瑞瑞', kind: '兔子', desc: '蹦蹦跳跳记单词的小兔子' },
  '物理': { emoji: '🐻', name: '力力', kind: '小熊', desc: '力气满满的力学小熊' },
  '化学': { emoji: '🐧', name: '化化', kind: '企鹅', desc: '爱做实验的冷静小企鹅' },
  '生物': { emoji: '🐢', name: '漫漫', kind: '乌龟', desc: '慢条斯理观察生命的小乌龟' },
  '历史': { emoji: '🦉', name: '博博', kind: '猫头鹰', desc: '通晓古今的博学时owl' },
  '地理': { emoji: '🐘', name: '广广', kind: '大象', desc: '走遍山河的地理小象' },
  '道德与法治': { emoji: '🦁', name: '正正', kind: '狮子', desc: '正直勇敢的法治小狮子' }
}
const DEFAULT_ANIMAL = { emoji: '🐣', name: '小雏', kind: '小鸡', desc: '一颗等待孵化 learning 蛋' }

// 科目 → 宠物立绘（3D 序列帧雪碧图，放在 miniprogram/images/pets/）。未配置的科目仍用 emoji。
// 英语兔子已配置 WebGL(three.js) 程序化建模渲染的 3D 白兔，5 帧横向雪碧图：站立/左跑/右跑/跳跃/转身。
const ANIMAL_IMAGES = {
  '英语': '/images/pets/rabbit3d_sheet.png'
}
const ANIMAL_SPRITE = { '英语': { frames: 5, ratio: 534 / 300 } } // 帧数、单帧高宽比（新毛发兔雪碧图 300×534/帧）
function imageOf(subject) { return ANIMAL_IMAGES[subject] || '' }
function spriteOf(subject) { return ANIMAL_SPRITE[subject] || null }

// 商店：食物（喂养加成长值）
const FOODS = [
  { id: 'f1', emoji: '🌾', name: '青草', price: 5, growth: 8, desc: '基础口粮，成长 +8' },
  { id: 'f2', emoji: '🥕', name: '胡萝卜', price: 12, growth: 20, desc: '营养蔬菜，成长 +20' },
  { id: 'f3', emoji: '🍎', name: '苹果', price: 20, growth: 36, desc: '新鲜水果，成长 +36' },
  { id: 'f4', emoji: '🎂', name: '能量蛋糕', price: 45, growth: 90, desc: '豪华大餐，成长 +90' }
]

// 商店：装饰（一次性购买，永久装扮农场）
const DECORS = [
  { id: 'd1', emoji: '🌱', name: '小草', price: 10, desc: '一抹新绿' },
  { id: 'd2', emoji: '🌳', name: '大树', price: 30, desc: '树荫乘凉' },
  { id: 'd3', emoji: '🌸', name: '花丛', price: 30, desc: '花香四溢' },
  { id: 'd4', emoji: '🪵', name: '围栏', price: 50, desc: '可爱栅栏' },
  { id: 'd5', emoji: '🏠', name: '小屋', price: 120, desc: '温馨小窝' },
  { id: 'd6', emoji: '🌈', name: '彩虹', price: 200, desc: '雨后彩虹' }
]

// 购买动物的解锁价格
const ANIMAL_PRICE = 40

// 成长阶段（按成长值）
const STAGES = [
  { min: 0, name: '幼崽', emoji: '🥚', desc: '刚出生的小家伙' },
  { min: 30, name: '成长期', emoji: '🐣', desc: '正在茁壮成长' },
  { min: 100, name: '成熟期', emoji: '🌟', desc: '长大啦，神采奕奕' },
  { min: 300, name: '传说期', emoji: '👑', desc: '农场里的传奇伙伴' }
]

function stageOf(growth) {
  const g = Math.max(0, Number(growth) || 0)
  let cur = STAGES[0], idx = 0
  for (let i = 0; i < STAGES.length; i++) { if (g >= STAGES[i].min) { cur = STAGES[i]; idx = i } }
  const next = STAGES[idx + 1] || null
  return { index: idx, name: cur.name, emoji: cur.emoji, desc: cur.desc, next: next, growth: g }
}

function animalOf(subject) {
  return SUBJECT_ANIMALS[subject] || DEFAULT_ANIMAL
}
function foodOf(id) { return FOODS.find(f => f.id === id) || null }
function decorOf(id) { return DECORS.find(d => d.id === id) || null }

/** 默认科目列表（与 subjects 页 SUBJECT_BOOKS 保持一致） */
const ALL_SUBJECTS = Object.keys(SUBJECT_ANIMALS)

/** 从用户勾选的学科生成农场列表；无勾选时用全部科目（保底） */
function buildFarmList(selectedSubjects) {
  const sel = Array.isArray(selectedSubjects) ? selectedSubjects.filter(x => x && x.name).map(x => x.name) : []
  const subjects = sel.length ? sel : ALL_SUBJECTS
  return subjects.map(name => {
    const a = animalOf(name)
    return { subject: name, animalEmoji: a.emoji, animalName: a.name, animalKind: a.kind }
  })
}

module.exports = {
  SUBJECT_ANIMALS, DEFAULT_ANIMAL, ANIMAL_IMAGES, ANIMAL_SPRITE, FOODS, DECORS, ANIMAL_PRICE, STAGES, ALL_SUBJECTS,
  stageOf, animalOf, foodOf, decorOf, buildFarmList, imageOf, spriteOf
}
