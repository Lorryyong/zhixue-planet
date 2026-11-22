/**
 * contentCheck.js —— 内容安全检测（P0 合规兜底，v1.9.4）
 *
 * 背景：产品定位「学习工具 + 未成年人保护」，用户上传的图片、AI 拆题文本、
 *       昵称等需做内容安全。当前环境是腾讯云控制台创建的 PG 环境，微信云开发的
 *       openapi(msgSecCheck) 通常不可用，因此采用 fail-open 双层策略：
 *
 *   1) 本地高危词硬拦截：极少量明确违规词（黄赌毒/暴恐/违禁品），正常学科内容不误伤；
 *   2) 可选云端 msgSecCheck：设置环境变量 SEC_USE_MSGCSEC=true 且环境支持时启用，
 *      suggest=pass/review/risky 判定；调用失败一律放行（fail-open），保证答题闭环不中断。
 *
 * 原则：宁可漏拦，不可阻断学习；所有判定仅作安全网，不能替代平台侧内容审核。
 */
const HIGH_RISK = [
  '冰毒', '海洛因', '摇头丸', '网上赌博', '网络赌博', '博彩网站', '色情网站',
  '成人网站', '传播淫秽', '卖淫', '嫖娼', '恐怖袭击', '制作炸弹', '管制刀具'
]

/** 本地高危词命中（仅明确违规词，避免误伤学科内容） */
function localHit(text) {
  const s = String(text == null ? '' : text)
  for (let i = 0; i < HIGH_RISK.length; i++) {
    if (s.indexOf(HIGH_RISK[i]) >= 0) return HIGH_RISK[i]
  }
  return ''
}

/**
 * 检测文本。返回 {pass:boolean, reason?:string}。
 * @param {string} text 待检文本
 * @param {string} openid 用户 openid（云端 msgSecCheck 用）
 */
async function checkText(text, openid) {
  const s = String(text == null ? '' : text).trim()
  if (!s) return { pass: true }
  const hit = localHit(s)
  if (hit) return { pass: false, reason: '内容含违规信息（' + hit + '）' }

  if (String(process.env.SEC_USE_MSGCSEC || '').toLowerCase() === 'true') {
    try {
      const wx = require('wx-server-sdk')
      wx.init({ env: wx.DYNAMIC_CURRENT_ENV })
      const r = await wx.openapi.security.msgSecCheck({
        content: s.slice(0, 2500), version: 2, scene: 2, openid: openid || undefined
      })
      const suggest = r && (r.suggest || (r.result && r.result.suggest))
      if (suggest === 'risky' || suggest === 'review') {
        return { pass: false, reason: '内容安全检测未通过' }
      }
    } catch (e) {
      // 环境不支持 / 未开通：放行，保证闭环不中断
      console.warn('[contentCheck] msgSecCheck 不可用，放行：', e && e.message)
    }
  }
  return { pass: true }
}

module.exports = { checkText, localHit, HIGH_RISK }
