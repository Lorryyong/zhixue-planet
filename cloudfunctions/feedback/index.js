/**
 * 云函数 feedback —— 题目错误反馈（v1.9.9）
 *
 * 学生打卡时发现题目有误 → 提交反馈（category=题分类错误 / stem=题目错误 / answer=答案错误），
 * 携带题目快照；管理员在「我的 → 题库管理 → 用户反馈错题清单」处理：
 *   - fix    ：修正题目字段（白名单），反馈标记 fixed
 *   - delete ：从题库删除该题（含跨用户副本）+ 清理错题/掌握度关联，反馈标记 deleted
 *   - ignore ：忽略，反馈标记 ignored
 * 处理过的反馈 status != 'pending'，自动从待处理清单移除。
 *
 * 身份：只认微信云调用注入的 openid（前端无法伪造）。
 * 管理员：ADMIN_OPENIDS 环境变量 ∪ zx_admins 表（与 importQuestions 一致）。
 *
 * 动作（入参 action）：
 *   - submit ：{ questionId, feedbackType, snapshot }   —— 任意已登录用户
 *   - list   ：列出待处理反馈（管理员）
 *   - handle ：{ id, handleAction:'fix'|'delete'|'ignore', patch? }（管理员）
 */
const cloudbase = require('@cloudbase/js-sdk')
const qt = require('./questionTypes.js')

function parseEvent(event) {
  if (!event || !event.body) return event || {}
  let raw = event.body
  if (event.isBase64Encoded) { try { raw = Buffer.from(raw, 'base64').toString('utf8') } catch (e) {} }
  if (typeof raw === 'string') { try { return JSON.parse(raw) } catch (e) { return {} } }
  return raw || {}
}
function respond(event, result) {
  if (event && event.httpMethod) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      isBase64Encoded: false,
      body: JSON.stringify(result)
    }
  }
  return result
}
function getCallerOpenId() {
  try {
    const wx = require('wx-server-sdk')
    wx.init({ env: wx.DYNAMIC_CURRENT_ENV })
    const ctx = wx.getWXContext() || {}
    if (ctx.OPENID) return ctx.OPENID
  } catch (e) {}
  return process.env.WX_OPENID || ''
}
function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}
function adminEnvList() {
  return String(process.env.ADMIN_OPENIDS || '')
    .split(/[,，\s]+/).map(s => s.trim()).filter(Boolean)
}
async function isAdmin(openid, db) {
  if (adminEnvList().indexOf(openid) >= 0) return true
  try {
    const r = await db.from('zx_admins').select('openid').eq('openid', openid).limit(1)
    return !!(r.data && r.data.length)
  } catch (e) { return false }
}
const VALID_TYPES = ['category', 'stem', 'answer']

/** 题目 patch 白名单（与 recognize.updateQuestion 同口径），用于管理员 fix */
function safePatch(patch) {
  const safe = {}
  if (!patch || typeof patch !== 'object') return safe
  if (typeof patch.stem === 'string') safe.stem = patch.stem.slice(0, 500)
  if (typeof patch.q_type === 'string') safe.q_type = qt.normalizeType(patch.q_type)
  if (Array.isArray(patch.options)) safe.options = JSON.stringify(patch.options.slice(0, 6).map(String))
  if (Number.isInteger(patch.answer)) safe.answer = JSON.stringify(patch.answer)
  else if (Array.isArray(patch.answer)) safe.answer = JSON.stringify(patch.answer.slice(0, 10))
  else if (typeof patch.answer === 'string') safe.answer = JSON.stringify(patch.answer.slice(0, 2000))
  if (Array.isArray(patch.scoring_points)) {
    safe.scoring_points = JSON.stringify(patch.scoring_points.slice(0, 8).map(p => ({
      point: String((p && (p.point || p.text)) || '').slice(0, 80),
      score: Number((p && p.score) || 0)
    })))
  }
  if (Number.isFinite(Number(patch.score)) && Number(patch.score) > 0) safe.score = Number(patch.score)
  if (typeof patch.analysis === 'string') safe.analysis = patch.analysis.slice(0, 800)
  if (typeof patch.original === 'string') safe.original = patch.original.slice(0, 200)
  if (typeof patch.subject === 'string') safe.subject = patch.subject.slice(0, 20)
  if (typeof patch.grade === 'string') safe.grade = patch.grade.slice(0, 20)
  if (typeof patch.region === 'string') safe.region = patch.region.slice(0, 40)
  if (patch.year !== undefined && patch.year !== null) {
    const y = Number(patch.year)
    safe.year = (Number.isInteger(y) && y >= 1990 && y <= 2100) ? y : 0
  }
  if (Array.isArray(patch.knowledge_tags)) safe.knowledge_tags = JSON.stringify(patch.knowledge_tags.slice(0, 8).map(String))
  if (Array.isArray(patch.knowledge_points)) {
    safe.knowledge_points = JSON.stringify(patch.knowledge_points.slice(0, 8).map(function (k) {
      return { name: String((k && k.name) || '').slice(0, 40), book: String((k && k.book) || '').slice(0, 30), inferred: !!k.inferred }
    }).filter(k => !!k.name))
  }
  return safe
}

exports.main = async (event) => {
  const p = parseEvent(event)
  const openid = getCallerOpenId()
  if (!openid) return respond(event, { code: -401, message: '无法验证微信身份，请通过 wx.cloud.callFunction 调用', needWxCall: true })
  const action = p.action || 'list'
  const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
  const db = app.rdb()
  const nowIso = new Date().toISOString()

  try {
    // ===== 学生：提交反馈 =====
    if (action === 'submit') {
      const questionId = String(p.questionId || '').slice(0, 80)
      const feedbackType = String(p.feedbackType || '')
      if (!questionId) return respond(event, { code: -1, message: '缺少题号' })
      if (VALID_TYPES.indexOf(feedbackType) < 0) return respond(event, { code: -1, message: '反馈类型不合法' })
      const snapshot = (p.snapshot && typeof p.snapshot === 'object') ? p.snapshot : {}
      // 幂等：同人同题同类型已有 pending 时不重复插入
      const dup = await db.from('zx_question_feedback')
        .select('id').eq('question_id', questionId).eq('student_id', openid)
        .eq('feedback_type', feedbackType).eq('status', 'pending').limit(1)
      if (dup.data && dup.data.length) {
        return respond(event, { code: 0, duplicated: true, message: '已反馈过该题，感谢你的提醒' })
      }
      const row = {
        id: genId('fb'), question_id: questionId, student_id: openid,
        feedback_type: feedbackType,
        q_snapshot: JSON.stringify(snapshot),
        status: 'pending', handle_note: '', created_at: nowIso, handled_at: null
      }
      await db.from('zx_question_feedback').insert(row)
      return respond(event, { code: 0, id: row.id, message: '已反馈，感谢你帮我们改进题库' })
    }

    // ===== 管理员校验 =====
    if (!(await isAdmin(openid, db))) {
      return respond(event, { code: -403, message: '非管理员，无权访问反馈清单' })
    }

    // ===== 管理员：列出待处理反馈 =====
    if (action === 'list') {
      const status = String(p.status || 'pending')
      const r = await db.from('zx_question_feedback')
        .select('*').eq('status', status).limit(300)
      // 排序放在 JS 端，避免依赖 rdb.order API（新版按时间倒序）
      const sorted = (r.data || []).slice().sort(function (a, b) {
        return String(b.created_at || '').localeCompare(String(a.created_at || ''))
      })
      const rows = sorted.map(function (f) {
        let snap = {}
        try { snap = typeof f.q_snapshot === 'string' ? JSON.parse(f.q_snapshot) : (f.q_snapshot || {}) } catch (e) {}
        return {
          id: f.id, questionId: f.question_id, studentId: f.student_id,
          feedbackType: f.feedback_type,
          snapshot: snap,
          status: f.status, handleNote: f.handle_note || '',
          createdAt: f.created_at, handledAt: f.handled_at
        }
      })
      return respond(event, { code: 0, list: rows, total: rows.length })
    }

    // ===== 管理员：处理反馈 =====
    if (action === 'handle') {
      const id = String(p.id || '').slice(0, 80)
      const handleAction = String(p.handleAction || '')
      if (!id) return respond(event, { code: -1, message: '缺少反馈记录 id' })
      const fr = await db.from('zx_question_feedback').select('*').eq('id', id).limit(1)
      if (!(fr.data && fr.data.length)) return respond(event, { code: -404, message: '反馈记录不存在' })
      const fb = fr.data[0]
      if (fb.status !== 'pending') return respond(event, { code: -1, message: '该反馈已处理' })
      let snap = {}
      try { snap = typeof fb.q_snapshot === 'string' ? JSON.parse(fb.q_snapshot) : (fb.q_snapshot || {}) } catch (e) {}
      const questionId = fb.question_id
      const note = String(p.note || '').slice(0, 200)
      let newStatus = 'ignored'
      let fixedFields = []

      if (handleAction === 'fix') {
        // 修正题目：白名单字段更新（按 question_id，覆盖该公共题的所有用户副本）
        const patch = safePatch(p.patch)
        if (!Object.keys(patch).length) return respond(event, { code: -1, message: '没有可修正的字段' })
        try {
          await db.from('zx_questions').update(patch).eq('id', questionId)
        } catch (e) {
          return respond(event, { code: -1, message: '修正题目失败：' + (e && e.message || e) })
        }
        newStatus = 'fixed'
        fixedFields = Object.keys(patch)
      } else if (handleAction === 'delete') {
        // 删除题目：zx_questions（可能是公共题，跨用户副本一并删除）+ 清理错题/掌握度关联
        try {
          await db.from('zx_questions').delete().eq('id', questionId)
        } catch (e) { return respond(event, { code: -1, message: '删除题目失败：' + (e && e.message || e) }) }
        try { await db.from('zx_wrongbook').delete().eq('question_id', questionId) } catch (e) {}
        newStatus = 'deleted'
      } else if (handleAction === 'ignore') {
        newStatus = 'ignored'
      } else {
        return respond(event, { code: -1, message: '未知处理动作：' + handleAction })
      }

      await db.from('zx_question_feedback').update({
        status: newStatus, handle_note: note, handled_at: nowIso
      }).eq('id', id)
      return respond(event, {
        code: 0, id, status: newStatus, fixedFields, questionId,
        message: handleAction === 'fix' ? '已修正题目' : (handleAction === 'delete' ? '已删除题目' : '已忽略该反馈')
      })
    }

    return respond(event, { code: -9, message: '未知动作：' + action })
  } catch (e) {
    return respond(event, { code: -1, message: (e && e.message) || String(e) })
  }
}
