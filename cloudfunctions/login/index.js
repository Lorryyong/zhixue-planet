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
 *   - listUsers    ：管理员查看所有注册用户列表（管理员白名单：ADMIN_OPENIDS ∪ zx_admins）
 *
 * 身份与安全：只认微信注入的 openid；updateProfile 只写自己的 openid，无法改他人；
 *            listUsers 需管理员白名单，非管理员返回 -403。
 *
 * 入参：{ action?, nickname?, avatar? }
 * 出参：{ code:0, studentId, profile?, users? , ... }
 */
const cloudbase = require('@cloudbase/js-sdk')

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
          createdAt: row.created_at, lastLoginAt: row.last_login_at
        } : { openid: studentId, role: 'student', nickname: '', avatar: '' }
      })
    }

    // 2.2) 更新当前用户昵称/头像（只改自己，白名单字段）
    if (action === 'updateProfile') {
      const patch = {}
      if (typeof p.nickname === 'string') patch.nickname = p.nickname.trim().slice(0, 20)
      if (typeof p.avatar === 'string') patch.avatar = p.avatar.trim().slice(0, 1000)
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
          createdAt: row.created_at, lastLoginAt: row.last_login_at
        } : null,
        note: '资料已保存到用户管理模块（zx_users）'
      })
    }

    // 2.3) 管理员：查看所有注册用户
    if (action === 'listUsers') {
      const envList = String(process.env.ADMIN_OPENIDS || '')
        .split(/[,，\s]+/).map(function (s) { return s.trim() }).filter(Boolean)
      const admRows = await db.from('zx_admins').select('openid').limit(500)
      const adminRows = admRows.data || []
      const isAdmin = envList.indexOf(studentId) >= 0 ||
        adminRows.some(function (r) { return r.openid === studentId })
      if (!isAdmin) {
        return respond(event, { code: -403, message: '仅管理员可查看用户列表' })
      }
      const r = await db.from('zx_users').select('*').limit(500)
      const users = (r.data || []).sort(function (a, b) {
        return String(b.created_at || '').localeCompare(String(a.created_at || ''))
      }).map(function (u) {
        return {
          openid: u.openid, role: u.role || 'student',
          nickname: u.nickname || '', avatar: u.avatar || '',
          createdAt: u.created_at, lastLoginAt: u.last_login_at
        }
      })
      return respond(event, { code: 0, studentId, users, total: users.length })
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
          student_id: studentId, energy: 1280, level: 7, streak: 0,
          checkin_dates: '[]', badges: '["b1","b2","b3"]',
          updated_at: new Date().toISOString()
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
        gamification = {
          energy: Number(row.energy || 0), level: Number(row.level || 1),
          streak: Number(row.streak || 0),
          checkinDates: typeof row.checkin_dates === 'string' ? JSON.parse(row.checkin_dates) : (row.checkin_dates || []),
          badges: typeof row.badges === 'string' ? JSON.parse(row.badges) : (row.badges || [])
        }
      }
    } catch (e) { /* 快照读取失败不影响登录 */ }

    // 6) 回读用户档案（昵称/头像），供前端展示与判断是否需要引导设置
    let profile = { openid: studentId, role: 'student', nickname: '', avatar: '' }
    try {
      const me = await db.from('zx_users').select('*').eq('openid', studentId).limit(1)
      const row = me.data && me.data[0]
      if (row) {
        profile = {
          openid: row.openid, role: row.role || 'student',
          nickname: row.nickname || '', avatar: row.avatar || '',
          createdAt: row.created_at, lastLoginAt: row.last_login_at
        }
      }
    } catch (e) { /* 档案读取失败不影响登录 */ }
    const needProfileSetup = !(profile.nickname && profile.nickname !== '微信用户') || !profile.avatar

    return respond(event, {
      code: 0, studentId, authMode: 'openid', isNew, seeded, gamification, profile, needProfileSetup,
      appId: DEFAULT_APPID, note: '微信 openid 登录成功，身份由云端注入，前端不可伪造'
    })
  } catch (e) {
    return respond(event, { code: -1, message: e && e.message })
  }
}
