const sl = require('../../utils/spaceLevels')
const store = require('../../utils/store')
const cloud = require('../../utils/cloud.js')
const auth = require('../../utils/auth.js')
const fd = require('../../utils/farmData.js')

// 宇宙探索地图（DOM 版）：节点是普通 image 视图，整张世界图用 transform 平移/缩放。
// 不用 canvas 画图片——旧版 canvas 的 drawImage 在真机上不可靠（图片不显示）。
const POS = [
  [150, 1520], [430, 1400], [770, 1460], [990, 1190], [700, 1030], [370, 1110],
  [190, 840], [480, 650], [840, 730], [1020, 460], [690, 260], [330, 130]
]
const WORLD_W = 1200, WORLD_H = 1700
const radiusFor = (level) => 34 + level * 7 // 世界坐标半径：等级越高越大

const SEGS = []
for (let i = 0; i < POS.length - 1; i++) {
  const dx = POS[i + 1][0] - POS[i][0], dy = POS[i + 1][1] - POS[i][1]
  SEGS.push({ x: POS[i][0], y: POS[i][1], len: Math.round(Math.hypot(dx, dy)), ang: (Math.atan2(dy, dx) * 180 / Math.PI).toFixed(2) })
}
const STARS = []
let _seed = 4242
const _rnd = () => { _seed = (_seed * 9301 + 49297) % 233280; return _seed / 233280 }
for (let i = 0; i < 110; i++) {
  STARS.push({ x: Math.round(_rnd() * WORLD_W), y: Math.round(_rnd() * WORLD_H), s: (1 + _rnd() * 3).toFixed(1), a: (0.25 + _rnd() * 0.55).toFixed(2) })
}

Page({
  data: {
    totalEarned: 0,
    curLevel: 1,
    sel: null,
    viewH: 520,
    tx: 0, ty: 0, scale: 0.325,
    worldW: WORLD_W, worldH: WORLD_H,
    nodes: [],
    segs: SEGS,
    stars: STARS
  },

  onLoad() {
    const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this._w = win.windowWidth
    const viewH = Math.round(win.windowHeight * 0.62)
    this._scale = this._w / WORLD_W
    this._tx = 0
    this._ty = viewH - WORLD_H * this._scale
    this.setData({ viewH, tx: this._tx, ty: this._ty, scale: this._scale })
  },

  onShow() {
    const s = store.getState()
    const total = Number((s.gamification || {}).totalEarned || 0)
    const cur = sl.levelOf(total).level
    this._cur = cur
    this.setData({ totalEarned: total, curLevel: cur })
    this.buildNodes(this._ownedIds || [])
    if (!this.data.sel) this.selectLevel(cur, true)
    // 已购专属装扮：云端为准，失败/无云时读本地星球行
    if (cloud.isCloudReady()) {
      auth.ensureStudentId().then(() => cloud.call('farm', { action: 'getPlanet' })).then(r => {
        this._ownedIds = (r.planet && r.planet.ownedIds) || []
        this.buildNodes(this._ownedIds)
      }).catch(() => this.loadLocalSigns())
    } else {
      this.loadLocalSigns()
    }
  },

  loadLocalSigns() {
    const farms = store.getFarms()
    const pf = farms['星球'] || {}
    this._ownedIds = pf.decorIds || []
    this.buildNodes(this._ownedIds)
  },

  buildNodes(ownedIds) {
    const cur = this._cur || this.data.curLevel || 1
    const nodes = sl.LEVELS.map((L, i) => {
      const R = radiusFor(L.level)
      const sign = fd.signOfLevel(L.level)
      const hasSign = !!(sign && ownedIds.indexOf(sign.id) >= 0)
      return {
        level: L.level, name: L.name, node: L.node,
        left: POS[i][0] - R, top: POS[i][1] - R, size: R * 2,
        labelTop: POS[i][1] + R + 12,
        unlocked: L.level <= cur, isCur: L.level === cur,
        signFx: hasSign ? sign.fx : '', signEmoji: hasSign ? sign.emoji : '',
        signFont: Math.round(R * 2 * 0.40)
      }
    })
    // 路径连线：两端节点都已解锁的段点亮（实线亮蓝），未解锁保持虚线暗色
    const segs = SEGS.map((sg, i) => Object.assign({}, sg, { lit: (i + 2) <= cur }))
    this.setData({ nodes, segs })
  },

  goDetail() {
    if (this.data.sel) wx.navigateTo({ url: '/pages/planetdetail/planetdetail?level=' + this.data.sel.level })
  },

  applyView() {
    this._lastSetAt = Date.now()
    this.setData({ tx: this._tx, ty: this._ty, scale: this._scale })
  },
  applyViewSoon() {
    const now = Date.now()
    if (this._lastSetAt && now - this._lastSetAt < 33) {
      if (!this._viewTimer) {
        this._viewTimer = setTimeout(() => { this._viewTimer = null; this.applyView() }, 40)
      }
      return
    }
    this.applyView()
  },

  selectLevel(level, silent) {
    const L = sl.LEVELS[level - 1]
    const cur = this.data.curLevel
    const state = L.level < cur ? '已解锁' : (L.level === cur ? '当前坐标' : '未解锁')
    const need = L.level > cur ? ('累计星能量达到 ' + L.min + ' 解锁 · 你还差 ' + Math.max(0, L.min - this.data.totalEarned)) : ('解锁门槛：累计星能量 ' + L.min)
    this.setData({ sel: Object.assign({}, L, { state, need }) })
  },

  onNodeTap(e) {
    if (Date.now() < (this._tapBlockUntil || 0)) return // 刚拖动完，别误选
    this.selectLevel(Number(e.currentTarget.dataset.level))
  },

  zoomBy(factor) {
    const cx = this._w / 2, cy = this.data.viewH / 2
    const ns = Math.min(1.6, Math.max(this._w / WORLD_W * 0.8, this._scale * factor))
    const k = ns / this._scale
    this._tx = cx - (cx - this._tx) * k
    this._ty = cy - (cy - this._ty) * k
    this._scale = ns
    this.applyView()
  },
  onZoomIn() { this.zoomBy(1.3) },
  onZoomOut() { this.zoomBy(1 / 1.3) },
  onZoomReset() {
    this._scale = this._w / WORLD_W
    this._tx = 0
    this._ty = this.data.viewH - WORLD_H * this._scale
    this.applyView()
  },

  // ===== 触摸：单指拖动 / 双指缩放（点选由节点自己的 bindtap 处理） =====
  onTouchStart(e) {
    const ts = e.touches
    if (ts.length === 2) {
      const dx = ts[0].x - ts[1].x, dy = ts[0].y - ts[1].y
      this._pinch = {
        d: Math.hypot(dx, dy),
        cx: (ts[0].x + ts[1].x) / 2, cy: (ts[0].y + ts[1].y) / 2,
        scale: this._scale, tx: this._tx, ty: this._ty
      }
      this._drag = null
    } else if (ts.length === 1) {
      this._drag = { x: ts[0].x, y: ts[0].y, tx: this._tx, ty: this._ty, moved: false }
      this._pinch = null
    }
  },

  onTouchMove(e) {
    const ts = e.touches
    if (this._pinch && ts.length === 2) {
      const dx = ts[0].x - ts[1].x, dy = ts[0].y - ts[1].y
      const d = Math.hypot(dx, dy)
      if (d > 10 && this._pinch.d > 0) {
        const ns = Math.min(1.6, Math.max(this._w / WORLD_W * 0.8, this._pinch.scale * d / this._pinch.d))
        const wxp = (this._pinch.cx - this._pinch.tx) / this._pinch.scale
        const wyp = (this._pinch.cy - this._pinch.ty) / this._pinch.scale
        const ncx = (ts[0].x + ts[1].x) / 2, ncy = (ts[0].y + ts[1].y) / 2
        this._tx = ncx - wxp * ns
        this._ty = ncy - wyp * ns
        this._scale = ns
        this._moved = true
        this.applyViewSoon()
      }
    } else if (this._drag && ts.length === 1) {
      const t = ts[0]
      const mdx = t.x - this._drag.x, mdy = t.y - this._drag.y
      if (Math.abs(mdx) + Math.abs(mdy) > 6) { this._drag.moved = true; this._moved = true }
      this._tx = this._drag.tx + mdx
      this._ty = this._drag.ty + mdy
      this.applyViewSoon()
    }
  },

  onTouchEnd() {
    if (this._moved) this._tapBlockUntil = Date.now() + 300
    this._moved = false
    this._drag = null
    this._pinch = null
    this.applyView()
  }
})
