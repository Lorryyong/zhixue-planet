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
// 英语兔子 / 语文熊猫均为 WebGL(three.js) 程序化建模渲染的毛发质感 3D 形象，
// 5 帧横向雪碧图：站立/左跑/右跑/跳跃/转身（300×534/帧）。
const ANIMAL_IMAGES = {
  '英语': '/images/pets/rabbit3d_sheet.png',
  '语文': '/images/pets/panda3d_sheet.png'
}
const ANIMAL_SPRITE = {
  '英语': { frames: 5, ratio: 534 / 300 },
  '语文': { frames: 5, ratio: 534 / 300 }
} // 帧数、单帧高宽比
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

// ===== 2.0 星际商城目录（机制与旧商城同构：伙伴/装扮一次性，补给消耗加成长） =====
// 补给沿用旧食物的价格与成长（id 仍为 f1~f4）、装扮沿用旧装饰价格（id 仍为 d1~d6），仅换主题，
// 保证旧账本口径与已购记录可直接映射；伙伴为新增一次性收藏。
const SPACE_PARTNERS = [
  { id: 'sp1', emoji: '🤖', name: '探索机器人·星核', price: 120, desc: '基地智能助手，陪你巡视每一颗星球' },
  { id: 'sp2', emoji: '🛸', name: '巡天飞行器', price: 260, desc: '无人飞行器，负责星球轨道巡逻' },
  { id: 'sp3', emoji: '🛰️', name: '星际信使', price: 480, desc: '深空通讯卫星，与远方星站保持联系' }
]
const SPACE_SUPPLIES = [
  { id: 'f1', emoji: '🔋', name: '能量电池', price: 5, growth: 8, desc: '基地建设物资：使用后基地成长 +8' },
  { id: 'f2', emoji: '⚡', name: '离子核心', price: 12, growth: 20, desc: '基地建设物资：使用后基地成长 +20' },
  { id: 'f3', emoji: '🔮', name: '星尘结晶', price: 20, growth: 36, desc: '基地建设物资：使用后基地成长 +36' },
  { id: 'f4', emoji: '🌟', name: '恒星精华', price: 45, growth: 90, desc: '基地建设物资：使用后基地成长 +90' }
]
const SPACE_DECORS = [
  { id: 'd1', emoji: '🛰️', name: '轨道卫星', price: 10, desc: '一颗绕星球运行的小卫星' },
  { id: 'd2', emoji: '🔭', name: '深空观测塔', price: 30, desc: '望向星云深处' },
  { id: 'd3', emoji: '💫', name: '星尘花环', price: 30, desc: '基地周围的星尘光晕' },
  { id: 'd4', emoji: '🛡️', name: '能量护盾', price: 50, desc: '守护基地的蓝色屏障' },
  { id: 'd5', emoji: '🚀', name: '探索飞船', price: 120, desc: '随时待命的星际飞船' },
  { id: 'd6', emoji: '🪐', name: '行星光环', price: 200, desc: '为星球戴上壮丽光环' }
]
// 基地成长阶段（阈值与旧农场成长一致：0/30/100/300）
const BASE_STAGES = [
  { min: 0, name: '初建基地', emoji: '🌑' },
  { min: 30, name: '稳固基地', emoji: '🌒' },
  { min: 100, name: '繁荣基地', emoji: '🌓' },
  { min: 300, name: '星际枢纽', emoji: '🌕' }
]
function baseStageOf(growth) {
  const g = Math.max(0, Number(growth) || 0)
  let cur = BASE_STAGES[0], idx = 0
  for (let i = 0; i < BASE_STAGES.length; i++) { if (g >= BASE_STAGES[i].min) { cur = BASE_STAGES[i]; idx = i } }
  const next = BASE_STAGES[idx + 1] || null
  return { index: idx, name: cur.name, emoji: cur.emoji, next: next, growth: g }
}
// 专属装扮：每个等级一颗星球、一个标志性特性（一次性购买；需先解锁该等级）。
// fx 为地图/档案页上的呈现方式：ring 光环 / halo 光辉 / companion 伴体 / belt 星带 / mark 标记（显示 emoji）
const SPACE_SIGNS = [
  { id: 'g1', level: 1, emoji: '🚩', name: '登月纪念旗', price: 30, fx: 'mark', desc: '在月球基地旁插上探索者的旗帜' },
  { id: 'g2', level: 2, emoji: '⛰️', name: '奥林匹斯之巅', price: 50, fx: 'mark', desc: '太阳系最高的火山在火星上升起' },
  { id: 'g3', level: 3, emoji: '🛰️', name: '伽利略卫星群', price: 80, fx: 'companion', desc: '木星的四颗大卫星环绕空间站' },
  { id: 'g4', level: 4, emoji: '🪐', name: '土星环', price: 120, fx: 'ring', desc: '为你的土星戴上太阳系最壮丽的光环' },
  { id: 'g5', level: 5, emoji: '🌍', name: '比邻星b', price: 160, fx: 'companion', desc: '宜居带里的岩石行星现身伴飞' },
  { id: 'g6', level: 6, emoji: '⭐', name: '天狼星B伴星', price: 220, fx: 'companion', desc: '白矮星伴星在主星身旁闪耀' },
  { id: 'g7', level: 7, emoji: '✨', name: '第七颗星', price: 300, fx: 'mark', desc: '七姐妹星团的第七颗星被点亮' },
  { id: 'g8', level: 8, emoji: '🔹', name: '猎户腰带三星', price: 400, fx: 'belt', desc: '腰带三星在星云上方连成一线' },
  { id: 'g9', level: 9, emoji: '💫', name: '创生之柱光辉', price: 520, fx: 'halo', desc: '金色光辉环绕创生之柱' },
  { id: 'g10', level: 10, emoji: '🌌', name: '银心光环', price: 680, fx: 'halo', desc: '银河中心亮起璀璨光环' },
  { id: 'g11', level: 11, emoji: '🌠', name: '伴星系M32', price: 880, fx: 'companion', desc: '小伴星系在仙女座身旁运行' },
  { id: 'g12', level: 12, emoji: '🕸️', name: '星系光网', price: 1200, fx: 'halo', desc: '金色光网连接万千星系' }
]
function signOfLevel(level) { return SPACE_SIGNS.find(x => x.level === level) || null }
function spaceItemOf(id) {
  const p = SPACE_PARTNERS.find(x => x.id === id)
  if (p) return Object.assign({ kind: 'partner' }, p)
  const s = SPACE_SUPPLIES.find(x => x.id === id)
  if (s) return Object.assign({ kind: 'supply' }, s)
  const d = SPACE_DECORS.find(x => x.id === id)
  if (d) return Object.assign({ kind: 'decor' }, d)
  const g = SPACE_SIGNS.find(x => x.id === id)
  if (g) return Object.assign({ kind: 'sign' }, g)
  return null
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
  SPACE_PARTNERS, SPACE_SUPPLIES, SPACE_DECORS, SPACE_SIGNS, BASE_STAGES,
  stageOf, baseStageOf, spaceItemOf, signOfLevel, animalOf, foodOf, decorOf, buildFarmList, imageOf, spriteOf
}
