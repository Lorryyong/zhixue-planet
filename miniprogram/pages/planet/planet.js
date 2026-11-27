/**
 * 探索页（2.0，原"农场"页改造）：我的星球
 * 等级按累计星能量（total_earned）由 spaceLevels 配置计算；商城走 farm 云函数
 * getPlanet / buySpaceItem 权威扣能量；旧装饰以遗产形式并入已拥有装扮。
 */
const store = require('../../utils/store.js')
const cloud = require('../../utils/cloud.js')
const auth = require('../../utils/auth.js')
const fd = require('../../utils/farmData.js')
const sl = require('../../utils/spaceLevels.js')

Page({
  data: {
    energy: 0, totalEarned: 0,
    lv: null,               // spaceLevels.levelOf 结果
    sceneImg: '',
    planet: { ownedIds: [], growth: 0, feedCount: 0 },
    baseStage: null,
    baseNextText: '',
    sceneDecors: [],        // 场景上展示的已拥有旧装扮 [{id, emoji, name}]
    shopTab: 'supply',      // supply | decor（专属装扮）
    shopItems: [],
    buying: false,
    showHistory: false,
    levelHistory: [],
    basePct: 0,
    // 地图横幅：当前等级与下两站的节点图（已解锁彩色/未解锁灰）
    mapNodes: [], unlockedCount: 0
  },

  onShow() {
    this.syncGame()
    this.loadPlanet()
  },

  // ===== 等级与能量（login/submitAnswer 快照） =====
  syncGame() {
    const apply = (g) => {
      if (!g) return
      const total = Number(g.totalEarned || 0)
      const lv = sl.levelOf(total)
      this.setData({
        energy: Number(g.energy || 0), totalEarned: total, lv,
        sceneImg: lv.img,
        levelHistory: (g.levelHistory || []).slice().reverse().map(h => Object.assign({}, h, { atText: String(h.at || '').slice(0, 10) })),
        mapNodes: sl.LEVELS.slice(lv.level - 1, lv.level + 2).map(L => ({
          level: L.level, name: L.name, node: L.node, unlocked: L.level <= lv.level
        })),
        unlockedCount: lv.level
      })
    }
    const s = store.getState()
    apply(s.gamification)
    if (cloud.isCloudReady()) auth.syncGamification().then(apply).catch(() => {})
  },

  onSceneError() {
    const lv = this.data.lv
    if (!lv) return
    const fb = lv.level >= 5 ? '/images/space/lv9.jpg' : '/images/space/lv1.jpg'
    if (this.data.sceneImg !== fb) this.setData({ sceneImg: fb })
  },

  // ===== 星球数据 =====
  loadPlanet() {
    if (cloud.isCloudReady()) {
      auth.ensureStudentId().then(() => cloud.call('farm', { action: 'getPlanet' })).then(r => {
        this.applyPlanet(r.planet || { ownedIds: [], growth: 0, feedCount: 0 }, r.legacyPartners || [], r.legacyDecors || [])
        if (typeof r.energy === 'number') this.setData({ energy: r.energy })
      }).catch(() => this.applyLocalPlanet())
    } else {
      this.applyLocalPlanet()
    }
  },

  applyLocalPlanet() {
    const farms = store.getFarms()
    const legacyPartners = []
    const legacyDecors = []
    Object.keys(farms).forEach(sub => {
      if (sub === '星球') return
      const f = farms[sub]
      if (f.animalOwned) {
        const a = fd.animalOf(sub)
        legacyPartners.push({ subject: sub, emoji: a.emoji, name: a.name, kind: a.kind, growth: f.growth || 0, stageName: fd.stageOf(f.growth || 0).name })
      }
      ;(f.decorIds || []).forEach(id => { if (legacyDecors.indexOf(id) < 0) legacyDecors.push(id) })
    })
    const pf = store.ensureLocalFarm('星球')
    this.applyPlanet({ ownedIds: pf.decorIds || [], growth: pf.growth || 0, feedCount: pf.feedCount || 0 }, legacyPartners, legacyDecors)
  },

  applyPlanet(planet, legacyPartners, legacyDecors) {
    this._legacyDecors = legacyDecors
    const ownedAll = (planet.ownedIds || []).concat(legacyDecors)
    const sceneDecors = fd.SPACE_DECORS.filter(d => ownedAll.indexOf(d.id) >= 0)
    const baseStage = fd.baseStageOf(planet.growth || 0)
    const baseLower = fd.BASE_STAGES[baseStage.index].min
    const basePct = baseStage.next ? Math.min(100, Math.max(0, Math.round(((planet.growth || 0) - baseLower) / (baseStage.next.min - baseLower) * 100))) : 100
    this.setData({
      planet, sceneDecors, baseStage, basePct,
      baseNextText: baseStage.next ? ('距' + baseStage.next.name + '还差 ' + Math.max(0, baseStage.next.min - baseStage.growth) + ' 成长') : '基地已臻巅峰 ✨'
    })
    this.refreshShop()
  },

  // ===== 星际商城 =====
  onShopTab(e) {
    this.setData({ shopTab: e.currentTarget.dataset.tab })
    this.refreshShop()
  },

  refreshShop() {
    const tab = this.data.shopTab
    const owned = this.data.planet.ownedIds || []
    const legacy = this._legacyDecors || []
    let items = []
    if (tab === 'supply') {
      items = fd.SPACE_SUPPLIES.map(sp => Object.assign({}, sp, { owned: false, btn: sp.price + ' ⚡ 使用' }))
    } else {
      const curLevel = (this.data.lv && this.data.lv.level) || 1
      items = fd.SPACE_SIGNS.map(g => {
        const L = sl.LEVELS[g.level - 1]
        const has = owned.indexOf(g.id) >= 0
        const locked = g.level > curLevel
        return Object.assign({}, g, {
          img: L.node, planetName: 'Lv.' + g.level + ' ' + L.name,
          owned: has, locked,
          btn: has ? '已拥有' : (locked ? ('Lv.' + g.level + ' 解锁') : (g.price + ' ⚡ 兑换'))
        })
      })
    }
    this.setData({ shopItems: items })
  },

  onBuy(e) {
    const id = e.currentTarget.dataset.id
    const item = fd.spaceItemOf(id)
    if (!item || this.data.buying) return
    if (item.kind === 'sign' && item.level > ((this.data.lv && this.data.lv.level) || 1)) {
      wx.showToast({ title: '先解锁 Lv.' + item.level + ' 才能装扮它', icon: 'none' }); return
    }
    if (item.kind !== 'supply' && String(e.currentTarget.dataset.owned) === '1') return
    this.setData({ buying: true })
    const finish = (ok, msg, energy) => {
      this.setData({ buying: false })
      wx.showToast({ title: msg, icon: ok ? 'success' : 'none' })
      if (ok) {
        if (typeof energy === 'number') this.setData({ energy })
        this.loadPlanet()
      }
    }
    if (cloud.isCloudReady()) {
      auth.ensureStudentId().then(() => cloud.call('farm', { action: 'buySpaceItem', itemId: id })).then(r => {
        const g = r.planet ? Number(r.planet.growth || 0) : null
        finish(true, item.kind === 'supply' ? ('补给完成，基地成长已提升至 ' + (g !== null ? g : '')) : '兑换成功！', r.energy)
      }).catch(err => {
        const m = (err && err.message) || '兑换失败，请重试'
        finish(false, m.length > 24 ? m.slice(0, 24) : m)
      })
    } else {
      // 本地降级：扣本地能量并更新本地星球行
      const owned = this.data.planet.ownedIds || []
      const legacy = this._legacyDecors || []
      if (item.kind !== 'supply' && owned.indexOf(id) >= 0) { finish(false, '已经拥有啦'); return }
      const r = store.localFarmSpend(item.price, (item.kind === 'supply' ? '能量补给·' : '星球装扮·') + item.name)
      if (!r.ok) { finish(false, '星能量不足，还差 ' + r.need + ' ⚡'); return }
      const pf = store.ensureLocalFarm('星球')
      if (item.kind === 'supply') { pf.growth = (pf.growth || 0) + (item.growth || 0); pf.feedCount = (pf.feedCount || 0) + 1 }
      else pf.decorIds = (pf.decorIds || []).concat([id])
      const farms = store.getFarms(); farms['星球'] = pf; store.saveFarms(farms)
      const s = store.getState()
      finish(true, item.kind === 'supply' ? ('补给完成，基地成长已提升至 ' + (pf.growth || 0)) : '兑换成功！', s.gamification.energy)
    }
  },

  goSceneDetail() {
    const lv = this.data.lv
    if (lv) wx.navigateTo({ url: '/pages/planetdetail/planetdetail?level=' + lv.level })
  },

  goAtlas() { wx.navigateTo({ url: '/pages/atlas/atlas' }) },
  toggleHistory() { this.setData({ showHistory: !this.data.showHistory }) },
  goPoints() { wx.navigateTo({ url: '/pages/points/points' }) },
  goEarn() { wx.switchTab({ url: '/pages/index/index' }) }
})
