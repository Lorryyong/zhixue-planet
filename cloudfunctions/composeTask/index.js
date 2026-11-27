/**
 * 云函数 composeTask —— 按掌握度智能组卷（PostgreSQL 版）
 *
 * 使用 @cloudbase/js-sdk v3 的 app.rdb() 访问 PG。
 * 算法（艾宾浩斯版）：每天固定 10 题 = 到期错题优先(最多5道) + 已启用题库按序补齐；
 *   科目宽松匹配(兼容 英语/English/初中英语/带空格)；当天任务题数不足10时自动重新组卷覆盖，
 *   修复早期只组到 1 题的历史任务；返回 composition/note 便于前端展示诊断信息。
 *
 * 返回（关键）：除了 task，还返回题目详情 questions[]，前端直接用云端题目渲染，
 * 不再依赖本地题库（本地 Storage 仅作为展示缓存 / 降级兜底）。
 *
 * 分科目：入参 subject（'综合'=全部科目混出，或具体科目如'数学'/'英语'）。
 *   题目池按科目过滤；薄弱点/强项只取该科目题目标签；错题只取该科目的。
 *   每天每科各一个独立任务：按 (student_id, task_date, subject) 唯一。
 *   各科互不干扰：当天本科目已有任务即复用（继续答/已完成），其它科目不受影响，
 *   可一天内分别为多个科目打卡。
 *
 * 入参：{ studentId(忽略，身份来自云端), subject? }
 * 出参：{ code:0, task(含 subject), questions:[{id, q_type, stem, options, answer, scoring_points, score, analysis, tags, subject, confidence}] }
 *   全题型透传：q_type 决定前端控件与判分方式；主观题带 scoring_points/score 供 AI 判分。
 */
const cloudbase = require('@cloudbase/js-sdk')

/** 取微信云调用注入的真实身份 openid（唯一可信来源）；取不到返回 '' */
function getCallerOpenId() {
  try {
    const wx = require('wx-server-sdk')
    wx.init({ env: wx.DYNAMIC_CURRENT_ENV })
    const ctx = wx.getWXContext() || {}
    if (ctx.OPENID) return ctx.OPENID
  } catch (e) { /* 非微信云调用环境 */ }
  return process.env.WX_OPENID || ''
}

/**
 * HTTP 网关适配：HTTP 触发时业务参数在 event.body（字符串，可能 base64），
 * wx.cloud 直传时参数直接在 event 上。这里统一解析，让业务逻辑无需关心入口。
 */
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
// 出口：HTTP 触发返回集成响应；wx.cloud 直传返回原对象
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

/** 北京时间（UTC+8）的 YYYY-MM-DD；云函数运行在 UTC，直接用 toISOString 会把凌晨算成前一天 */
function beijingDate(base) {
  const ms = (base ? new Date(base).getTime() : Date.now()) + 8 * 3600 * 1000
  return new Date(ms).toISOString().slice(0, 10)
}
function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}
function parseArr(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') { try { return JSON.parse(v) } catch (e) { return [] } }
  return []
}
function parseComp(v) {
  if (v && typeof v === 'object') return v
  if (typeof v === 'string') { try { const o = JSON.parse(v); return (o && typeof o === 'object') ? o : {} } catch (e) { return {} } }
  return {}
}
// 试卷来源筛选（与 recognize listSources 的口径一致，供缓存命中时本地过滤）
function filterSources(sources, f) {
  return (sources || []).filter(function (s) {
    if (f.subject && s.subject !== f.subject) return false
    if (f.region && s.region !== f.region) return false
    if (f.grade && s.grade !== f.grade) return false
    if (f.scope && s.scope !== f.scope) return false
    if (f.brushed === 'yes' && !s.brushed) return false
    if (f.brushed === 'no' && s.brushed) return false
    if (f.brushed === 'part' && s.brushState !== 'part') return false
    if (f.brushed === 'done' && s.brushState !== 'done') return false
    return true
  })
}
// 把 PG 的一行题目归一化为前端可直接渲染/判题的结构
// 全题型：透传 q_type / 选项 / 答案(可为下标、下标数组或文本) / 评分要点 / 分值
function normalizeQuestion(q) {
  const qt = require('./questionTypes.js')
  const type = qt.normalizeType(q.q_type)
  const opts = parseArr(q.options)
  const ans = qt.asValue(q.answer) // 单选=数字, 多选=数组, 填空=字符串/数组, 主观题=参考答案文本
  return {
    id: q.id,
    q_type: type,
    stem: q.stem || '',
    stem_images: parseArr(q.stem_images),
    options: opts,
    answer: ans,
    scoring_points: qt.asValue(q.scoring_points) || [], // 主观题评分要点 [{point,score}]
    score: Number(q.score) || (qt.isSubjective(type) ? 10 : 2),
    analysis: q.analysis || '',
    tags: parseArr(q.knowledge_tags),
    knowledge_points: parseArr(q.knowledge_points),
    subject: q.subject || '',
    // 元数据（打卡页小字展示用）：来源/年份/年级/省市
    original: q.original || '',
    year: Number(q.year) || 0,
    grade: q.grade || '',
    region: q.region || '',
    confidence: Number(q.confidence) || 1
  }
}

exports.main = async (event) => {
  const p = parseEvent(event)
  // 【安全】身份只认微信云调用注入的 openid，忽略前端传入的 studentId
  const studentId = getCallerOpenId()
  if (!studentId) return respond(event, { code: -401, message: '无法验证微信身份，请通过 wx.cloud.callFunction 调用', needWxCall: true })
  const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
  const db = app.rdb()
  // 补签：若前端指定了补签日（今天之前的日期），任务归属到该日并标记 is_makeup，
  // 该日任务全部答完后由 submitAnswer 真正补签（扣卡 + 写 checkin_dates）。
  let isMakeup = false
  let makeupDate = ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(p.makeupDate || ''))) {
    const req = String(p.makeupDate)
    const tms = new Date(beijingDate() + 'T00:00:00Z').getTime()
    const rms = new Date(req + 'T00:00:00Z').getTime()
    const diff = Math.round((tms - rms) / 86400000)
    if (diff >= 1 && diff <= 6) { isMakeup = true; makeupDate = req }
  }
  const today = isMakeup ? makeupDate : beijingDate()
  const wantSubject = p.subject && p.subject !== '综合' ? String(p.subject).slice(0, 20) : ''
  const taskSubject = wantSubject || '综合' // 本任务归属科目（'综合'=混科）

  // ===== 试卷列表（来源聚合）：聚合结果带缓存，避免每次打开试卷页都全量扫题目+答题记录 =====
  // 缓存存 zx_users.sources_cache（{at, sources, filterOptions}），30 分钟兜底过期；
  // 题目导入/确认/删除/启停（recognize 各动作）与完成打卡（submitAnswer）会主动清缓存。
  if (p.action === 'sources') {
    const qmeta = require('./questionMeta.js')
    const filters = (p.filters && typeof p.filters === 'object') ? p.filters : null
    const doInit = p.doInit === true
    try {
      // 1) 缓存命中直接返回（doInit 首次初始化必须走全量计算路径）
      if (!doInit) {
        const cu = await db.from('zx_users').select('sources_cache').eq('openid', studentId).limit(1)
        const crow = cu.data && cu.data[0]
        const cache = parseComp(crow && crow.sources_cache)
        if (cache && Array.isArray(cache.sources) && cache.at && (Date.now() - Number(cache.at) < 30 * 60 * 1000)) {
          let sources = cache.sources.slice()
          if (filters) sources = filterSources(sources, filters)
          return respond(event, {
            code: 0, sources, total: sources.length, initInfo: null,
            filterOptions: cache.filterOptions || { subjects: [], regions: [], grades: [], scopes: [] },
            cached: true
          })
        }
      }
      // 2) 全量计算：拉本人已确认题目（轻字段）+ 全部答题记录 id 做聚合
      const qr = await db.from('zx_questions')
        .select('id,subject,original,enabled,year,grade,region,scope,textbook')
        .eq('student_id', studentId).eq('confirmed', true).limit(2000)
      const rows = qr.data || []
      // 旧数据回填：维度为空但可从 original 解析的，幂等写回
      const backfill = []
      rows.forEach(function (q) {
        const needYear = !Number(q.year)
        const needGrade = !q.grade
        const needRegion = !q.region
        if ((needYear || needGrade || needRegion) && q.original) {
          const meta = qmeta.inferMeta(q.original, { year: q.year, grade: q.grade, region: q.region })
          if ((needYear && meta.year) || (needGrade && meta.grade) || (needRegion && meta.region)) {
            if (needYear && meta.year) q.year = meta.year
            if (needGrade && meta.grade) q.grade = meta.grade
            if (needRegion && meta.region) q.region = meta.region
            backfill.push({ id: q.id, year: meta.year, grade: meta.grade, region: meta.region })
          }
        }
      })
      if (backfill.length) {
        await Promise.all(backfill.map(function (b) {
          const patch = {}
          if (b.year) patch.year = b.year
          if (b.grade) patch.grade = b.grade
          if (b.region) patch.region = b.region
          return db.from('zx_questions').update(patch).eq('id', b.id).eq('student_id', studentId).catch(function () {})
        }))
      }
      let answeredIds = new Set()
      try {
        const ar = await db.from('zx_answer_record').select('question_id')
          .eq('student_id', studentId).limit(5000)
        ;(ar.data || []).forEach(function (r) { if (r.question_id) answeredIds.add(r.question_id) })
      } catch (e) { /* 作答表读取失败不影响列表 */ }
      const map = {}
      rows.forEach(function (q) {
        const subj = q.subject || '其他'
        const orig = (q.original || '').trim() || '未标注来源'
        const scope = q.scope === 'system' ? 'system' : 'user'
        const key = subj + '\n' + orig + '\n' + scope
        if (!map[key]) {
          map[key] = {
            subject: subj, original: orig, scope: scope, count: 0, enabledCount: 0, brushedCount: 0,
            year: Number(q.year) || 0, grade: q.grade || '', region: q.region || '', textbook: q.textbook || ''
          }
        }
        const g = map[key]
        g.count++
        if (q.enabled !== false) g.enabledCount++
        if (answeredIds.has(q.id)) g.brushedCount++
        if (!g.year && Number(q.year)) g.year = Number(q.year)
        if (!g.grade && q.grade) g.grade = qmeta.normalizeGrade(q.grade)
        if (!g.region && q.region) g.region = q.region
        if (!g.textbook && q.textbook) g.textbook = q.textbook
      })
      let sources = Object.keys(map).map(function (key) {
        const g = map[key]
        const brushState = (g.count > 0 && g.brushedCount >= g.count) ? 'done'
          : (g.brushedCount > 0 ? 'part' : 'none')
        return {
          subject: g.subject, original: g.original, scope: g.scope, count: g.count,
          year: g.year, grade: g.grade, region: g.region, textbook: g.textbook || '',
          brushed: g.brushedCount > 0, brushedCount: g.brushedCount, brushState: brushState,
          enabled: g.enabledCount > 0
        }
      })
      sources.sort(function (a, b) {
        return (a.subject.localeCompare(b.subject, 'zh')) ||
          (a.original.localeCompare(b.original, 'zh')) ||
          (String(a.scope).localeCompare(String(b.scope)))
      })
      // 首次按学段自动启用（仅 doInit 时，逻辑与 recognize listSources 一致）
      let initInfo = null
      if (doInit) {
        try {
          const meRes = await db.from('zx_users').select('grade_index,grade_base_year,source_grade_init')
            .eq('openid', studentId).limit(1)
          const me = (meRes.data || [])[0] || {}
          const gi = Number(me.grade_index) || 0
          const by = Number(me.grade_base_year) || 0
          const nowD = new Date()
          const curSchoolYear = (nowD.getMonth() + 1 >= 9) ? nowD.getFullYear() : nowD.getFullYear() - 1
          let curIdx = (gi && by) ? (gi + (curSchoolYear - by)) : gi
          curIdx = Math.max(0, Math.min(13, curIdx))
          if (curIdx >= 1 && curIdx <= 12) {
            const userStage = qmeta.stageOf(qmeta.GRADES[curIdx - 1])
            const initializedStage = me.source_grade_init || ''
            if (initializedStage !== userStage) {
              sources.forEach(function (s) {
                const st = qmeta.stageOf(s.grade)
                s.enabled = (st === userStage || st === 'unknown')
              })
              for (const s of sources) {
                const origVal = s.original === '未标注来源' ? '' : s.original
                await db.from('zx_questions').update({ enabled: !!s.enabled })
                  .eq('student_id', studentId).eq('subject', s.subject).eq('original', origVal)
              }
              await db.from('zx_users').update({ source_grade_init: userStage }).eq('openid', studentId)
              initInfo = { initialized: true, gradeLabel: qmeta.GRADES[curIdx - 1], stage: userStage }
            } else {
              initInfo = { initialized: false, reason: '已按当前学段初始化过', stage: userStage }
            }
          } else {
            initInfo = { initialized: false, reason: '未设置年级或无匹配试卷' }
          }
        } catch (e) {
          initInfo = { initialized: false, reason: e && e.message }
        }
      }
      const filterOptions = {
        subjects: Array.from(new Set(sources.map(function (s) { return s.subject }))),
        regions: Array.from(new Set(sources.map(function (s) { return s.region }).filter(Boolean))),
        grades: Array.from(new Set(sources.map(function (s) { return s.grade }).filter(Boolean))),
        scopes: Array.from(new Set(sources.map(function (s) { return s.scope }).filter(Boolean)))
      }
      // 3) 写缓存（失败只告警：下次打开重算，不影响本次返回）
      try {
        const cw = await db.from('zx_users')
          .update({ sources_cache: { at: Date.now(), sources: sources, filterOptions: filterOptions } })
          .eq('openid', studentId)
        if (cw && cw.error) console.warn('[composeTask] sources 缓存写入失败：', cw.error.message || cw.error)
      } catch (e) { console.warn('[composeTask] sources 缓存写入异常：', e && e.message) }
      let outSources = sources
      if (filters) outSources = filterSources(sources.slice(), filters)
      return respond(event, { code: 0, sources: outSources, total: outSources.length, initInfo, filterOptions })
    } catch (e) {
      return respond(event, { code: -1, message: e && e.message })
    }
  }

  // ===== 首页看板摘要：只查今日任务表（一行一科），不组卷、不拉题，供首页秒开渲染 =====
  // ===== 打卡正确率曲线（首页）：本学期与上学期、按周聚合全部科目正确率 =====
  // 学期划分与学情页一致：T1 = 9/1–次年1/31（秋季），T2 = 2/1–8/31（春季）；周序号以学期开始日所在周的周一为第 1 周。
  // 正确率口径与 parent 学情一致：未自评的主观题不计入。
  if (p.action === 'accuracyCurve') {
    try {
      const nowBJ = new Date(Date.now() + 8 * 3600 * 1000)
      const y = nowBJ.getUTCFullYear(), mo = nowBJ.getUTCMonth() + 1
      let curT, prevT
      if (mo >= 9) { curT = { start: y + '-09-01', end: (y + 1) + '-01-31', label: y + ' 秋季学期' }; prevT = { start: y + '-02-01', end: y + '-08-31', label: y + ' 春季学期' } }
      else if (mo === 1) { curT = { start: (y - 1) + '-09-01', end: y + '-01-31', label: (y - 1) + ' 秋季学期' }; prevT = { start: (y - 1) + '-02-01', end: (y - 1) + '-08-31', label: (y - 1) + ' 春季学期' } }
      else { curT = { start: y + '-02-01', end: y + '-08-31', label: y + ' 春季学期' }; prevT = { start: (y - 1) + '-09-01', end: y + '-01-31', label: (y - 1) + ' 秋季学期' } }
      const mondayMs = function (dateStr) {
        const t = new Date(dateStr + 'T00:00:00Z').getTime()
        const diff = (new Date(t).getUTCDay() + 6) % 7
        return t - diff * 86400000
      }
      const fromISO = new Date(new Date(prevT.start + 'T00:00:00Z').getTime() - 8 * 3600 * 1000).toISOString()
      const ar = await db.from('zx_answer_record').select('answered_at,is_correct,needs_self_grade,self_graded')
        .eq('student_id', studentId).gte('answered_at', fromISO).limit(20000)
      const rows = ar.data || []
      const build = function (term) {
        const base = mondayMs(term.start)
        const wk = {}
        let maxW = 0
        rows.forEach(function (a) {
          if (a.needs_self_grade && !a.self_graded) return
          const d = new Date(new Date(a.answered_at).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
          if (d < term.start || d > term.end) return
          const w = Math.floor((mondayMs(d) - base) / (7 * 86400000)) + 1
          if (!wk[w]) wk[w] = { w: w, total: 0, correct: 0 }
          wk[w].total++
          if (a.is_correct) wk[w].correct++
          if (w > maxW) maxW = w
        })
        const weeks = Object.keys(wk).map(Number).sort(function (a, b) { return a - b }).map(function (w) {
          const b = wk[w]
          return { w: w, total: b.total, correct: b.correct, acc: Math.round(b.correct / b.total * 100) }
        })
        return { label: term.label, start: term.start, end: term.end, weeks: weeks, maxWeek: maxW }
      }
      return respond(event, { code: 0, cur: build(curT), prev: build(prevT) })
    } catch (e) {
      return respond(event, { code: -1, message: e && e.message })
    }
  }

  if (p.action === 'board' && !isMakeup) {
    try {
      const rows = await db.from('zx_daily_tasks')
        .select('subject,status,total_count,done_count,composition')
        .eq('student_id', studentId).eq('task_date', today)
      const tasks = ((rows && rows.data) || []).map(function (r) {
        const comp = parseComp(r.composition)
        return {
          subject: r.subject, status: r.status || 'pending',
          total: Number(r.total_count) || 0, done: Number(r.done_count) || 0,
          wrong: Number(comp.wrong) || 0
        }
      })
      return respond(event, { code: 0, date: today, tasks })
    } catch (e) {
      return respond(event, { code: -1, message: e && e.message })
    }
  }

  try {
    // ===== 读取用户打卡设置（每日题数 / 错题比例），失败则用默认值，保证组卷不受影响 =====
    let DAILY_GOAL = 10        // 默认每天 10 题
    let wrongRatio = 50        // 默认错题占比 50%
    let personalized = true    // 个性化推荐（薄弱优先组卷）是否生效，见下方隐私开关
    try {
      const uRes = await db.from('zx_users').select('settings').eq('openid', studentId).limit(1)
      const uRow = uRes.data && uRes.data[0]
      let st = uRow && uRow.settings
      if (typeof st === 'string') { try { st = JSON.parse(st) } catch (e) { st = null } }
      const cfg = (st && typeof st === 'object' && st.checkin) ? st.checkin : {}
      const goal = Number(cfg.dailyGoal)
      if ([5, 10, 15, 20].indexOf(goal) >= 0) DAILY_GOAL = goal
      const ratio = Number(cfg.wrongRatio)
      if (!isNaN(ratio) && ratio >= 0 && ratio <= 100) wrongRatio = ratio
      // 隐私开关接真实逻辑（2026-11-27）：个性化推荐关、或未成年人模式开 → 新题不按薄弱优先；
      // 到期错题重刷是复习义务，不受影响。allowPersonalization 未设置按开处理（与默认值一致）。
      const priv = (st && typeof st === 'object' && st.privacy && typeof st.privacy === 'object') ? st.privacy : {}
      personalized = priv.minorMode === true ? false : (priv.allowPersonalization !== false)
    } catch (e) { /* 设置读取失败用默认值 */ }
    // 错题目标数 = 每日题数 × 错题占比，向下取整，至少 0；错题不足时用新题补齐
    const WRONG_CAP = Math.max(0, Math.floor(DAILY_GOAL * wrongRatio / 100))

    // 科目宽松匹配：兼容「英语 / English / 初中英语 / 带空格」等写法，修复精确匹配漏题
    const SUBJECT_ALIAS = {
      '英语': ['英语', 'english'], '数学': ['数学', 'math', 'maths'],
      '语文': ['语文', 'chinese'], '物理': ['物理', 'physics'],
      '化学': ['化学', 'chemistry'], '生物': ['生物', 'biology'],
      '历史': ['历史', 'history'], '地理': ['地理', 'geography']
    }
    function subjMatch(qs, want) {
      if (!want) return true // 综合=全部
      const s = String(qs == null ? '' : qs).trim().toLowerCase()
      const w = String(want).trim().toLowerCase()
      if (!s) return false
      if (s === w || s.indexOf(w) >= 0 || w.indexOf(s) >= 0) return true
      const aliases = SUBJECT_ALIAS[want] || SUBJECT_ALIAS[w] || []
      return aliases.some(function (a) { return s === a || s.indexOf(a) >= 0 })
    }

    // ===== 1) 当天该科已有任务：题数达标(≥10)才复用；不足则重新组卷并覆盖，修复早期只组到 1 题的历史任务 =====
    let existingTask = null
    const exist = await db.from('zx_daily_tasks')
      .select('*').eq('student_id', studentId).eq('task_date', today)
      .eq('subject', taskSubject).limit(1)
    if (exist.data && exist.data.length) {
      const t0 = exist.data[0]
      const oldIds = parseArr(t0.question_ids)
      // 当天该科已打卡完成：无论题数多少都直接复用，绝不重卷覆盖。
      // 修复：早期题库只有 1 题的任务完成后，被「题数不足重卷」逻辑反复冲掉 done 状态，
      // 导致「已打卡却显示未打卡」。
      if (t0.status === 'done') {
        const questions = await hydrateQuestions(db, t0)
        return respond(event, { code: 0, task: t0, questions, subject: taskSubject })
      }
      // 【v1.9.17】复用未完成任务前，校验任务题目是否仍「启用」。
      // 用户在「我的试卷」取消勾选某来源后，该来源题目 enabled=false；若不校验，
      // 当天已生成的 pending 任务会带着停用题被直接复用，导致「取消勾选后首页仍显示旧题」。
      // 只要有任一题被停用/删除，就作废本任务、走下方按最新启用题池重新组卷。
      let stillEnabled = oldIds.length > 0
      if (stillEnabled) {
        const qRes = await db.from('zx_questions').select('id,enabled,stem').eq('student_id', studentId).in('id', oldIds)
        const qMap = {}
        ;((qRes && qRes.data) || []).forEach(function (q) { qMap[q.id] = q })
        stillEnabled = oldIds.every(function (id) { return qMap[id] && qMap[id].enabled !== false })
        // 旧逻辑组出的任务可能含同题干副本（一题出现两次）：发现重复题干就作废重卷
        if (stillEnabled) {
          const stemSeen = new Set()
          for (const id of oldIds) {
            const sk = String((qMap[id] && qMap[id].stem) || '').replace(/\s+/g, ' ').trim()
            if (sk && stemSeen.has(sk)) { stillEnabled = false; break }
            if (sk) stemSeen.add(sk)
          }
        }
      }
      // 设置指纹：组卷时用的题数/错题占比与当前设置不一致 → 不复用，按新设置重组
      // （修复：改了每日题数后旧任务被直接复用、新设置不生效）
      let settingsMatch = true
      const comp0 = parseComp(t0.composition)
      if (comp0.goal && Number(comp0.goal) !== DAILY_GOAL) settingsMatch = false
      if (settingsMatch && comp0.ratio != null && Number(comp0.ratio) !== wrongRatio) settingsMatch = false
      // 个性化开关也进指纹：开关变化后旧任务不复用（老任务无此字段时不拦，避免无谓重组）
      if (settingsMatch && comp0.personalized != null && !!comp0.personalized !== personalized) settingsMatch = false
      if (stillEnabled && settingsMatch && oldIds.length >= DAILY_GOAL) {
        const questions = await hydrateQuestions(db, t0)
        if (questions.length >= DAILY_GOAL) return respond(event, { code: 0, task: t0, questions, subject: taskSubject })
      }
      // 未完成且题数不足，或题目已被停用 → 下面重新组卷并 update 覆盖
      existingTask = t0
    }

    // ===== 2) 题池：本人已确认题，内存里做「启用过滤 + 科目宽松匹配」，避免 eq 精确匹配漏题 =====
    // 题池只拉组卷必需的轻字段（排序/去重/隔离），选中后再按 id 补全题目全文，避免每次组卷传输全库
    const poolRes = await db.from('zx_questions').select('id,subject,stem,knowledge_tags,enabled').eq('student_id', studentId).eq('confirmed', true).limit(1000)
    const allConfirmed = poolRes.data || []
    // enabled=false 视为停用；默认 true 兼容老数据 null/undefined
    const pool = allConfirmed.filter(function (q) { return q.enabled !== false && subjMatch(q.subject, wantSubject) })
    const poolIds = new Set(pool.map(function (q) { return q.id }))
    const poolMap = {}
    pool.forEach(function (q) { poolMap[q.id] = q })

    // ===== 3) 艾宾浩斯到期错题：active + 到期(next_review_at<=now)，按到期时间升序，最多 WRONG_CAP 道 =====
    // 同时取全部 active 错题 id，用于准确统计任务里「有几道是错题」（含未到期错题，口径与首页一致）
    const wrongAllRes = await db.from('zx_wrongbook')
      .select('*').eq('student_id', studentId).eq('status', 'active').limit(500)
    const wrongAllRows = wrongAllRes.data || []
    const activeWrongIds = {}
    wrongAllRows.forEach(function (w) { activeWrongIds[w.question_id] = true })
    const nowMs = Date.now()
    const wrongs = wrongAllRows
      .filter(function (w) { return poolIds.has(w.question_id) })
      .filter(function (w) { return !w.next_review_at || new Date(w.next_review_at).getTime() <= nowMs })
      .sort(function (a, b) { return String(a.next_review_at || '').localeCompare(String(b.next_review_at || '')) })
      .slice(0, WRONG_CAP)
    const wrongQids = wrongs.map(function (w) { return w.question_id })

    // ===== 4) 组题：错题优先 → 已启用题库按「薄弱优先」自适应补齐到 10 题 =====
    // 自适应：读取学生掌握度，题目按其知识点平均掌握度升序排列（越薄弱越优先），
    // 掌握度越高越靠后（"毕业"机制）；同一知识点短时间内最多 2 道，避免重复消耗。
    let masteryMap = {}
    if (personalized) {
      try {
        const mRes = await db.from('zx_mastery').select('knowledge_id,score').eq('student_id', studentId).limit(500)
        ;(mRes.data || []).forEach(function (m) { masteryMap[m.knowledge_id] = Number(m.score) || 50 })
      } catch (e) { /* 掌握度读取失败则退回按序补齐 */ }
    }
    const tagScore = function (q) {
      const tags = parseArr(q.knowledge_tags)
      if (!tags.length) return 50
      let sum = 0, n = 0
      tags.forEach(function (t) { if (typeof masteryMap[t] === 'number') { sum += masteryMap[t]; n++ } })
      return n ? (sum / n) : 50
    }
    // 薄弱优先排序：掌握度低在前；同分保持原顺序（稳定排序）。
    // 个性化关（或未成年人模式）时改为随机序：不按掌握度挑题，只保留同知识点上限与去重规则。
    let ranked
    if (personalized) {
      ranked = pool.map(function (q, i) { return { q: q, i: i, s: tagScore(q) } })
        .sort(function (a, b) { return (a.s - b.s) || (a.i - b.i) })
        .map(function (x) { return x.q })
    } else {
      ranked = pool.slice()
      for (let i = ranked.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        const tmp = ranked[i]; ranked[i] = ranked[j]; ranked[j] = tmp
      }
    }

    // ===== 去重与错题隔离（2026-11-25 修复：同一道题在一次打卡里出现两次）=====
    // 题库里存在同题干、不同 id 的副本（一题多份）：错题本只记录其中一份的 id，
    // 另一份会被当作「新题（薄弱攻坚）」再抽一次。规则：已在错题本（active）的题目，
    // 无论哪份副本，都只能以「错题重刷」身份出现，绝不进新题池；任务内同题干只留一道。
    const stemKey = function (q) { return String((q && q.stem) || '').replace(/\s+/g, ' ').trim() }
    const wrongStems = new Set()
    pool.forEach(function (q) { if (activeWrongIds[q.id]) { const sk = stemKey(q); if (sk) wrongStems.add(sk) } })
    const isWrongCopy = function (q) { return !!activeWrongIds[q.id] || wrongStems.has(stemKey(q)) }

    const picked = []
    const seen = new Set()
    const seenStems = new Set()
    const tagCount = {}
    const TAG_CAP = 2
    for (const qid of wrongQids) {
      const q = poolMap[qid]
      if (q && !seen.has(q.id) && !seenStems.has(stemKey(q))) {
        picked.push(q); seen.add(q.id); seenStems.add(stemKey(q))
        parseArr(q.knowledge_tags).forEach(function (t) { tagCount[t] = (tagCount[t] || 0) + 1 })
      }
    }
    // 第一轮：薄弱优先，尊重同知识点 ≤2 上限；错题本题目（含同题干副本）一律跳过
    for (const q of ranked) {
      if (picked.length >= DAILY_GOAL) break
      if (seen.has(q.id) || seenStems.has(stemKey(q)) || isWrongCopy(q)) continue
      const tags = parseArr(q.knowledge_tags)
      if (tags.length && tags.every(function (t) { return (tagCount[t] || 0) >= TAG_CAP })) continue
      picked.push(q); seen.add(q.id); seenStems.add(stemKey(q))
      tags.forEach(function (t) { tagCount[t] = (tagCount[t] || 0) + 1 })
    }
    // 第二轮：若去重后不足 10 题，放宽知识点上限按序补足；错题隔离不放宽（宁可题数不足）
    for (const q of ranked) {
      if (picked.length >= DAILY_GOAL) break
      if (seen.has(q.id) || seenStems.has(stemKey(q)) || isWrongCopy(q)) continue
      picked.push(q); seen.add(q.id); seenStems.add(stemKey(q))
    }

    if (!picked.length) {
      const enabledTotal = allConfirmed.filter(function (q) { return q.enabled !== false }).length
      return respond(event, {
        code: -2,
        message: '【' + (wantSubject || '综合') + '】科目暂无可用题目。已确认启用题共 ' + enabledTotal + ' 道，但本科目匹配 0 道。请在「我的试卷」确认该科题目已勾选启用，或导入并确认该科题目。',
        emptySubject: wantSubject || '综合',
        diag: { confirmedTotal: allConfirmed.length, enabledTotal: enabledTotal, subjectMatched: 0, wantSubject: wantSubject }
      })
    }

    const pickedTop = picked.slice(0, DAILY_GOAL)
    const fullRes = await db.from('zx_questions').select('*').eq('student_id', studentId)
      .in('id', pickedTop.map(function (q) { return q.id }))
    const fullMap = {}
    ;((fullRes && fullRes.data) || []).forEach(function (q) { fullMap[q.id] = q })
    const questions = pickedTop.map(function (q) { return fullMap[q.id] || q }).map(normalizeQuestion)
    const ids = questions.map(function (q) { return q.id })
    // wrong 按「任务题目中属于错题本 active」统计（含未到期错题），与首页口径一致；
    // 到期错题/wrongQids 仅用于「优先组卷」，不再直接等于展示的 wrong 数。
    const wrongInTask = ids.filter(function (id) { return !!activeWrongIds[id] }).length
    const bankCount = ids.length - wrongInTask
    const composition = {
      wrong: wrongInTask, bank: bankCount, goal: DAILY_GOAL, ratio: wrongRatio, personalized: personalized, subject: taskSubject,
      actual: ids.length, wrongDue: wrongQids.length, confirmedTotal: allConfirmed.length,
      enabledSubjectTotal: pool.length, rebuilt: !!existingTask, generatedAt: new Date().toISOString(),
      isMakeup: isMakeup, makeupDate: makeupDate
    }
    const taskPayload = {
      subject: taskSubject,
      question_ids: JSON.stringify(ids),
      composition: JSON.stringify(composition),
      status: 'pending', total_count: ids.length, done_count: 0,
      started_at: null, finished_at: null,
      is_makeup: isMakeup, makeup_date: makeupDate
    }
    let task
    if (existingTask) {
      // 覆盖旧任务（题数不足的历史任务），保留原 id / 创建时间
      const up = await db.from('zx_daily_tasks').update(taskPayload).eq('id', existingTask.id)
      // 写入失败必须报错，绝不返回未落库的「幻影任务」（2026-11-24 教训：缺列时 insert 静默失败，
      // 前端拿着不存在的 taskId 去 submitAnswer 必然 -403，整场打卡被降级成本地模式且不落库）
      if (up && up.error) throw new Error('任务更新失败：' + (up.error.message || JSON.stringify(up.error)))
      task = Object.assign({}, existingTask, taskPayload)
    } else {
      taskPayload.created_at = new Date().toISOString()
      task = Object.assign({ id: genId('t'), student_id: studentId, task_date: today }, taskPayload)
      const ins = await db.from('zx_daily_tasks').insert(task)
      if (ins && ins.error) throw new Error('任务创建失败：' + (ins.error.message || JSON.stringify(ins.error)))
    }
    const note = '本次组卷：错题重刷 ' + wrongInTask + ' 道（其中到期 ' + wrongQids.length + ' 道）+ 题库巩固 ' + bankCount + ' 道 = ' + ids.length + ' 题；本科目已确认启用题共 ' + pool.length + ' 道' +
      (ids.length < DAILY_GOAL ? '（题库不足' + DAILY_GOAL + '题，已取全部）' : '') + (existingTask ? '；已刷新旧任务' : '')
    // question_ids 以数组返回，前端免解析；同时保留字符串字段兼容老逻辑
    // wrongbook 快照一并返回，供前端刷新本地错题本缓存（首页三维度实时交叉依赖它）
    return respond(event, {
      code: 0, task: Object.assign({}, task, { question_ids: ids }), questions,
      subject: taskSubject, note, composition, wrongbook: wrongAllRows
    })
  } catch (e) {
    return respond(event, { code: -1, message: e && e.message })
  }
}

// 已有任务时，按 question_ids 顺序把题目详情查出来一并返回
async function hydrateQuestions(db, task) {
  const ids = parseArr(task.question_ids)
  if (!ids.length) return []
  const res = await db.from('zx_questions').select('*').eq('student_id', task.student_id).in('id', ids)
  const map = {}
  ;(res.data || []).forEach(q => { map[q.id] = q })
  return ids.map(id => map[id]).filter(Boolean).map(normalizeQuestion)
}
