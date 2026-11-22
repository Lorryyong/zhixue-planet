const settings = require('../../utils/settings.js')
const store = require('../../utils/store.js')
const auth = require('../../utils/auth.js')

const RELATIONS = ['妈妈', '爸爸', '爷爷', '奶奶', '外公', '外婆', '其他监护人']

Page({
  data: {
    bound: false, guardian: '', relation: '妈妈', phone: '',
    weekly: false, weeklyDay: '周日', boundAt: '',
    inputGuardian: '', inputPhone: '',
    relations: RELATIONS, relationIndex: 0,
    weekDays: ['周一', '周日', '周六'],
    weekDayIndex: 1,
    report: null,
    saving: false
  },
  onShow() {
    settings.load().then(s => this.apply(s))
  },
  apply(s) {
    const p = s.parent || {}
    const ri = Math.max(0, RELATIONS.indexOf(p.relation || '妈妈'))
    let wdi = Math.max(0, this.data.weekDays.indexOf(p.weeklyDay || '周日'))
    this.setData({
      bound: !!p.bound, guardian: p.guardian || '', relation: p.relation || '妈妈',
      phone: p.phone || '', weekly: !!p.weekly, weeklyDay: p.weeklyDay || '周日', boundAt: p.boundAt || '',
      inputGuardian: p.guardian || '', inputPhone: p.phone || '',
      relationIndex: ri, weekDayIndex: wdi
    })
    this.buildReport()
  },
  // 基于本地学习数据生成本周周报预览
  buildReport() {
    const s = store.getState()
    const g = s.gamification || {}
    const mastery = s.mastery || {}
    const weak = Object.entries(mastery).filter(([id, m]) => (m.score || 0) < 75).sort((a, b) => a[1].score - b[1].score).slice(0, 5)
    const weakList = weak.map(([id, m]) => ({ name: store.kName(id), score: m.score }))
    const wrongActive = (s.wrongbook || []).filter(w => w.status === 'active').length
    const conquered = (s.wrongbook || []).filter(w => w.status === 'conquered').length
    const acc = store.weekAccuracy(s)
    this.setData({
      report: {
        energy: g.energy || 0, streak: g.streak || 0,
        checkins: (g.checkinDates || []).length, acc,
        weakList, wrongActive, conquered,
        hasData: !!(g.energy || Object.keys(mastery).length)
      }
    })
  },
  onGuardian(e) { this.setData({ inputGuardian: e.detail.value }) },
  onPhone(e) { this.setData({ inputPhone: e.detail.value }) },
  onRelation(e) {
    const i = Number(e.detail.value)
    this.setData({ relationIndex: i, relation: this.data.relations[i] })
  },
  onWeekDay(e) {
    const i = Number(e.detail.value)
    this.setData({ weekDayIndex: i, weeklyDay: this.data.weekDays[i] })
  },
  onWeekly() { this.setData({ weekly: !this.data.weekly }) },
  bind() {
    const g = this.data.inputGuardian.trim()
    const phone = this.data.inputPhone.trim()
    if (!g) { wx.showToast({ title: '请填写监护人称呼', icon: 'none' }); return }
    if (phone && !/^1\d{10}$/.test(phone)) { wx.showToast({ title: '手机号格式不正确', icon: 'none' }); return }
    this.setData({ saving: true })
    const patch = {
      bound: true, guardian: g, relation: this.data.relation, phone,
      weekly: this.data.weekly, weeklyDay: this.data.weeklyDay,
      boundAt: this.data.boundAt || new Date().toISOString()
    }
    settings.update('parent', patch).then(() => {
      this.setData({ saving: false })
      this.apply(settings.cached())
      wx.showToast({ title: '家长绑定成功', icon: 'success' })
    })
  },
  saveSubscription() {
    const p = settings.cached().parent || {}
    settings.update('parent', Object.assign({}, p, { weekly: this.data.weekly, weeklyDay: this.data.weeklyDay })).then(() => {
      this.apply(settings.cached())
      wx.showToast({ title: this.data.weekly ? '已订阅周报' : '已取消订阅', icon: 'success' })
    })
  },
  unbind() {
    wx.showModal({
      title: '解除绑定', content: '解除后家长将无法查看周报，确定吗？',
      success: (res) => {
        if (!res.confirm) return
        settings.update('parent', settings.defaults().parent).then(() => {
          this.apply(settings.cached())
          wx.showToast({ title: '已解除绑定', icon: 'success' })
        })
      }
    })
  }
})
