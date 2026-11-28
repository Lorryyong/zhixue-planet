'use strict'
/**
* 知识点字典（受控词表）：标准来源是 zx_knowledge_dict 表（英语 v1.0、数学 v1.0 已上线）。
* 本模块把录入侧的自由文本标签映射为字典代码：
* 代码本身 → 保留；字典中文名 → 转代码；旧自由标签别名 → 转代码；其余 → 丢弃（题目留空待人工标注）。
* 没有字典的学科 mapTags 原样返回，不拦截。
* 约定：结果第 1 个是主考点、第 2 个是副考点，最多保留 2 个。
* 数学的 C 类（综合与实践）与 G39 是题型标签，按定版规则只能作副考点，排序时自动沉到后面。
*/
const cache = {} // subject -> { at, subject, byCode, byName, version, items}
const TTL = 5 * 60 * 1000

// 旧自由标签 → 代码（按学科分表；存量迁移与历史导入共用，口径与各科定版说明一致）
const ALIASES = {
'英语': {
'词汇辨析': 'V01', '上下文语境': 'V01', '生活常识': 'V01', '语境理解': 'V01',
'同义词替换': 'V02', '同义转换': 'V02', '形容词同义词': 'V02',
'短语替换': 'M30', '短语辨析': 'M30', '动词短语': 'M30', '动词短语辨析': 'M30', 'take短语辨析': 'M30',
'固定表达': 'M14', '比较级': 'M17', '名词辨析': 'M01',
'数词': 'M21', '序数词': 'M21',
'语法填空': 'M33',
'阅读理解': 'R01', '细节理解': 'R01', '细节理解题': 'R01',
'词义猜测': 'R03', '主旨大意题': 'R04', '上下文衔接': 'R06', '短文填空': 'R06',
'完形填空': 'R11',
'现在完成时': 'S16', '一般过去时的被动语态': 'S24',
'非谓语动词': 'S26', '动词不定式': 'S26',
'英语-翻译': 'W10', '书面表达': 'W02'
},
'数学': {
'k1': 'G30', 'k2': 'A23', 'k3': 'G34', 'k4': 'F58', 'k5': 'F54', 'k6': 'G43', 'k7': 'G40', 'k8': 'A07',
'正数和负数': 'A01', '相反数': 'A01', '绝对值': 'A01', '非负数的性质': 'A01', '有理数大小比较': 'A01',
'有理数的加法': 'A02', '有理数的乘法': 'A02', '乘法分配律': 'A02',
'有理数的乘方': 'A03', '科学记数法': 'A03',
'实数的运算': 'A05', '实数的混合运算': 'A05',
'二次根式': 'A07',
'列代数式': 'A08', '整式求值': 'A08', '整体代入': 'A08',
'整式的加减': 'A09', '合并同类项': 'A09', '化简求值': 'A09',
'零指数幂': 'A10', '负整数指数幂': 'A10',
'平方差公式': 'A11',
'因式分解': 'A12', '提公因式': 'A12',
'定义域检验': 'A13',
'分式化简求值': 'A14',
'解一元一次方程': 'A16', '一元一次方程的应用': 'A17',
'一元二次方程': 'A23',
'翻折变换': 'G33', '矩形': 'G37',
'圆': 'G43', '弦切角': 'G44', '切线判定与性质': 'G45', '割线定理': 'G46',
'扇形弧长': 'G47', '扇形面积': 'G47',
'特殊角三角函数': 'G42',
'相似': 'G40', '相似与线段比': 'G40', '相似三角形分类讨论': 'G40',
'坐标法': 'F51', '定义域约束': 'F52',
'待定系数法': 'F59', '二次函数实际应用': 'F61', '最值分类讨论': 'F61', '建模': 'F61',
'二次函数综合': 'F62', '铅垂高求面积最值': 'F62',
'全面调查与抽样调查': 'S63', '数据分析': 'S64', '平均数': 'S64', '方差': 'S65', '极差': 'S65', '决策说理': 'S71',
'概率': 'S68', '不放回抽样': 'S69', '列举法': 'S69',
'新定义问题': 'C72', '规律探究': 'C73', '规律探索': 'C73', '面积分割': 'C73',
'存在性问题': 'C75'
},
'语文': {
'古诗文默写': 'J13',
'字音': 'J01', '字形': 'J02', '拼音写字': 'J02',
'词语运用': 'J03', '词语理解': 'J03',
'成语': 'J04', '成语运用': 'J04',
'病句': 'J05', '病句辨析': 'J05', '病句修改': 'J06',
'标点': 'J07', '句子排序': 'J08', '语段衔接': 'J08', '排序衔接': 'J08',
'修辞': 'J09', '词性': 'J10', '文学常识': 'J11',
'文言实词': 'P06', '文言文实词': 'P06', '文言虚词': 'P07', '文言翻译': 'P10',
'名著阅读': 'Z01',
'语文-写作': 'X01', '语文-阅读': 'D03'
},
'生物': {
'生物的特征': 'B01', '生命现象辨析': 'B01', '生物的判断依据': 'B01', '应激性': 'B01', '应激性辨析': 'B01',
'生物的生活需要营养': 'B01', '生命本质': 'B01', '病毒是否属于生物': 'B01',
'科学探究的基本方法': 'B01', '科学探究的方法': 'B01', '观察法': 'B01', '对照实验与单一变量': 'B01', '单一变量': 'B01', '对照实验': 'B01',
'生态系统的概念': 'B02', '生态系统的类型': 'B02', '生物圈': 'B02', '生物与环境的关系': 'B02', '食物链和食物网': 'B02',
'植物细胞的结构': 'B03', '显微镜的使用': 'B03', '细胞的结构与功能': 'B03', '细胞核': 'B03', '液泡': 'B03', '叶绿体': 'B03',
'细胞分化': 'B04', '细胞分裂': 'B04', '生物体的结构层次': 'B04', '单细胞生物': 'B04',
'光合作用': 'B06', '绿叶在光下制造有机物': 'B06', '光合作用原理的应用': 'B06',
'呼吸作用': 'B07', '呼吸作用原理的应用': 'B07',
'根尖的结构': 'B08', '蒸腾作用': 'B08', '导管和筛管': 'B08', '无机盐的作用': 'B08',
'果实和种子的形成': 'B05', '传粉和受精': 'B05', '种子萌发的条件': 'B05',
'生物的分类': 'B22', '遗传和变异': 'B23', '保护生态环境': 'B26'
},
'历史': {
'原始的农耕生活': 'I01', '炎帝和黄帝': 'I01', '中国境内的早期人类': 'I01',
'夏、商、西周的更替': 'I02', '分封制': 'I02',
'春秋争霸': 'I03', '百家争鸣': 'I03', '老子的主张': 'I03',
'秦巩固统一的措施': 'I04', '秦确立中央集权制': 'I04', '郡县制': 'I04', '秦的暴政和秦末农民起义': 'I04',
'隋朝大运河': 'I06', '科举制': 'I06', '藩镇割据': 'I06', '唐宋海上贸易': 'I06',
'宋朝加强中央集权': 'I07', '宋代商品经济': 'I07', '宋元科技': 'I07',
'废除丞相': 'I08', '明朝君主专制的加强': 'I08', '土尔扈特部东归': 'I08', '清朝边疆治理': 'I08',
'清代科技成就': 'I10'
},
'地理': {
'地球的形状': 'E01', '地球公转的基本特征': 'E02', '四季变化': 'E02', '昼夜长短的变化': 'E02', '二十四节气': 'E02',
'地图的选择和使用': 'E03', '电子地图': 'E03',
'板块构造学说': 'E04', '火山与地震': 'E04', '七大洲': 'E04',
'影响气温的因素': 'E06',
'世界人口的数量与增长': 'E08', '世界主要人口问题及解决措施': 'E08', '人种及其分布': 'E08', '世界文化的多样性及其保护': 'E08',
'因地制宜发展农业': 'E20',
'发达国家和发展中国家的关系': 'E30', '国际经济合作': 'E30', '国际合作': 'E30'
},
'道德与法治': {
'享受学习': 'N01', '学习兴趣': 'N01', '学习的意义': 'N01', '在实践中学习': 'N01',
'少年有梦': 'N01', '成就梦想': 'N01', '中学时代': 'N01',
'情绪的特点': 'N05', '情绪的调节': 'N05', '情感的作用': 'N05', '传递情感正能量': 'N05', '青春期矛盾心理': 'N05',
'异性朋友及异性情感': 'N06',
'美好集体': 'N07', '集体主义': 'N07',
'法律的特征和作用': 'N08', '法律保护': 'N08',
'建设法治中国': 'N17',
'奉献社会': 'N12', '承担责任': 'N12',
'构建人类命运共同体': 'N25', '有意义的生命': 'N04'
},
'物理': {
'密度测量': 'U14', '欧姆定律': 'U37', '电功率': 'U38', '压强': 'U22', '二力平衡': 'U20', '杠杆平衡条件': 'U29'
}

}
// 只能作副考点的代码（沉底排序）：数学 C 类 + G39；语文 Z05（名著专题探究）
function isSubOnly(subject, code) {
if (subject === '数学') return code.charAt(0) === 'C' || code === 'G39'
if (subject === '语文') return code === 'Z05'
if (subject === '物理') return code === 'U44'
if (subject === '历史') return code === 'I39'
if (subject === '生物') return code === 'B27'
if (subject === '地理') return code === 'E29'
if (subject === '道德与法治') return code === 'N26'
return false
}

async function load(db, subject) {
const now = Date.now()
const c = cache[subject]
if (c && now - c.at < TTL) return c
const res = await db.from('zx_knowledge_dict').select('code,block,q_types,name,ability,error_signs,note,version,textbook_unit')
.eq('subject', subject).eq('enabled', true).order('sort_no', { ascending: true}).limit(1000)
const rows = (res && res.data) || []
const byCode = {}, byName = {}
rows.forEach(function (r) { byCode[r.code] = r; if (r.name) byName[r.name] = r.code})
const entry = { at: now, subject, byCode, byName, version: rows.length? (rows[0].version || ''): '', items: rows}
cache[subject] = entry
return entry
}

function hasDict(dict) { return!!(dict && dict.items && dict.items.length)}

/** tags: 字符串数组 → { codes: [], dropped: []}；无字典时 codes=原样（截断 5） */
function mapTags(dict, tags) {
const list = (Array.isArray(tags)? tags: []).map(function (t) { return String(t || '').trim()}).filter(Boolean)
if (!hasDict(dict)) return { codes: list.slice(0, 5), dropped: []}
const alias = ALIASES[dict.subject] || {}
const codes = [], dropped = []
list.forEach(function (t) {
let code = null
if (dict.byCode[t]) code = t
else if (dict.byName[t]) code = dict.byName[t]
else if (alias[t] && dict.byCode[alias[t]]) code = alias[t]
if (code) { if (codes.indexOf(code) < 0) codes.push(code)}
else dropped.push(t)
})
// 题型类代码（数学 C 类/G39）只能作副考点：稳定沉底，保证第 1 位是具体知识条目
const main = codes.filter(function (c) { return!isSubOnly(dict.subject, c)})
const sub = codes.filter(function (c) { return isSubOnly(dict.subject, c)})
return { codes: main.concat(sub).slice(0, 2), dropped}
}

/** 给 AI 提示词用的字典清单文本：代码 + 名称（按板块分组，一行一条） */
function promptList(dict) {
if (!hasDict(dict)) return ''
const lines = []
let block = ''
dict.items.forEach(function (r) {
if (r.block!== block) { block = r.block; lines.push('')}
lines.push(r.code + ' ' + r.name)
})
return lines.join('\n')
}

/**
 * 由题目标签（字典代码）推学期：查各代码的 textbook_unit 册次（七上/九下…），
 * 「贯穿」类不计票；上/下多数胜出，平票或无票返回 ''。
 */
function termFromTags(dict, tags) {
if (!hasDict(dict)) return ''
let up = 0, down = 0
;(Array.isArray(tags)? tags: []).forEach(function (t) {
const e = dict.byCode[t]
if (!e || !e.textbook_unit) return
const u = String(e.textbook_unit)
if (u.indexOf('贯穿') >= 0) return
const m = u.match(/[七八九]([上下])/)
if (m) { if (m[1] === '上') up++; else down++; return }
if (u.indexOf('上册') >= 0) up++
else if (u.indexOf('下册') >= 0) down++
})
if (up === down) return ''
return up > down? '上学期': '下学期'
}

module.exports = { load, hasDict, mapTags, promptList, ALIASES, isSubOnly, termFromTags}
