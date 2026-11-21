/**
 * 云函数 recognize —— PDF/图片试卷识别拆题 + 确认入库（PostgreSQL 版）
 *
 * 使用 @cloudbase/js-sdk v3 的 app.rdb() 访问 PG（与 composeTask/submitAnswer 一致）。
 * 两种动作：
 *   1) 识别（默认）：接收 fileID，写入 zx_papers(pending) + zx_questions(need_confirm)，
 *      返回带云端 id 的题目，供前端进入人工校对页。
 *   2) 确认入库：{ action:'confirm', studentId, paperId }，把该卷题目置为 confirmed，
 *      更新试卷 confirm_status='confirmed'。题目随后即可被 composeTask 组卷。
 *
 * Demo 阶段识别返回预置样题；生产替换见文件末尾 TODO。
 *
 * 入参：{ studentId, fileID, fileName, subject }
 *      { action:'confirm', studentId, paperId }
 * 出参：{ code:0, paperId, subject, questions:[{id, stem, options, answer, analysis, tags, confidence}] }
 *      { code:0, count }（确认入库）
 */
const cloudbase = require('@cloudbase/js-sdk')

function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

const SAMPLE = [
  { stem: '若 a−b=3，ab=2，则 a²+b² 的值为（　）', options: ['5', '9', '13', '11'], answer: 2, analysis: 'a²+b²=(a−b)²+2ab=9+4=13。', knowledge_tags: ['k2'], confidence: 0.96 },
  { stem: '已知 AB=AC，∠A=60°，则△ABC 是（　）', options: ['直角三角形', '等边三角形', '等腰直角三角形', '钝角三角形'], answer: 1, analysis: '有一个角60°的等腰三角形是等边三角形。', knowledge_tags: ['k1', 'k7'], confidence: 0.91 },
  { stem: '函数 y=−3x+4 的图象经过（　）', options: ['一、二、四象限', '一、三象限', '二、四象限', '一、二、三象限'], answer: 0, analysis: 'k<0,b>0，经过一、二、四象限。', knowledge_tags: ['k5'], confidence: 0.88 },
  { stem: '切线与过切点的半径的位置关系是（　）', options: ['平行', '垂直', '相交', '重合'], answer: 1, analysis: '圆的切线垂直于过切点的半径。', knowledge_tags: ['k6'], confidence: 0.93 }
]

exports.main = async (event) => {
  const { action, studentId, fileID, fileName, subject, paperId } = event
  if (!studentId) return { code: -1, message: '缺少 studentId' }
  const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
  const db = app.rdb()

  try {
    // ============ 动作二：确认入库 ============
    if (action === 'confirm') {
      if (!paperId) return { code: -1, message: '缺少 paperId' }
      const pending = await db.from('zx_questions')
        .select('*').eq('student_id', studentId).eq('paper_id', paperId).limit(500)
      const rows = pending.data || []
      for (const q of rows) {
        await db.from('zx_questions').update({
          confirmed: true, need_confirm: false
        }).eq('id', q.id)
      }
      await db.from('zx_papers').update({
        confirm_status: 'confirmed', question_count: rows.length
      }).eq('id', paperId).eq('student_id', studentId)
      return { code: 0, count: rows.length }
    }

    // ============ 动作一：识别并写库（pending） ============
    // TODO(生产): 1) 云下载 fileID -> 图片；2) OCR 得到文本；3) AI 拆题+打标签。
    // 参考：小程序端 wx.cloud.extend.AI.createModel('hunyuan-exp')；
    //      云函数端用 @cloudbase/node-sdk 或 HTTP 调用大模型 API。
    const pid = genId('p')
    const questions = SAMPLE.map((q, i) => Object.assign({}, q, {
      id: genId('q'),
      tags: q.knowledge_tags
    }))

    await db.from('zx_papers').insert({
      id: pid, student_id: studentId,
      title: fileName || 'AI识别·云试卷', subject: subject || '数学',
      grade: '九年级', source: 'ai', file_id: fileID || null,
      question_count: questions.length, ocr_status: 'done', confirm_status: 'draft',
      created_at: new Date().toISOString()
    })
    for (const q of questions) {
      await db.from('zx_questions').insert({
        id: q.id, paper_id: pid, student_id: studentId,
        subject: subject || '数学', q_type: 'single', stem: q.stem,
        options: JSON.stringify(q.options), answer: JSON.stringify(q.answer),
        analysis: q.analysis, knowledge_tags: JSON.stringify(q.knowledge_tags),
        confidence: q.confidence, need_confirm: true, confirmed: false,
        created_at: new Date().toISOString()
      })
    }

    return {
      code: 0, paperId: pid, subject: subject || '数学', questions,
      note: 'Demo 返回预置样题并已写入 PG（待人工校对）；生产请替换为 OCR + AI 拆题。'
    }
  } catch (e) {
    return { code: -1, message: e && e.message }
  }
}
