/**
 * 积分规则与晋级路线（2.0 口径）：等级按累计星能量（total_earned）由 spaceLevels 计算，
 * 与首页宇宙卡、探索页完全一致；消费只扣余额、不掉级。
 */
const store = require('../../utils/store.js')
const cloud = require('../../utils/cloud.js')
const auth = require('../../utils/auth.js')
const sl = require('../../utils/spaceLevels.js')

const RULES = [
  { img: '/images/icons/target.png', bg: '#e7f8e9', title: '答对一道题', delta: '+2', desc: '客观题自动判分，主观题经 AI 批改或自评通过' },
  { img: '/images/icons/flag.png', bg: '#eef0ff', title: '完成一科每日打卡', delta: '+20', desc: '当天该科的打卡题目全部作答完毕' },
  { img: '/images/icons/medal.png', bg: '#fdecec', title: '攻克一道错题', delta: '+30', desc: '错题重刷连续答对、复习达标后即攻克，当场发放' },
  { img: '/images/icons/bolt.png', bg: '#fff3de', title: '能量消费', delta: '消费', desc: '在探索页商城兑换能量补给与星球装扮，只扣余额' }
]

Page({
  data: {
    energy: 0, totalEarned: 0, streak: 0,
    lv: null, lvNode: '',
    rules: RULES,
    path: [],
    ledger: []
  },
  onShow() { this.refresh() },

  compute() {
    const s = store.getState()
    const g = s.gamification || {}
    const total = Number(g.totalEarned || 0)
    const lv = sl.levelOf(total)
    const cur = sl.LEVELS[lv.level - 1]
    this.setData({
      energy: Number(g.energy || 0), totalEarned: total, streak: g.streak || 0,
      lv, lvNode: cur ? cur.node : '',
      path: sl.LEVELS.map(L => ({
        level: L.level, name: L.name, node: L.node, min: L.min,
        reached: total >= L.min, current: L.level === lv.level
      })),
      ledger: (g.energyLedger || []).slice().reverse().slice(0, 8)
    })
  },

  refresh() {
    this.compute()
    // 云端账本同步后重算（等级/余额以云端快照为准）
    if (cloud.isCloudReady()) {
      auth.ensureStudentId().then(() => cloud.call('login', {})).then(r => {
        if (r && r.gamification) {
          store.applyCloudGamification(store.getState(), r.gamification)
          this.compute()
        }
        if (r && r.energyLedger && r.energyLedger.length) {
          this.setData({ ledger: r.energyLedger.slice().reverse().slice(0, 8) })
        }
      }).catch(() => {})
    }
  },

  goExplore() { wx.switchTab({ url: '/pages/planet/planet' }) }
})
