/**
 * 云函数 recognize —— PDF/图片试卷识别拆题
 *
 * 作用：接收云存储 fileID，调用 OCR + AI 大模型，输出结构化题目。
 * Demo 阶段：返回预置样题（与前端 Demo 一致），便于无云环境验证。
 * 生产替换：见下方 TODO，接入微信 OCR 插件 / 云调用 + Hunyuan/DeepSeek。
 *
 * 入参：{ fileID, subject }
 * 出参：{ questions: [{stem, options, answer, analysis, knowledge_tags, confidence}] }
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const SAMPLE = [
  { stem: '若 a−b=3，ab=2，则 a²+b² 的值为（　）', options: ['5', '9', '13', '11'], answer: 2, analysis: 'a²+b²=(a−b)²+2ab=9+4=13。', knowledge_tags: ['k2'], confidence: 0.96 },
  { stem: '已知 AB=AC，∠A=60°，则△ABC 是（　）', options: ['直角三角形', '等边三角形', '等腰直角三角形', '钝角三角形'], answer: 1, analysis: '有一个角60°的等腰三角形是等边三角形。', knowledge_tags: ['k1', 'k7'], confidence: 0.91 },
  { stem: '函数 y=−3x+4 的图象经过（　）', options: ['一、二、四象限', '一、三象限', '二、四象限', '一、二、三象限'], answer: 0, analysis: 'k<0,b>0，经过一、二、四象限。', knowledge_tags: ['k5'], confidence: 0.88 },
  { stem: '切线与过切点的半径的位置关系是（　）', options: ['平行', '垂直', '相交', '重合'], answer: 1, analysis: '圆的切线垂直于过切点的半径。', knowledge_tags: ['k6'], confidence: 0.93 }
]

exports.main = async (event) => {
  const { fileID, subject } = event

  // TODO(生产): 1) 云下载 fileID -> 图片；2) OCR 得到文本；3) AI 拆题+打标签
  // 参考：小程序端 wx.cloud.extend.AI.createModel('hunyuan-exp')
  //       model.generateText({ model:'hunyuan-2.0-instruct-20251111', messages:[...] })
  // 云函数端可用 @cloudbase/node-sdk 或 HTTP 调用大模型 API。

  return {
    code: 0,
    fileID,
    subject: subject || '数学',
    questions: SAMPLE,
    note: 'Demo 返回预置样题；生产环境请替换为 OCR + AI 结构化拆题。'
  }
}
