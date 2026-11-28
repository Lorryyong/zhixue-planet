/**
 * 云函数 login —— 微信云调用身份登录 + 首次建档（安全版）
 *
 * 身份来源（唯一可信）：微信云函数运行时注入的 openid。
 *   - 通过 wx.cloud.callFunction 调用时，微信会在运行时注入 OPENID；
 *   - 优先 wx-server-sdk.getWXContext().OPENID，兜底环境变量 WX_OPENID。
 *   - 【安全】绝不使用前端传入的 studentId / clientId 作为身份——
 *     HTTP 网关或外部调用拿不到 openid，一律拒绝，杜绝越权。
 *
 * 首次登录自动做两件事（幂等）：
 *   - 在 zx_users upsert 用户档案（openid / last_login_at）
 *   - 若该 student_id 名下无任何题目，克隆 demo_student 的 12 道确认种子题，
 *     保证新用户一进来就能组卷（三个业务云函数无需改动）
 *
 * 动作（入参 action，缺省为登录建档）：
 *   - （默认/空）：登录建档，返回 profile + 养成快照 + 种子克隆结果
 *   - getProfile   ：读取当前用户资料（昵称/头像/角色/注册时间）
 *   - updateProfile：更新当前用户昵称/头像（头像为云存储 fileID），只改自己，openid 鉴权
 *   - getSettings  ：读取用户设置（家长绑定/周报、学科教材、补签卡、隐私、打卡设置）
 *   - updateSettings：分片合并更新用户设置（parent/subjects/makeup/privacy/checkin 白名单）
 *   - makeupCheckin：用补签卡补一次打卡（消耗1张，写入 checkin_dates 并可能+连续天数）
 *   - listUsers    ：管理员查看所有注册用户列表（管理员白名单：ADMIN_OPENIDS ∪ zx_admins）
 *
 * 身份与安全：只认微信注入的 openid；updateProfile 只写自己的 openid，无法改他人；
 *            listUsers 需管理员白名单，非管理员返回 -403。
 *
 * 入参：{ action?, nickname?, avatar? }
 * 出参：{ code:0, studentId, profile?, users? , ... }
 */
const cloudbase = require('@cloudbase/js-sdk')
const contentCheck = require('./contentCheck.js')

const DEFAULT_APPID = 'wx8874a19dbd6fa717'

/** HTTP 网关适配（保留兼容；但网关调用无 openid，会在身份处被拒绝） */
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

/**
 * 取微信云调用注入的真实身份 openid（唯一可信来源）。
 * 取不到返回 ''，调用方应拒绝本次请求。
 */
function getCallerOpenId() {
  try {
    const wx = require('wx-server-sdk')
    wx.init({ env: wx.DYNAMIC_CURRENT_ENV })
    const ctx = wx.getWXContext() || {}
    if (ctx.OPENID) return ctx.OPENID
  } catch (e) { /* 未安装 wx-server-sdk 或非微信云调用环境 */ }
  // 微信云函数运行时也会直接注入环境变量（部分基础库/运行时）
  return process.env.WX_OPENID || ''
}

function parseArr(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') { try { return JSON.parse(v) } catch (e) { return [] } }
  return []
}

// 2.0 探索等级（按累计星能量 total_earned；门槛与前端 utils/spaceLevels.js 保持一致）
const SPACE_LEVELS = [[1, '月球基地', 0], [2, '火星前哨', 200], [3, '木星空间站', 500], [4, '土星环站', 1000], [5, '比邻星站', 1800], [6, '天狼星站', 3000], [7, '昴星团空间站', 4800], [8, '猎户座星云', 7200], [9, '鹰状星云', 10500], [10, '银河探索站', 15000], [11, '仙女座星系', 21000], [12, '拉尼亚凯亚', 30000]]
function spaceLevelOf(total) {
  let lv = SPACE_LEVELS[0]
  for (let i = 0; i < SPACE_LEVELS.length; i++) { if (total >= SPACE_LEVELS[i][2]) lv = SPACE_LEVELS[i] }
  return { level: lv[0], name: lv[1] }
}
/** 北京时间（UTC+8）的 YYYY-MM-DD；云函数运行在 UTC，直接用 toISOString 会把凌晨算成前一天 */
function beijingDate(base) {
  const ms = (base ? new Date(base).getTime() : Date.now()) + 8 * 3600 * 1000
  return new Date(ms).toISOString().slice(0, 10)
}

/** 用户设置默认值（缺失字段补齐，不覆盖已有值） */
function defaultSettings(s) {
  const o = (s && typeof s === 'object') ? s : {}
  return {
    parent: Object.assign({ bound: false, guardian: '', relation: '妈妈', phone: '', weekly: false, weeklyDay: '周日', boundAt: '' }, (o.parent && typeof o.parent === 'object') ? o.parent : {}),
    subjects: Array.isArray(o.subjects) ? o.subjects : [],
    makeup: Object.assign({ cards: 3, used: [], active: null }, (o.makeup && typeof o.makeup === 'object') ? o.makeup : {}),
    privacy: Object.assign({ minorMode: false, allowAnalytics: false, allowPersonalization: true, updatedAt: '' }, (o.privacy && typeof o.privacy === 'object') ? o.privacy : {}),
    checkin: Object.assign({ dailyGoal: 10, wrongRatio: 50, reviewPlan: 'standard', updatedAt: '' }, (o.checkin && typeof o.checkin === 'object') ? o.checkin : {})
  }
}

/** settings 列是 jsonb，但历史写入用过 JSON.stringify，读回来会是字符串（双层编码）：
 *  统一解包成对象。旧代码用 typeof==='object' 判断，导致字符串一律被当成 {}，
 *  每次分片保存都把其它分片重置回默认值（2026-11-26 事故：保存隐私设置把打卡题数冲回 10）。 */
function parseSettings(v) {
  let s = v
  for (let i = 0; i < 3 && typeof s === 'string'; i++) {
    try { s = JSON.parse(s) } catch (e) { return {} }
  }
  return (s && typeof s === 'object') ? s : {}
}

exports.main = async (event) => {
  const p = parseEvent(event)

  // 1) 身份：只认微信注入的 openid，前端传什么都不信
  const studentId = getCallerOpenId()
  if (!studentId) {
    return respond(event, {
      code: -401,
      message: '无法验证微信身份：请通过小程序的 wx.cloud.callFunction 调用；HTTP 网关和外部请求不受理',
      needWxCall: true
    })
  }

  const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
  const db = app.rdb()
  const action = p.action || ''

  // ============ 用户资料动作（无需建档/克隆，快速返回）============
  try {
    // 2.1) 读取当前用户资料
    if (action === 'getProfile') {
      const me = await db.from('zx_users').select('*').eq('openid', studentId).limit(1)
      const row = me.data && me.data[0]
      return respond(event, {
        code: 0, studentId,
        profile: row ? {
          openid: row.openid, role: row.role || 'student',
          nickname: row.nickname || '', avatar: row.avatar || '',
          grade_index: row.grade_index || 0, grade_base_year: row.grade_base_year || 0,
          province: row.province || '', city: row.city || '',
          createdAt: row.created_at, lastLoginAt: row.last_login_at
        } : { openid: studentId, role: 'student', nickname: '', avatar: '', grade_index: 0, grade_base_year: 0, province: '', city: '' }
      })
    }

    // 2.2) 更新当前用户昵称/头像（只改自己，白名单字段）
    if (action === 'updateProfile') {
      const patch = {}
      if (typeof p.nickname === 'string') {
        const nick = p.nickname.trim().slice(0, 20)
        const chk = await contentCheck.checkText(nick, studentId)
        if (!chk.pass) return respond(event, { code: -6, message: '昵称未通过内容安全检查：' + chk.reason })
        patch.nickname = nick
      }
      if (typeof p.avatar === 'string') patch.avatar = p.avatar.trim().slice(0, 1000)
      if (p.grade_index !== undefined) patch.grade_index = Math.max(0, Math.min(12, Number(p.grade_index) || 0))
      if (p.grade_base_year !== undefined) patch.grade_base_year = Number(p.grade_base_year) || 0
      if (typeof p.province === 'string') patch.province = p.province.trim().slice(0, 20)
      if (typeof p.city === 'string') patch.city = p.city.trim().slice(0, 20)
      if (!Object.keys(patch).length) {
        return respond(event, { code: -2, message: '没有可更新的资料字段' })
      }
      patch.last_login_at = new Date().toISOString()
      // 若用户尚未建档（极端情况：禁用默认登录后直接调用），先补建
      const exist = await db.from('zx_users').select('id').eq('openid', studentId).limit(1)
      if (!(exist.data && exist.data.length)) {
        await db.from('zx_users').insert(Object.assign({
          id: 'u_' + studentId, openid: studentId, role: 'student',
          created_at: new Date().toISOString()
        }, patch))
      } else {
        await db.from('zx_users').update(patch).eq('openid', studentId)
      }
      const me = await db.from('zx_users').select('*').eq('openid', studentId).limit(1)
      const row = me.data && me.data[0]
      return respond(event, {
        code: 0, studentId,
        profile: row ? {
          openid: row.openid, role: row.role || 'student',
          nickname: row.nickname || '', avatar: row.avatar || '',
          grade_index: row.grade_index || 0, grade_base_year: row.grade_base_year || 0,
          province: row.province || '', city: row.city || '',
          createdAt: row.created_at, lastLoginAt: row.last_login_at
        } : null,
        note: '资料已保存到用户管理模块（zx_users）'
      })
    }

    // 2.2.0) 能量重置：从今天答题起算，清零能量/等级/连续天数/签到/账本（保留徽章）
    if (action === 'resetEnergy') {
      const gm = await db.from('zx_gamification').select('*').eq('student_id', studentId).limit(1)
      const row = gm.data && gm.data[0]
      const badges = row ? parseArr(row.badges) : []
      const patch = {
        energy: 0, level: 1, streak: 0,
        checkin_dates: JSON.stringify([]), last_checkin_date: null,
        energy_ledger: JSON.stringify([]), updated_at: new Date().toISOString()
      }
      if (row) {
        await db.from('zx_gamification').update(patch).eq('student_id', studentId)
      } else {
        await db.from('zx_gamification').insert(Object.assign({
          student_id: studentId, badges: JSON.stringify(badges)
        }, patch))
      }
      return respond(event, {
        code: 0, studentId,
        gamification: { energy: 0, level: 1, streak: 0, checkinDates: [], badges: badges, energyLedger: [] },
        note: '能量已重置，从今天答题开始累计'
      })
    }

    // 2.2.1) 读取用户设置（缺失则给默认值，不落库）
    if (action === 'getSettings') {
      const me = await db.from('zx_users').select('settings').eq('openid', studentId).limit(1)
      const row = me.data && me.data[0]
      const settings = parseSettings(row && row.settings)
      return respond(event, { code: 0, studentId, settings: defaultSettings(settings) })
    }

    // 2.2.2) 分片合并更新用户设置（只接受白名单顶层键，深合并）
    if (action === 'updateSettings') {
      const cur = await db.from('zx_users').select('settings').eq('openid', studentId).limit(1)
      const row = cur.data && cur.data[0]
      const base = defaultSettings(parseSettings(row && row.settings))
      const inc = (p.settings && typeof p.settings === 'object') ? p.settings : {}
      // 白名单：仅这五个业务键可写，忽略任意其它键（防越权/污染）
      const KEYS = ['parent', 'subjects', 'makeup', 'privacy', 'checkin']
      KEYS.forEach(function (k) {
        if (inc[k] === undefined) return
        if (Array.isArray(base[k]) && Array.isArray(inc[k])) base[k] = inc[k]
        else if (base[k] && typeof base[k] === 'object' && inc[k] && typeof inc[k] === 'object' && !Array.isArray(inc[k])) {
          base[k] = Object.assign({}, base[k], inc[k])
        } else base[k] = inc[k]
      })
      const exist = await db.from('zx_users').select('id').eq('openid', studentId).limit(1)
      if (!(exist.data && exist.data.length)) {
        await db.from('zx_users').insert({
          id: 'u_' + studentId, openid: studentId, role: 'student',
          settings: base, created_at: new Date().toISOString()
        })
      } else {
        await db.from('zx_users').update({ settings: base, last_login_at: new Date().toISOString() }).eq('openid', studentId)
      }
      return respond(event, { code: 0, studentId, settings: base, note: '设置已保存到用户档案' })
    }

    // 2.2.4) 订阅消息授权记账：用户每同意一次「每日打卡提醒」授权，credits +1（一次授权可发一条）。
    // 存 settings.reminder（jsonb 直接存对象，勿 stringify）。reminderSend 定时函数按 credits 扣减发送。
    if (action === 'subscribeAck') {
      const tpl = String(p.templateId || '')
      if (!tpl) return respond(event, { code: -1, message: '缺少 templateId' })
      const cur = await db.from('zx_users').select('settings').eq('openid', studentId).limit(1)
      const row = cur.data && cur.data[0]
      const settings = parseSettings(row && row.settings) || {}
      const rem = (settings.reminder && typeof settings.reminder === 'object') ? settings.reminder : {}
      rem.tpl = tpl
      rem.credits = (Number(rem.credits) || 0) + 1
      rem.updatedAt = new Date().toISOString()
      settings.reminder = rem
      const up = await db.from('zx_users').update({ settings }).eq('openid', studentId)
      if (up && up.error) throw new Error('提醒授权记账失败：' + (up.error.message || ''))
      return respond(event, { code: 0, credits: rem.credits })
    }

    // 2.2.3) 开始补签：锁定漏打卡的一天，暂不扣卡、不算打卡；须完成该日答题后才真正补签（见 submitAnswer）
    if (action === 'makeupCheckin') {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) ? String(p.date) : ''
      if (!date) return respond(event, { code: -2, message: '补签日期无效' })
      const today = beijingDate()
      const dayMs = new Date(date + 'T00:00:00Z').getTime()
      const todayMs = new Date(today + 'T00:00:00Z').getTime()
      const diffDays = Math.round((todayMs - dayMs) / 86400000)
      if (diffDays < 1 || diffDays > 6) return respond(event, { code: -5, message: '只能补签最近 7 天内、今天之前的日期' })
      const uRow = (await db.from('zx_users').select('settings').eq('openid', studentId).limit(1)).data
      const settings = defaultSettings(parseSettings(uRow && uRow[0] && uRow[0].settings))
      const cards = Number(settings.makeup && settings.makeup.cards) || 0
      if (cards <= 0) return respond(event, { code: -3, message: '补签卡不足，暂无法补签' })
      const gmRow = (await db.from('zx_gamification').select('checkin_dates').eq('student_id', studentId).limit(1)).data
      const gm = gmRow && gmRow[0]
      const dates = gm ? parseArr(gm.checkin_dates) : []
      if (dates.indexOf(date) >= 0) return respond(event, { code: -4, message: '该日期已打卡，无需补签' })
      // 锁定该日为"待完成补签"；真正扣卡 + 写入 checkin_dates 在 submitAnswer 完成该日任务时执行
      settings.makeup.active = { date: date, at: new Date().toISOString(), status: 'pending' }
      await db.from('zx_users').update({ settings: settings }).eq('openid', studentId)
      return respond(event, { code: 0, studentId, date, cards, needQuiz: true, note: '已锁定补签日期，请完成该日打卡题目后自动补签' })
    }

    // 2.2.4) 取消补签：放弃当前待完成的补签（未答题前不扣卡）
    if (action === 'cancelMakeup') {
      const uRow = (await db.from('zx_users').select('settings').eq('openid', studentId).limit(1)).data
      const settings = defaultSettings(parseSettings(uRow && uRow[0] && uRow[0].settings))
      settings.makeup.active = null
      await db.from('zx_users').update({ settings: settings }).eq('openid', studentId)
      return respond(event, { code: 0, studentId, note: '已取消补签' })
    }

    // 2.3) 管理员：查看所有注册用户（带实时管理员标记与能量简要，供用户管理页）
    if (action === 'listUsers') {
      const envList = String(process.env.ADMIN_OPENIDS || '')
        .split(/[,，\s]+/).map(function (s) { return s.trim() }).filter(Boolean)
      const admRows = await db.from('zx_admins').select('openid,kind,expires_at').limit(500)
      const adminRows = admRows.data || []
      const rowValid = function (row) {
        return !!row && !(row.expires_at && new Date(row.expires_at).getTime() <= Date.now())
      }
      const isAdmin = envList.indexOf(studentId) >= 0 ||
        adminRows.some(function (r) { return r.openid === studentId && rowValid(r) })
      if (!isAdmin) {
        return respond(event, { code: -403, message: '仅管理员可查看用户列表' })
      }
      // 管理员标记映射（env 优先，其次未过期的 zx_admins 行）
      const adminKindOf = {}
      adminRows.forEach(function (r) { if (rowValid(r)) adminKindOf[r.openid] = r.kind || 'appointed' })
      envList.forEach(function (oid) { adminKindOf[oid] = 'env' })
      // 能量简要（用户行展示等级/能量用）
      const gmMap = {}
      try {
        const gm = await db.from('zx_gamification').select('student_id,energy,total_earned').limit(500)
        ;(gm.data || []).forEach(function (g) {
          gmMap[g.student_id] = { energy: Number(g.energy) || 0, totalEarned: Number(g.total_earned) || 0 }
        })
      } catch (e) {}
      const r = await db.from('zx_users').select('*').limit(500)
      const users = (r.data || []).sort(function (a, b) {
        return String(b.created_at || '').localeCompare(String(a.created_at || ''))
      }).map(function (u) {
        const g = gmMap[u.openid] || { energy: 0, totalEarned: 0 }
        return {
          openid: u.openid, role: u.role || 'student',
          nickname: u.nickname || '', avatar: u.avatar || '',
          grade_index: u.grade_index || 0, grade_base_year: u.grade_base_year || 0,
          province: u.province || '', city: u.city || '',
          isAdmin: !!adminKindOf[u.openid], adminKind: adminKindOf[u.openid] || '',
          energy: g.energy, totalEarned: g.totalEarned,
          createdAt: u.created_at, lastLoginAt: u.last_login_at
        }
      })
      const adminTotal = users.filter(function (u) { return u.isAdmin }).length
      return respond(event, { code: 0, studentId, users, total: users.length, adminTotal })
    }
  } catch (e) {
    return respond(event, { code: -1, message: e && e.message })
  }

  try {
    // 2) upsert 用户档案
    const exist = await db.from('zx_users').select('id').eq('openid', studentId).limit(1)
    const isNew = !(exist.data && exist.data.length)
    if (isNew) {
      await db.from('zx_users').insert({
        id: 'u_' + studentId,
        openid: studentId,
        role: 'student',
        nickname: '微信用户',
        created_at: new Date().toISOString(),
        last_login_at: new Date().toISOString()
      })
    } else {
      await db.from('zx_users').update({ last_login_at: new Date().toISOString() })
        .eq('openid', studentId)
    }

    // 3) 养成数据建档（幂等）：新用户给初始能量/等级/徽章
    const gmExist = await db.from('zx_gamification').select('student_id').eq('student_id', studentId).limit(1)
    if (!(gmExist.data && gmExist.data.length)) {
      try {
        await db.from('zx_gamification').insert({
          student_id: studentId, energy: 0, level: 1, streak: 0,
          checkin_dates: '[]', badges: '[]',
          energy_ledger: '[]', updated_at: new Date().toISOString()
        })
      } catch (e) { /* 并发建档冲突可忽略 */ }
    }

    // 4) 首次建档：克隆种子题（幂等：名下已有题则跳过）
    let seeded = 0
    const own = await db.from('zx_questions').select('id').eq('student_id', studentId).limit(1)
    if (!(own.data && own.data.length)) {
      const seeds = await db.from('zx_questions')
        .select('*').eq('student_id', 'demo_student').eq('confirmed', true).limit(500)
      for (const q of (seeds.data || [])) {
        try {
          await db.from('zx_questions').insert(Object.assign({}, q, {
            id: 'q_' + require('crypto').randomBytes(5).toString('hex'),
            student_id: studentId,
            created_at: new Date().toISOString()
          }))
          seeded++
        } catch (e) { /* 单行失败不影响整体 */ }
      }
    }

    // 5) 回读养成快照，供前端恢复（换设备也能拿回能量/连续天数）
    let gamification = null
    try {
      const gm = await db.from('zx_gamification').select('*').eq('student_id', studentId).limit(1)
      const row = gm.data && gm.data[0]
      if (row) {
        // 2.0 探索等级自愈：按累计星能量重算，高于存量等级则落库并补一条升级历史
        let lv = Number(row.level || 1)
        let lvHist = parseArr(row.level_history)
        const lvInfo = spaceLevelOf(Number(row.total_earned || 0))
        if (lvInfo.level > lv) {
          lv = lvInfo.level
          lvHist.push({ level: lvInfo.level, name: lvInfo.name, at: new Date().toISOString(), totalEarned: Number(row.total_earned || 0) })
          lvHist = lvHist.slice(-50)
          try {
            const up = await db.from('zx_gamification').update({ level: lv, level_history: JSON.stringify(lvHist) }).eq('student_id', studentId)
            if (up && up.error) console.warn('[login] 等级自愈落库失败', up.error.message || up.error)
          } catch (e) { console.warn('[login] 等级自愈异常', e && e.message) }
        }
        gamification = {
          energy: Number(row.energy || 0), level: lv,
          streak: Number(row.streak || 0),
          totalEarned: Number(row.total_earned || 0),
          levelHistory: lvHist,
          checkinDates: typeof row.checkin_dates === 'string' ? JSON.parse(row.checkin_dates) : (row.checkin_dates || []),
          badges: typeof row.badges === 'string' ? JSON.parse(row.badges) : (row.badges || [])
        }
      }
    } catch (e) { /* 快照读取失败不影响登录 */ }

    // 5.5) 首页统计权威口径：本周正确率（本周一 00:00 北京时间起的已判分作答）+ 已攻克错题数。
    // 替代前端本地估算（旧 weekAccuracy 只看最近一次测验且被当前任务状态门控，长期显示 0）。
    if (gamification) {
      try {
        const now = new Date()
        const bj = new Date(now.getTime() + 8 * 3600 * 1000)
        const dow = (bj.getUTCDay() + 6) % 7 // 周一 = 0
        const mondayUtc = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate() - dow) - 8 * 3600 * 1000
        const ar = await db.from('zx_answer_record').select('is_correct,needs_self_grade')
          .eq('student_id', studentId).gte('answered_at', new Date(mondayUtc).toISOString()).limit(2000)
        const recs = (ar.data || []).filter(function (r) { return r.needs_self_grade !== true })
        const tot = recs.length
        const cor = recs.filter(function (r) { return r.is_correct }).length
        gamification.weekAccuracy = tot ? Math.round(cor / tot * 100) : 0
        gamification.weekTotal = tot
        gamification.weekCorrect = cor
        const cq = await db.from('zx_wrongbook').select('id')
          .eq('student_id', studentId).eq('status', 'conquered').limit(2000)
        gamification.conqueredCount = (cq.data || []).length
      } catch (e) { /* 统计失败不影响登录，前端回退本地估算 */ }
    }

    // 5.6) 打卡排名：全体用户按累计获得能量（total_earned，只增不减）降序。
    // 余额会因农场消费减少，不能代表累计打卡成果，故不用 energy 排序。
    let leaderboard = null
    try {
      const all = await db.from('zx_gamification').select('student_id,total_earned,streak').limit(500)
      const rows = (all.data || []).filter(function (r) { return r.student_id && r.student_id !== 'demo_student' })
      if (rows.length) {
        const users = await db.from('zx_users').select('openid,nickname,avatar,settings').limit(500)
        const uMap = {}
        ;(users.data || []).forEach(function (u) { uMap[u.openid] = u })
        rows.sort(function (a, b) { return Number(b.total_earned || 0) - Number(a.total_earned || 0) })
        leaderboard = rows.map(function (r, i) {
          const u = uMap[r.student_id] || {}
          const isMe = r.student_id === studentId
          let nickname = u.nickname || '同学'
          let avatar = u.avatar || ''
          // 未成年人模式接真实逻辑（2026-11-27）：开了该模式的用户，在别人的排行榜里
          // 只显示「同学」与默认头像，不暴露昵称头像；本人看自己一行不受影响。
          if (!isMe) {
            const ps = parseSettings(u.settings)
            if (ps.privacy && ps.privacy.minorMode === true) { nickname = '同学'; avatar = '' }
          }
          return {
            rank: i + 1, studentId: r.student_id,
            nickname, avatar,
            totalEarned: Number(r.total_earned || 0), streak: Number(r.streak || 0),
            isMe
          }
        })
      }
    } catch (e) { /* 排名读取失败不影响登录 */ }

    // 6) 回读用户档案（昵称/头像/设置），供前端展示与判断是否需要引导设置
    let profile = { openid: studentId, role: 'student', nickname: '', avatar: '', grade_index: 0, grade_base_year: 0, province: '', city: '' }
    let settings = defaultSettings({})
    try {
      const me = await db.from('zx_users').select('*').eq('openid', studentId).limit(1)
      const row = me.data && me.data[0]
      if (row) {
        profile = {
          openid: row.openid, role: row.role || 'student',
          nickname: row.nickname || '', avatar: row.avatar || '',
          grade_index: row.grade_index || 0, grade_base_year: row.grade_base_year || 0,
          province: row.province || '', city: row.city || '',
          createdAt: row.created_at, lastLoginAt: row.last_login_at
        }
        settings = defaultSettings(parseSettings(row.settings))
      }
    } catch (e) { /* 档案读取失败不影响登录 */ }
    const needProfileSetup = !(profile.nickname && profile.nickname !== '微信用户') || !profile.avatar

    // 能量明细账本回读
    let energyLedger = []
    try {
      if (gamification) {
        const gmRow = await db.from('zx_gamification').select('energy_ledger').eq('student_id', studentId).limit(1)
        const gRow = gmRow.data && gmRow.data[0]
        energyLedger = gRow ? parseArr(gRow.energy_ledger) : []
      }
    } catch (e) { /* 账本读取失败不影响登录 */ }

    return respond(event, {
      code: 0, studentId, authMode: 'openid', isNew, seeded, gamification, profile, settings, energyLedger, leaderboard, needProfileSetup,
      appId: DEFAULT_APPID, note: '微信 openid 登录成功，身份由云端注入，前端不可伪造'
    })
  } catch (e) {
    return respond(event, { code: -1, message: e && e.message })
  }
}
