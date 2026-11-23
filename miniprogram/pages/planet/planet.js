/**
 * 农场页（v1.9.8，原"星球"页改造）
 * 每门科目一个农场，每个农场一种小动物；用能量购买动物/食物/装饰，喂食促成长。
 * 云端模式：farm 云函数权威扣能量；本地模式：store.localFarmSpend 降级。
 */
const store = require('../../utils/store.js')
const settings = require('../../utils/settings.js')
const cloud = require('../../utils/cloud.js')
const auth = require('../../utils/auth.js')
const fd = require('../../utils/farmData.js')

Page({
  data: {
    energy: 0, level: 1,
    subjects: [],        // [{subject, animalEmoji, animalName}]
    subjectIndex: 0,
    current: null,       // 当前农场展示对象
    shopTab: 'food',     // animal | food | decor
    foods: fd.FOODS,
    decors: fd.DECORS,
    animalPrice: fd.ANIMAL_PRICE,
    decorOwned: {},      // decorId -> true
    buying: false,
    animalPriceTip: fd.ANIMAL_PRICE + '⚡ 领养专属小动物',
    stageName: '', stageEmoji: '', growthPct: 0, stageNext: '',
    decorItems: [],       // 已拥有装饰 [{id,emoji,name}]
    backDecor: [],        // 远景装饰（大树/小屋/彩虹）
    frontDecor: [],       // 近景装饰（小草/花丛/围栏）
    petSize: 108,         // 宠物字号随成长阶段变大
    crown: false,         // 传说期显示皇冠
    animalImg: '',        // 宠物立绘图片路径（有则优先于 emoji）
    spriteFrames: 0,      // 3D序列帧数（>0 时用雪碧图动画）
    spriteRatio: 1,       // 序列帧单帧高宽比
    roamDelay: 0,         // 跑动动画随机相位
    petBouncing: false,   // 点击蹦跳动画开关
    petBubble: ''         // 点击冒出的对话气泡
  },

  onShow() {
    this.loadSubjects()
    this.syncEnergy()
  },

  // ===== 科目 tab：来自用户勾选学科 =====
  loadSubjects() {
    const st = settings.cached()
    const list = fd.buildFarmList(st.subjects || [])
    this.setData({ subjects: list, subjectIndex: Math.min(this.data.subjectIndex, list.length - 1) })
    if (cloud.isCloudReady()) {
      this.fetchFarms()
    } else {
      this.applyLocalFarms(list)
    }
  },

  onSwitchSubject(e) {
    const i = Number(e.currentTarget.dataset.i)
    this.setData({ subjectIndex: i })
    if (cloud.isCloudReady()) this.fetchFarms()
    else this.applyLocalFarms(this.data.subjects)
  },

  onShopTab(e) {
    this.setData({ shopTab: e.currentTarget.dataset.tab })
  },

  // ===== 宠物互动：点击蹦跳并冒出气泡 =====
  onPetTap() {
    const c = this.data.current
    if (!c) return
    if (!c.animalOwned) {
      wx.showToast({ title: '先领养' + c.subject + '农场的小伙伴吧～', icon: 'none' })
      return
    }
    if (this._petBusy) return
    this._petBusy = true
    const bubbles = ['嘿嘿～', '一起玩吧！', '蹦蹦跳跳真开心', '今天也要加油鸭', '最喜欢你啦 ❤️', '再喂我一点点～']
    const bubble = bubbles[Math.floor(Math.random() * bubbles.length)]
    this.setData({ petBouncing: true, petBubble: bubble })
    setTimeout(() => this.setData({ petBouncing: false }), 620)
    setTimeout(() => { this.setData({ petBubble: '' }); this._petBusy = false }, 1600)
  },

  // ===== 云端：拉取农场快照 =====
  fetchFarms() {
    auth.ensureStudentId().then(() => cloud.call('farm', { action: 'getFarms' })).then(r => {
      this.applyServerFarms(r.farms || [], r.energy || 0)
    }).catch(() => {
      // 云端失败降级本地
      this.applyLocalFarms(this.data.subjects)
    })
  },

  // 用云端农场快照 + 科目列表合成展示（科目即使未建农场也展示为"未领养"）
  applyServerFarms(farms, energy) {
    const bySubject = {}
    farms.forEach(f => { bySubject[f.subject] = f })
    const subjects = this.data.subjects.map(x => {
      const f = bySubject[x.subject]
      return Object.assign({}, x, {
        animalOwned: f ? f.animalOwned : false,
        hasFarm: !!f
      })
    })
    this.setData({ subjects, energy: energy })
    this.pickCurrent(bySubject)
  },

  applyLocalFarms(list) {
    const s = store.getState()
    const bySubject = {}
    list.forEach(x => {
      const f = store.ensureLocalFarm(x.subject)
      const animal = fd.animalOf(x.subject)
      const stage = fd.stageOf(f.growth)
      bySubject[x.subject] = {
        subject: x.subject, animalEmoji: animal.emoji, animalName: animal.name,
        animalKind: animal.kind, animalDesc: animal.desc,
        animalOwned: !!f.animalOwned, growth: f.growth, feedCount: f.feedCount,
        decorIds: f.decorIds || [], stage: stage
      }
    })
    const subjects = list.map(x => Object.assign({}, x, { animalOwned: bySubject[x.subject].animalOwned, hasFarm: true }))
    this.setData({ subjects, energy: Number(s.gamification.energy || 0) })
    this.pickCurrent(bySubject)
  },

  // 选中当前科目农场
  pickCurrent(bySubject) {
    const idx = this.data.subjectIndex
    const sub = this.data.subjects[idx]
    if (!sub) { this.setData({ current: null }); return }
    const animal = fd.animalOf(sub.subject)
    const f = bySubject[sub.subject] || {
      subject: sub.subject, animalEmoji: animal.emoji, animalName: animal.name,
      animalKind: animal.kind, animalDesc: animal.desc,
      animalOwned: false, growth: 0, feedCount: 0, decorIds: [], stage: fd.stageOf(0)
    }
    const decorOwned = {}
    const decorItems = []
    const backDecor = []
    const frontDecor = []
    const BACK_IDS = ['d2', 'd5', 'd6'] // 大树 / 小屋 / 彩虹 作为远景
    ;(f.decorIds || []).forEach(id => {
      decorOwned[id] = true
      const d = fd.decorOf(id)
      if (d) {
        decorItems.push({ id: d.id, emoji: d.emoji, name: d.name })
        ;(BACK_IDS.indexOf(id) >= 0 ? backDecor : frontDecor).push({ id: d.id, emoji: d.emoji, name: d.name })
      }
    })
    const stage = f.stage || fd.stageOf(f.growth)
    // 宠物随成长阶段变大；传说期戴皇冠
    const petSize = [92, 110, 132, 150][stage.index] || 108
    const crown = stage.index >= 3
    // 有立绘的科目用透明图片/3D序列帧，其余仍用 emoji
    const animalImg = fd.imageOf(sub.subject) || ''
    const sprite = fd.spriteOf(sub.subject)
    const spriteFrames = sprite ? sprite.frames : 0
    const spriteRatio = sprite ? sprite.ratio : 1
    // 跑动动画随机相位，避免多个农场宠物动作完全同步
    const roamDelay = -(Math.floor(Math.random() * 8))
    const next = stage.next
    // 用真实百分比：当前阶段下限 → 下一阶段下限
    const lower = fd.STAGES[stage.index].min
    const pct = next ? Math.min(100, Math.max(0, Math.round((stage.growth - lower) / (next.min - lower) * 100))) : 100
    this.setData({
      current: f, decorOwned, decorItems, backDecor, frontDecor, petSize, crown, animalImg, roamDelay, spriteFrames, spriteRatio,
      stageName: stage.name, stageEmoji: stage.emoji,
      stageNext: next ? ('距' + next.name + ' ' + Math.max(0, next.min - stage.growth) + ' 成长') : '已臻满级 ✨',
      growthPct: pct
    })
  },

  syncEnergy() {
    if (!cloud.isCloudReady()) {
      this.setData({ energy: Number(store.getState().gamification.energy || 0) })
      return
    }
    auth.syncGamification().then(g => {
      if (g) this.setData({ energy: Number(g.energy || 0), level: Number(g.level || 1) })
    }).catch(() => {})
  },

  // ===== 购买动作 =====
  doBuy(payload, successMsg) {
    const subject = this.currentSubject()
    if (!subject) return
    if (this.data.buying) return
    this.setData({ buying: true })

    const finish = (ok, msg, energy) => {
      this.setData({ buying: false })
      wx.showToast({ title: msg, icon: ok ? 'success' : 'none' })
      if (ok && typeof energy === 'number') this.setData({ energy: energy })
      if (ok) {
        if (cloud.isCloudReady()) this.fetchFarms()
        else this.applyLocalFarms(this.data.subjects)
        this.syncEnergy()
      }
    }

    if (cloud.isCloudReady()) {
      auth.ensureStudentId().then(() => cloud.call('farm', Object.assign({ subject }, payload))).then(r => {
        finish(true, successMsg || (r.note || '购买成功'), r.energy)
      }).catch(e => {
        const m = (e && e.message) || '购买失败，请重试'
        finish(false, m.length > 24 ? m.slice(0, 24) : m)
      })
    } else {
      // 本地降级：按动作扣能量并更新本地农场
      const f = store.ensureLocalFarm(subject)
      let cost = 0, reason = '', apply = null
      if (payload.action === 'buyAnimal') {
        if (f.animalOwned) { finish(false, '已经领养啦'); return }
        cost = fd.ANIMAL_PRICE; reason = '领养' + subject + '农场小动物'; apply = () => { f.animalOwned = true }
      } else if (payload.action === 'feed') {
        if (!f.animalOwned) { finish(false, '请先领养小动物'); return }
        const food = fd.foodOf(payload.foodId)
        if (!food) { finish(false, '食物不存在'); return }
        cost = food.price; reason = '喂养·' + food.name; apply = () => { f.growth += food.growth; f.feedCount++ }
      } else if (payload.action === 'buyDecor') {
        const decor = fd.decorOf(payload.decorId)
        if (!decor) { finish(false, '装饰不存在'); return }
        if ((f.decorIds || []).indexOf(decor.id) >= 0) { finish(false, '已经拥有啦'); return }
        cost = decor.price; reason = '装扮·' + decor.name; apply = () => { f.decorIds = (f.decorIds || []).concat([decor.id]) }
      }
      const r = store.localFarmSpend(cost, reason)
      if (!r.ok) { finish(false, '能量不足，还差 ' + r.need + ' ⚡'); return }
      if (apply) apply()
      store.saveFarms((() => { const m = store.getFarms(); m[subject] = f; return m })())
      const s = store.getState()
      finish(true, successMsg || '购买成功', s.gamification.energy)
    }
  },

  onBuyAnimal() {
    const sub = this.data.subjects[this.data.subjectIndex]
    if (sub && sub.animalOwned) { wx.showToast({ title: '已经领养啦', icon: 'none' }); return }
    this.doBuy({ action: 'buyAnimal' }, '领养成功！')
  },
  onFeed(e) {
    this.doBuy({ action: 'feed', foodId: e.currentTarget.dataset.id }, '喂养成功，成长 ↑')
  },
  onBuyDecor(e) {
    const id = e.currentTarget.dataset.id
    if (this.data.decorOwned[id]) { wx.showToast({ title: '已经拥有啦', icon: 'none' }); return }
    this.doBuy({ action: 'buyDecor', decorId: id }, '装扮成功！')
  },

  currentSubject() {
    const sub = this.data.subjects[this.data.subjectIndex]
    return sub ? sub.subject : ''
  },

  goPoints() { wx.navigateTo({ url: '/pages/points/points' }) },
  goEarn() { wx.switchTab({ url: '/pages/index/index' }) }
})
