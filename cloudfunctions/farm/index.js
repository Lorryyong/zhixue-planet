/**
 * 云函数 farm —— 科目农场（v1.9.8）
 *
 * 每门科目一个农场，每个农场一种小动物。用户用能量购买动物、购买食物喂养成长、
 * 购买装饰装扮农场。能量收支由本云函数权威处理（服务端扣减并写 zx_gamification.energy_ledger），
 * 前端只展示结果，无法伪造。
 *
 * 动作（入参 action）：
 *   - getFarms   ：读取当前用户所有农场快照 + 最新能量账本
 *   - buyAnimal  ：{subject} 购买该科小动物（一次性，价格 farmData.ANIMAL_PRICE）
 *   - feed       ：{subject, foodId} 购买食物并喂养，成长值累加 food.growth，可重复
 *   - buyDecor   ：{subject, decorId} 购买装饰，永久装扮该农场（去重）
 *
 * 安全：身份只认微信注入的 openid；科目/食物/装饰均走 farmData 白名单校验；
 *      能量不足返回 -2；所有扣减写账本（负 delta），与答题奖励账本同口径。
 */
const cloudbase = require('@cloudbase/js-sdk')
const fd = require('./farmData.js')

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
function parseArr(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') { try { return JSON.parse(v) } catch (e) { return [] } }
  return []
}
function genId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/** 农场行 → 前端展示对象（注入动物元信息与成长阶段） */
function present(row) {
  const subject = row.subject
  const animal = fd.animalOf(subject)
  const stage = fd.stageOf(row.growth)
  return {
    id: row.id, subject: subject,
    animalEmoji: animal.emoji, animalName: animal.name, animalKind: animal.kind, animalDesc: animal.desc,
    animalOwned: !!row.animal_owned,
    growth: Number(row.growth || 0), feedCount: Number(row.feed_count || 0),
    decorIds: parseArr(row.decor_ids),
    stage: stage,
    createdAt: row.created_at, updatedAt: row.updated_at
  }
}

/** 读取（或惰性建档）某用户某科目的农场行 */
async function ensureFarm(db, studentId, subject, nowIso) {
  const r = await db.from('zx_farms').select('*').eq('student_id', studentId).eq('subject', subject).limit(1)
  if (r.data && r.data.length) return r.data[0]
  const row = {
    id: genId('farm'), student_id: studentId, subject: subject,
    animal_owned: false, growth: 0, feed_count: 0, decor_ids: '[]',
    created_at: nowIso, updated_at: nowIso
  }
  try { await db.from('zx_farms').insert(row) } catch (e) { /* 并发建档冲突，回读即可 */ }
  const again = await db.from('zx_farms').select('*').eq('student_id', studentId).eq('subject', subject).limit(1)
  return (again.data && again.data[0]) || row
}

/** 读取用户能量行，不存在则建档为 0 */
async function ensureGamification(db, studentId, nowIso) {
  const r = await db.from('zx_gamification').select('*').eq('student_id', studentId).limit(1)
  if (r.data && r.data.length) return r.data[0]
  const row = {
    student_id: studentId, energy: 0, level: 1, streak: 0,
    checkin_dates: '[]', badges: '[]', energy_ledger: '[]', updated_at: nowIso
  }
  try { await db.from('zx_gamification').insert(row) } catch (e) {}
  return row
}

exports.main = async (event) => {
  const p = parseEvent(event)
  const studentId = getCallerOpenId()
  if (!studentId) {
    return respond(event, { code: -401, message: '无法验证微信身份，请通过 wx.cloud.callFunction 调用', needWxCall: true })
  }
  const action = p.action || 'getFarms'
  const subject = String(p.subject || '').trim()
  const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV })
  const db = app.rdb()
  const nowIso = new Date().toISOString()

  // 科目白名单校验（购买类动作必须有合法科目）
  const needSubject = ['buyAnimal', 'feed', 'buyDecor'].indexOf(action) >= 0
  if (needSubject && fd.ALL_SUBJECTS.indexOf(subject) < 0) {
    return respond(event, { code: -3, message: '科目不在支持范围：' + subject })
  }

  try {
    // ===== 读取农场快照 =====
    if (action === 'getFarms') {
      const [farmRes, gmRes] = await Promise.all([
        db.from('zx_farms').select('*').eq('student_id', studentId).limit(100),
        db.from('zx_gamification').select('*').eq('student_id', studentId).limit(1)
      ])
      const gm = gmRes.data && gmRes.data[0]
      return respond(event, {
        code: 0, studentId,
        farms: (farmRes.data || []).map(present),
        energy: gm ? Number(gm.energy || 0) : 0,
        energyLedger: gm ? parseArr(gm.energy_ledger).slice(-200) : []
      })
    }

    // ===== 2.0 宇宙探索：星球基地（zx_farms 中 subject='星球' 的特殊行） =====
    // ownedIds（planet 行 decor_ids）存已购伙伴 sp* 与装扮 d*；growth 为基地成长值。
    // 旧学科农场的已领养动物/已购装饰以「遗产」形式并入展示与装扮去重，不改动旧行。
    if (action === 'getPlanet' || action === 'buySpaceItem') {
      const PLANET = '星球'
      const allRes = await db.from('zx_farms').select('*').eq('student_id', studentId).limit(100)
      const rows = allRes.data || []
      const planetRow = rows.find(r => r.subject === PLANET) || null
      const legacyPartners = rows.filter(r => r.subject !== PLANET && r.animal_owned).map(r => {
        const a = fd.animalOf(r.subject)
        return {
          subject: r.subject, emoji: a.emoji, name: a.name, kind: a.kind,
          growth: Number(r.growth || 0), stageName: fd.stageOf(r.growth).name
        }
      })
      const legacyDecors = []
      rows.filter(r => r.subject !== PLANET).forEach(r => {
        parseArr(r.decor_ids).forEach(id => { if (legacyDecors.indexOf(id) < 0) legacyDecors.push(id) })
      })
      const planetView = {
        ownedIds: planetRow ? parseArr(planetRow.decor_ids) : [],
        growth: planetRow ? Number(planetRow.growth || 0) : 0,
        feedCount: planetRow ? Number(planetRow.feed_count || 0) : 0
      }
      const gmRow = await ensureGamification(db, studentId, nowIso)
      const curEnergy = Number(gmRow.energy || 0)
      if (action === 'getPlanet') {
        return respond(event, { code: 0, studentId, energy: curEnergy, planet: planetView, legacyPartners, legacyDecors })
      }
      // buySpaceItem {itemId}
      const item = fd.spaceItemOf(String(p.itemId || ''))
      if (!item) return respond(event, { code: -3, message: '商品不存在' })
      const prow = await ensureFarm(db, studentId, PLANET, nowIso)
      const ownedIds = parseArr(prow.decor_ids)
      if (item.kind === 'decor' && (ownedIds.indexOf(item.id) >= 0 || legacyDecors.indexOf(item.id) >= 0)) {
        return respond(event, { code: -4, message: '这件装扮已经拥有啦' })
      }
      if (item.kind === 'partner' && ownedIds.indexOf(item.id) >= 0) {
        return respond(event, { code: -4, message: '这位伙伴已经加入啦' })
      }
      if (item.kind === 'sign' && ownedIds.indexOf(item.id) >= 0) {
        return respond(event, { code: -4, message: '这件专属装扮已经拥有啦' })
      }
      if (curEnergy < item.price) {
        return respond(event, { code: -2, message: '星能量不足，还差 ' + (item.price - curEnergy) + ' ⚡，先去打卡赚能量吧', need: item.price - curEnergy, cost: item.price, energy: curEnergy })
      }
      const reason = item.kind === 'supply'
        ? '能量补给·' + item.name + ' -' + item.price
        : (item.kind === 'partner' ? '星际伙伴·' + item.name + ' -' + item.price : '星球装扮·' + item.name + ' -' + item.price)
      const ledger = parseArr(gmRow.energy_ledger)
      const newEnergy = curEnergy - item.price
      ledger.push({ id: genId('e'), delta: -item.price, reason: reason, at: nowIso })
      const ledgerTrim = ledger.slice(-200)
      const gmUp = await db.from('zx_gamification').update({
        energy: newEnergy, energy_ledger: JSON.stringify(ledgerTrim), updated_at: nowIso
      }).eq('student_id', studentId)
      if (gmUp && gmUp.error) return respond(event, { code: -1, message: '扣减星能量失败，请重试' })
      const patch = { updated_at: nowIso }
      if (item.kind === 'supply') {
        patch.growth = Number(prow.growth || 0) + (item.growth || 0)
        patch.feed_count = Number(prow.feed_count || 0) + 1
      } else {
        patch.decor_ids = JSON.stringify(ownedIds.concat([item.id]))
      }
      const fUp = await db.from('zx_farms').update(patch).eq('id', prow.id)
      if (fUp && fUp.error) return respond(event, { code: -1, message: '商品发放失败，请重试' })
      const fresh = await db.from('zx_farms').select('*').eq('id', prow.id).limit(1)
      const fr = (fresh.data && fresh.data[0]) || Object.assign({}, prow, patch)
      return respond(event, {
        code: 0, studentId, energy: newEnergy, energyLedger: ledgerTrim,
        planet: { ownedIds: parseArr(fr.decor_ids), growth: Number(fr.growth || 0), feedCount: Number(fr.feed_count || 0) },
        note: reason + '，剩余星能量 ' + newEnergy + ' ⚡'
      })
    }

    // 能量行 + 农场行
    const gm = await ensureGamification(db, studentId, nowIso)
    const farm = await ensureFarm(db, studentId, subject, nowIso)

    let cost = 0
    let reason = ''
    const patch = { updated_at: nowIso }

    if (action === 'buyAnimal') {
      if (farm.animal_owned) return respond(event, { code: -4, message: '本农场的小动物已经领养啦' })
      cost = fd.ANIMAL_PRICE
      reason = '领养' + subject + '农场·' + fd.animalOf(subject).name + ' -' + cost
      patch.animal_owned = true
    } else if (action === 'feed') {
      if (!farm.animal_owned) return respond(event, { code: -5, message: '请先领养本农场的小动物' })
      const food = fd.foodOf(String(p.foodId || ''))
      if (!food) return respond(event, { code: -3, message: '食物不存在' })
      cost = food.price
      reason = '喂养' + subject + '·' + food.name + ' -' + cost
      patch.growth = Number(farm.growth || 0) + food.growth
      patch.feed_count = Number(farm.feed_count || 0) + 1
    } else if (action === 'buyDecor') {
      const decor = fd.decorOf(String(p.decorId || ''))
      if (!decor) return respond(event, { code: -3, message: '装饰不存在' })
      const owned = parseArr(farm.decor_ids)
      if (owned.indexOf(decor.id) >= 0) return respond(event, { code: -4, message: '这件装饰已经拥有啦' })
      cost = decor.price
      reason = '装扮' + subject + '·' + decor.name + ' -' + cost
      patch.decor_ids = JSON.stringify(owned.concat([decor.id]))
    } else {
      return respond(event, { code: -9, message: '未知动作：' + action })
    }

    // 能量校验（服务端权威）
    let energy = Number(gm.energy || 0)
    if (energy < cost) {
      return respond(event, { code: -2, message: '能量不足，还差 ' + (cost - energy) + ' ⚡，先去打卡赚能量吧', need: cost - energy, cost, energy })
    }

    // 扣能量 + 写账本（负 delta，与答题奖励同口径）
    const ledger = parseArr(gm.energy_ledger)
    energy -= cost
    ledger.push({ id: genId('e'), delta: -cost, reason: reason, at: nowIso })
    const ledgerTrim = ledger.slice(-200)
    await db.from('zx_gamification').update({
      energy: energy, energy_ledger: JSON.stringify(ledgerTrim), updated_at: nowIso
    }).eq('student_id', studentId)

    // 更新农场
    await db.from('zx_farms').update(patch).eq('id', farm.id)

    // 回读最新农场
    const fresh = await db.from('zx_farms').select('*').eq('id', farm.id).limit(1)
    const row = (fresh.data && fresh.data[0]) || Object.assign({}, farm, patch)

    return respond(event, {
      code: 0, studentId, subject,
      farm: present(row), energy, energyLedger: ledgerTrim,
      note: reason + '，剩余能量 ' + energy + ' ⚡'
    })
  } catch (e) {
    return respond(event, { code: -1, message: '农场操作失败：' + (e && e.message || e) })
  }
}
