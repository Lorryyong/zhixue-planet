/**
 * 智学宇宙 · 12 级探索等级配置（2.0）
 *
 * 等级按「累计星能量」(total_earned，只增不减) 计算，升级不扣积分，可跨级。
 * 门槛集中在此配置：前端展示用本文件；云函数（submitAnswer / login）内各有一份
 * 同步副本做服务端落库与升级历史记录，改门槛时三处一起改。
 */
const LEVELS = [
  { level: 1, name: '月球基地', min: 0, region: '太阳系 · 文明起点', title: '见习探索者', desc: '人类走出地球的第一步。月球基地是智学星际探索计划的起点，探索者在这里完成基础训练，望向深空。', img: '/images/space/lv1.jpg', node: '/images/space/n1.jpg', facts: { distance: '距地球 38.4 万千米', size: '直径 3,474 千米', temp: '表面 −173°C ~ 127°C', feature: '地球唯一的天然卫星' }, detail: '月球是人类唯一踏足过的地外天体。1969 年阿波罗 11 号在此着陆；它没有大气，脚印可以保存上百万年。月球基地将建在南极附近，那里的陨石坑底藏着水冰。' },
  { level: 2, name: '火星前哨', min: 200, region: '太阳系 · 文明起点', title: '见习探索者', desc: '红色星球上的第一个前哨站。稀薄的大气与漫天尘土之下，探索者学会在异星独立生存。', img: '/images/space/lv2.jpg', node: '/images/space/n2.jpg', facts: { distance: '距太阳约 2.28 亿千米', size: '直径 6,779 千米', temp: '平均约 −63°C', feature: '太阳系最高火山奥林匹斯山' }, detail: '火星的红色来自地表富含的氧化铁（铁锈）。它拥有太阳系最高的火山——奥林匹斯山，高约 21.9 千米，接近珠峰的 2.5 倍。一天 24.6 小时，和地球几乎一样。' },
  { level: 3, name: '木星空间站', min: 500, region: '太阳系 · 文明起点', title: '见习探索者', desc: '环绕太阳系最大行星的空间站。从这里回望，地球只是一颗蓝色的光点。', img: '/images/space/lv3.jpg', node: '/images/space/n3.jpg', facts: { distance: '距太阳约 7.78 亿千米', size: '直径 139,820 千米', temp: '云层顶约 −108°C', feature: '大红斑：比地球还大的风暴' }, detail: '木星是太阳系最大的行星，能装下 1300 个地球。大红斑是一场持续了至少 300 年的巨型风暴。1610 年伽利略发现了它的四颗大卫星——木卫一到木卫四。' },
  { level: 4, name: '土星环站', min: 1000, region: '恒星领域 · 能力进阶', title: '星际领航员', desc: '驻扎在土星环边缘的观测站。冰晶组成的星环是太阳系最壮丽的航标。', img: '/images/space/lv4.jpg', node: '/images/space/n4.jpg', facts: { distance: '距太阳约 14.3 亿千米', size: '直径 116,460 千米', temp: '平均约 −139°C', feature: '宽达 28 万千米的冰环' }, detail: '土星环由无数冰粒和碎石组成，宽约 28 万千米，厚度却只有约 10 米。土星密度比水还小——如果有一个足够大的浴缸，它能浮在水面上。' },
  { level: 5, name: '比邻星站', min: 1800, region: '恒星领域 · 能力进阶', title: '星际领航员', desc: '距离太阳最近的恒星——比邻星。4.24 光年的航程，是探索者离开太阳系的成人礼。', img: '/images/space/lv5.jpg', node: '/images/space/n5.jpg', facts: { distance: '距太阳 4.24 光年', size: '直径约为太阳的 14%', temp: '表面约 3,042°C', feature: '红矮星；宜居带有行星比邻星b' }, detail: '比邻星是离太阳最近的恒星，坐最快的探测器也要飞上万年。它是一颗红矮星，周围的行星比邻星 b 正位于宜居带，质量与地球相近，是人类寻找地外生命的首选目标之一。' },
  { level: 6, name: '天狼星站', min: 3000, region: '恒星领域 · 能力进阶', title: '星际领航员', desc: '夜空中最亮的恒星。天狼星站的光芒，为深空航行的飞船指引方向。', img: '/images/space/lv6.jpg', node: '/images/space/n6.jpg', facts: { distance: '距太阳 8.6 光年', size: '直径约为太阳的 1.7 倍', temp: '表面约 9,940°C', feature: '夜空中最亮的恒星' }, detail: '天狼星是全天最亮的恒星，亮度约为太阳的 25 倍。它其实是一个双星系统：明亮的天狼星 A 旁有一颗白矮星伴星天狼星 B，个头和地球差不多，质量却接近太阳。' },
  { level: 7, name: '昴星团空间站', min: 4800, region: '深空星云 · 智慧觉醒', title: '深空探险家', desc: '数百颗年轻恒星组成的星团，如撒在深空中的蓝色宝石。探索者在此学会与星辰对话。', img: '/images/space/lv7.jpg', node: '/images/space/n7.jpg', facts: { distance: '距太阳约 444 光年', size: '横跨约 13 光年', temp: '成员星多为炽热的蓝色恒星', feature: '肉眼可见的疏散星团' }, detail: '昴星团在中国古代属于二十八宿的「昴宿」，肉眼能看到 6~7 颗星，传说中是「七姐妹」。实际上它由 3000 多颗年轻恒星组成，年龄只有约 1 亿年。' },
  { level: 8, name: '猎户座星云', min: 7200, region: '深空星云 · 智慧觉醒', title: '深空探险家', desc: '恒星诞生的摇篮。气体与尘埃在这里凝聚成新的太阳，智慧也在探索中觉醒。', img: '/images/space/lv8.jpg', node: '/images/space/n8.jpg', facts: { distance: '距太阳约 1,344 光年', size: '横跨约 24 光年', temp: '气体云约 −272°C 起', feature: '离地球最近的恒星形成区' }, detail: '猎户座星云是离地球最近的大型恒星摇篮，肉眼就能在猎户座「腰带」下方看到它。星云中心有四颗新生大质量恒星组成的「四边形星团」，正在点亮整片星云。' },
  { level: 9, name: '鹰状星云', min: 10500, region: '深空星云 · 智慧觉醒', title: '深空探险家', desc: '著名的「创生之柱」所在。6500 光年外，星云的巨柱托举着新生的恒星。', img: '/images/space/lv9.jpg', node: '/images/space/n9.jpg', facts: { distance: '距太阳约 6,500 光年', size: '星云横跨约 70 光年', temp: '柱体为冰冷的氢气与尘埃', feature: '哈勃名作「创生之柱」' }, detail: '鹰状星云因形似展翅的鹰得名。1995 年哈勃望远镜拍下的「创生之柱」是天文学最著名的照片之一：三根高达数光年的气体柱里，新的恒星正在诞生。' },
  { level: 10, name: '银河探索站', min: 15000, region: '星系文明 · 无限探索', title: '星系开拓者', desc: '站在银河的尺度上回望：十万光年的星系，只是宇宙中的一座岛屿。', img: '/images/space/lv10.jpg', node: '/images/space/n10.jpg', facts: { distance: '我们身处其中', size: '直径约 10 万光年', temp: '含 1000 亿~4000 亿颗恒星', feature: '中心有人马座 A* 黑洞' }, detail: '银河系是我们所在的星系，太阳位于猎户臂上，绕银心转一圈要 2.3 亿年。银河中心藏着一颗 430 万倍太阳质量的黑洞——人马座 A*，2022 年人类拍下了它的照片。' },
  { level: 11, name: '仙女座星系', min: 21000, region: '星系文明 · 无限探索', title: '星系开拓者', desc: '距离银河系最近的大星系，250 万光年之遥。它正向我们走来，如一场跨越时空的会面。', img: '/images/space/lv11.jpg', node: '/images/space/n11.jpg', facts: { distance: '距银河系约 254 万光年', size: '直径约 22 万光年', temp: '含约 1 万亿颗恒星', feature: '正以 110 千米/秒向银河系靠近' }, detail: '仙女座星系比银河系更大，是北半球肉眼能看到的最遥远天体——你看到的光出发时，人类祖先还在用石器。它正向银河系靠近，约 40 亿年后两者将相撞合并。' },
  { level: 12, name: '拉尼亚凯亚', min: 30000, region: '星系文明 · 无限探索', title: '星系开拓者', desc: '包含十万个星系的超星系团，我们宇宙家园的真正疆域。探索，永无止境。', img: '/images/space/lv12.jpg', node: '/images/space/n12.jpg', facts: { distance: '横跨约 5.2 亿光年', size: '包含约 10 万个星系', temp: '总质量约 10¹⁷ 倍太阳质量', feature: '我们所在的超星系团' }, detail: '拉尼亚凯亚在夏威夷语中意为「无尽的天堂」。2014 年天文学家绘制出它的边界：包括银河系在内的十万个星系，都在向着一个叫「巨引源」的引力中心缓缓流动。' }
]

/** 按累计星能量计算等级信息：当前等级、本级进度%、下一级与差距 */
function levelOf(totalEarned) {
  const total = Math.max(0, Number(totalEarned) || 0)
  let cur = LEVELS[0], idx = 0
  for (let i = 0; i < LEVELS.length; i++) {
    if (total >= LEVELS[i].min) { cur = LEVELS[i]; idx = i }
  }
  const next = LEVELS[idx + 1] || null
  const pct = next ? Math.min(100, Math.max(0, Math.round((total - cur.min) / (next.min - cur.min) * 100))) : 100
  return {
    level: cur.level, name: cur.name, region: cur.region, title: cur.title,
    desc: cur.desc, img: cur.img, total,
    nextName: next ? next.name : '', nextLevel: next ? next.level : 0,
    toNext: next ? Math.max(0, next.min - total) : 0, pct,
    isMax: !next
  }
}

module.exports = { LEVELS, levelOf }
