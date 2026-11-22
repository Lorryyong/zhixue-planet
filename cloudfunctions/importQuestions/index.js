/**
 * 云函数 importQuestions —— 管理员题库批量导入（JSON / CSV）
 *
 * 用途：不用 AI，直接把题目 JSON/CSV 灌入公共题库 zx_questions(student_id=demo_student)。
 * 新用户首次登录会自动克隆这些已确认题，因此导入一次即对所有新用户生效。
 *
 * 身份与安全：
 *   - 只认微信云调用注入的 openid（getWXContext().OPENID / WX_OPENID）。
 *   - 管理员白名单两处并集：环境变量 ADMIN_OPENIDS（逗号分隔）+ 数据库表 zx_admins。
 *   - 自举：两处都为空时，首个调用 whoami 的人自动成为管理员（便于零配置启动）；
 *     一旦 zx_admins 有记录或配了环境变量，自举即关闭。
 *   - HTTP 网关 / CLI / 外部调用拿不到 openid，一律 -401 拒绝。
 *
 * 动作（入参 action）：
 *   - whoami  : 返回当前 openid 与是否管理员；非管理员给出加入白名单指引
 *   - preview : 只校验不写入，返回有效/无效统计、错误明细、样例
 *   - commit  : 校验后 upsert 入库，返回 inserted/updated/failed 明细
 *
 * 入参：{ action, text, format:'json'|'csv', subject?, syncToExisting? }
 */
const cloudbase = require('@cloudbase/js-sdk')
const crypto = require('crypto')
const qt = require('./questionTypes.js')

/** HTTP 网关适配（保留兼容；网关调用无 openid，会在身份处被拒） */
function parseEvent(event) {
  if (!event || !event.body) return event || {}
  let raw = event.body
  if (event.isBase64Encoded) {
    try { raw = Buffer.from(raw, 'base64').toString('utf8') } catch (e) { /* 保持原样 */ }
  }
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch (e) { return {} }
  }
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
  } catch (e) { /* 非微信云调用环境 */ }
  return process.env.WX_OPENID || ''
}

function adminEnvList() {
  return String(process.env.ADMIN_OPENIDS || '')
    .split(/[,，\s]+/).map(function (s) { return s.trim() }).filter(Boolean)
}
function inAdminList(openid, envList, dbRows) {
  if (envList.indexOf(openid) >= 0) return true
  return (dbRows || []).some(function (r) { return r.openid === openid })
}

/** 解析 CSV 单行，支持双引号包裹与 "" 转义 */
function splitCsvLine(line) {
  const out = []
  let cur = '', quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++ }
      else quoted = !quoted
    } else if ((c === ',' || c === '，') && !quoted) {
      out.push(cur); cur = ''
    } else {
      cur += c
    }
  }
  out.push(cur)
  return out.map(function (s) { return String(s).trim() })
}
function splitArr(v) {
  if (Array.isArray(v)) return v.map(String)
  if (v == null) return []
  return String(v).split(/[|｜]/).map(function (s) { return s.trim() }).filter(Boolean)
}

/** 把输入文本解析成原始题目数组（不校验） */
function parseQuestions(text, format) {
  const s = String(text || '').trim()
  if (!s) throw new Error('内容为空，请先粘贴题目数据')
  const looksJson = s.charAt(0) === '[' || s.charAt(0) === '{'
  if (format !== 'csv' && looksJson) {
    let obj
    try { obj = JSON.parse(s) } catch (e) { throw new Error('JSON 解析失败：' + e.message) }
    const arr = Array.isArray(obj) ? obj : obj.questions
    if (!Array.isArray(arr)) throw new Error('JSON 需为数组，或含 questions 数组的对象')
    return arr
  }
  // CSV：首行为列头
  const lines = s.split(/\r?\n/).filter(function (l) { return l.trim() })
  if (lines.length < 2) throw new Error('CSV 至少需要表头 + 一行数据')
  const header = splitCsvLine(lines[0]).map(function (h) { return h.toLowerCase() })
  const col = function (name) { const i = header.indexOf(name); return i >= 0 ? i : -1 }
  const cStem = col('stem') >= 0 ? col('stem') : 0
  const cOpt = col('options'), cAns = col('answer'), cAna = col('analysis')
  const cTag = col('knowledge_tags') >= 0 ? col('knowledge_tags') : col('tags')
  const cSub = col('subject'), cId = col('id'), cDif = col('difficulty')
  const cType = col('q_type') >= 0 ? col('q_type') : col('type')
  const cScore = col('score')
  const cSp = col('scoring_points')
  return lines.slice(1).map(function (line) {
    const cells = splitCsvLine(line)
    // 评分要点：形如 "求交点:5|写顶点:5"
    let scoring_points = []
    if (cSp >= 0 && cells[cSp]) {
      scoring_points = splitArr(cells[cSp]).map(function (p) {
        const parts = p.split(/[:：]/)
        return { point: (parts[0] || '').trim(), score: Number(parts[1]) || 0 }
      }).filter(function (p) { return p.point })
    }
    return {
      id: cId >= 0 ? cells[cId] : '',
      q_type: cType >= 0 ? cells[cType] : '',
      stem: cells[cStem] || '',
      options: cOpt >= 0 ? splitArr(cells[cOpt]) : [],
      answer: cAns >= 0 ? cells[cAns] : 0,
      analysis: cAna >= 0 ? cells[cAna] : '',
      knowledge_tags: cTag >= 0 ? splitArr(cells[cTag]) : [],
      subject: cSub >= 0 ? cells[cSub] : '',
      difficulty: cDif >= 0 ? cells[cDif] : 3,
      score: cScore >= 0 ? cells[cScore] : undefined,
      scoring_points: scoring_points
    }
  })
}

/** 归一化并校验单条；返回 {q} 或 {error}（全题型） */
function normalizeOne(raw, defaultSubject) {
  const stem = String((raw && raw.stem) || '').trim().slice(0, 500)
  if (!stem) return { error: '题干为空' }

  // 题型：支持中考叫法别名，缺省按选项推断
  let type = qt.normalizeType(raw.q_type || raw.type || '')
  if (!raw.q_type && !raw.type) {
    const optCount = (Array.isArray(raw.options) ? raw.options : splitArr(raw.options)).filter(Boolean).length
    if (optCount >= 2) type = 'single'
    else type = 'blank'
  }
  const m = qt.meta(type)

  let options = Array.isArray(raw.options) ? raw.options.slice(0, 6).map(String) : splitArr(raw.options)
  options = options.map(function (o) { return String(o).trim() }).filter(Boolean)

  let answer
  if (m.answerKind === 'index') {
    if (options.length < 2) return { error: '【' + m.label + '】选项少于 2 个' }
    const n = Number(raw.answer)
    if (!Number.isInteger(n) || n < 0 || n >= options.length) {
      return { error: '【' + m.label + '】答案下标应为 0–' + (options.length - 1) + ' 的整数（0=A…）' }
    }
    answer = n
  } else if (m.answerKind === 'indexArray') {
    if (options.length < 2) return { error: '【' + m.label + '】选项少于 2 个' }
    const arr = (Array.isArray(raw.answer) ? raw.answer : splitArr(raw.answer)).map(Number)
    if (!arr.length || arr.some(function (n) { return !Number.isInteger(n) || n < 0 || n >= options.length })) {
      return { error: '【' + m.label + '】答案应为合法下标数组，如 0|2（0=A…）' }
    }
    answer = arr
  } else if (m.answerKind === 'textArray') {
    const arr = (Array.isArray(raw.answer) ? raw.answer : splitArr(raw.answer))
      .map(function (x) { return String(x == null ? '' : x).trim() }).filter(Boolean)
    if (!arr.length) return { error: '【' + m.label + '】答案不能为空（多空用 | 分隔）' }
    answer = arr
  } else {
    // 主观题：参考答案文本
    answer = String(raw.answer == null ? '' : raw.answer).trim().slice(0, 2000)
    if (!answer) return { error: '【' + m.label + '】参考答案不能为空' }
  }

  // 评分要点（主观题）
  let scoring_points = []
  const spRaw = raw.scoring_points
  if (Array.isArray(spRaw)) {
    scoring_points = spRaw.slice(0, 8).map(function (p) {
      return { point: String((p && (p.point || p.text)) || '').slice(0, 80), score: Number((p && p.score) || 0) }
    }).filter(function (p) { return p.point })
  }

  const rawTags = Array.isArray(raw.knowledge_tags) ? raw.knowledge_tags : (raw.tags || [])
  const tags = (Array.isArray(rawTags) ? rawTags : splitArr(rawTags))
    .slice(0, 5).map(String).filter(Boolean)

  const dif = Number(raw.difficulty)
  const conf = Number(raw.confidence)
  const scoreNum = Number(raw.score)

  return {
    q: {
      id: String(raw.id || '').trim() || ('q_' + crypto.randomBytes(6).toString('hex')),
      stem: stem,
      q_type: type,
      options: (m.hasOptions ? options : []),
      answer: answer,
      scoring_points: scoring_points,
      score: (Number.isFinite(scoreNum) && scoreNum > 0) ? scoreNum : (m.family === 'subjective' ? 10 : 2),
      analysis: String(raw.analysis || '').trim().slice(0, 800),
      knowledge_tags: tags,
      subject: String(raw.subject || defaultSubject || '数学').trim() || '数学',
      difficulty: (Number.isFinite(dif) && dif > 0) ? dif : 3,
      confidence: (Number.isFinite(conf) && conf > 0) ? conf : 1,
      confirmed: true,
      need_confirm: false
    }
  }
}

/** 写库前的字段序列化（与 recognize 保持一致） */
function toRow(q) {
  return {
    id: q.id,
    student_id: 'demo_student',
    subject: q.subject,
    q_type: q.q_type,
    stem: q.stem,
    options: JSON.stringify(q.options || []),
    answer: JSON.stringify(q.answer),
    scoring_points: JSON.stringify(q.scoring_points || []),
    score: q.score,
    analysis: q.analysis,
    knowledge_tags: JSON.stringify(q.knowledge_tags),
    difficulty: q.difficulty,
    confidence: q.confidence,
    confirmed: true,
    need_confirm: false,
    created_at: new Date().toISOString()
  }
}

exports.main = async (event) => {
  const p = parseEvent(event)

  // 1) 身份：只认微信注入的 openid
  const openid = getCallerOpenId()
  if (!openid) {
    return respond(event, {
      code: -401,
      message: '无法验证微信身份：请通过小程序 wx.cloud.callFunction 调用；HTTP/CLI/外部请求不受理',
      needWxCall: true
    })
  }

  const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
  const db = app.rdb()
  const envList = adminEnvList()

  let adminRows = []
  try {
    const r = await db.from('zx_admins').select('openid').limit(500)
    adminRows = r.data || []
  } catch (e) { /* 表未建时按环境变量判定 */ }

  try {
    // 2) whoami：查身份，必要时自举
    if (p.action === 'whoami') {
      let isAdmin = inAdminList(openid, envList, adminRows)
      let bootstrapped = false
      if (!isAdmin && !envList.length && !adminRows.length) {
        try {
          await db.from('zx_admins').insert({
            openid: openid, note: '首个调用者自举管理员', created_at: new Date().toISOString()
          })
          bootstrapped = true
          isAdmin = true
        } catch (e) { /* 并发自举冲突：忽略，下一轮重新判定 */ }
      }
      return respond(event, {
        code: 0, openid: openid, isAdmin: isAdmin, bootstrapped: bootstrapped,
        envAdminCount: envList.length, dbAdminCount: adminRows.length,
        hint: isAdmin
          ? '你是管理员，可以导入题目。'
          : '非管理员：把你的 openid 加到云函数环境变量 ADMIN_OPENIDS（逗号分隔），或让管理员在 zx_admins 表插入一条记录。'
      })
    }

    // 3) 管理员校验（preview / commit 都要）
    if (!inAdminList(openid, envList, adminRows)) {
      return respond(event, {
        code: -403,
        message: '非管理员，无导入权限。你的 openid：' + openid + '（发给管理员加入白名单）'
      })
    }

    // 4) 解析 + 校验
    const raws = parseQuestions(p.text, p.format)
    const defaultSubject = p.subject || '数学'
    const normalized = raws.map(function (raw, i) {
      const r = normalizeOne(raw, defaultSubject)
      return r.q
        ? { index: i + 1, q: r.q }
        : { index: i + 1, error: r.error, stem: String((raw && raw.stem) || '').slice(0, 40) }
    })
    const valid = normalized.filter(function (x) { return x.q })
    const invalid = normalized.filter(function (x) { return x.error })

    // 5) preview：只返回校验结果
    if (p.action !== 'commit') {
      return respond(event, {
        code: 0, action: 'preview',
        total: normalized.length, valid: valid.length, invalid: invalid.length,
        invalidDetails: invalid.slice(0, 30),
        sample: valid.slice(0, 3).map(function (x) { return x.q }),
        hint: '预览模式未写入。确认无误后点「确认导入」。'
      })
    }

    // 6) commit：逐条 upsert（按 id 判重）
    let inserted = 0, updated = 0, failed = 0
    const errors = []
    const importedIds = []
    for (let i = 0; i < valid.length; i++) {
      const q = valid[i].q
      const row = toRow(q)
      try {
        const exist = await db.from('zx_questions').select('id').eq('id', q.id).limit(1)
        if (exist.data && exist.data.length) {
          delete row.id
          delete row.student_id
          delete row.created_at
          await db.from('zx_questions').update(row).eq('id', q.id)
          updated++
        } else {
          await db.from('zx_questions').insert(row)
          inserted++
        }
        importedIds.push(q.id)
      } catch (e) {
        failed++
        if (errors.length < 30) errors.push({ index: valid[i].index, id: q.id, message: e && e.message })
      }
    }

    // 7) 可选：同步给已有用户（跳过已有同题干的题，避免重复）
    let syncedUsers = 0, syncedRows = 0
    if (p.syncToExisting && importedIds.length) {
      try {
        const users = await db.from('zx_users').select('openid').limit(500)
        const newRows = valid.filter(function (x) { return importedIds.indexOf(x.q.id) >= 0 }).map(function (x) {
          const row = toRow(x.q)
          row.id = 'q_' + crypto.randomBytes(6).toString('hex')
          return row
        })
        for (const u of (users.data || [])) {
          const sid = u.openid
          if (!sid || sid === 'demo_student') continue
          const ownStems = await db.from('zx_questions').select('stem').eq('student_id', sid).limit(500)
          const stems = new Set((ownStems.data || []).map(function (r) { return r.stem }))
          let n = 0
          for (const row of newRows) {
            if (stems.has(row.stem)) continue
            try {
              await db.from('zx_questions').insert(Object.assign({}, row, {
                student_id: sid, id: 'q_' + crypto.randomBytes(6).toString('hex'),
                created_at: new Date().toISOString()
              }))
              n++
            } catch (e) { /* 单行失败忽略 */ }
          }
          if (n) { syncedUsers++; syncedRows += n }
        }
      } catch (e) { /* 同步失败不影响主导入结果 */ }
    }

    return respond(event, {
      code: 0, action: 'commit',
      total: normalized.length, invalid: invalid.length,
      inserted: inserted, updated: updated, failed: failed,
      errors: errors, invalidDetails: invalid.slice(0, 30),
      syncedUsers: syncedUsers, syncedRows: syncedRows,
      hint: '已写入公共题库 demo_student。新用户首次登录自动获得；已有用户如需同步请勾选「同步给已有用户」重新导入。'
    })
  } catch (e) {
    return respond(event, { code: -1, message: e && e.message })
  }
}
