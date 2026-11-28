const store = require('../../utils/store.js')
const cloud = require('../../utils/cloud.js')
const cloudStore = require('../../utils/cloudStore.js')
const auth = require('../../utils/auth.js')
const grade = require('../../utils/grade.js')
const sl = require('../../utils/spaceLevels.js')
const subscribe = require('../../utils/subscribe.js')

Page({
  data: {
    nickname: '', avatar: '', isAdminRole: false, needSetup: false, gradeLabel: '', level: 1, levelName: ''
  },
  onShow() {
    this.refresh()
    // 首次微信登录且未设置资料 → 引导去设置
    const mode = auth.getCachedMode()
    if (mode === 'openid' && auth.needProfileSetup()) this.guideProfile()
    // 从云端同步最新资料（换设备/他人修改后一致）
    if (cloud.isCloudReady()) {
      auth.syncProfile().then(p => { if (p) this.applyProfile(p) }).catch(() => {})
    }
  },
  applyProfile(p) {
    this.setData({
      nickname: p.nickname || '', avatar: p.avatar || '',
      isAdminRole: p.role === 'admin',
      gradeLabel: this.calcGrade(p)
    })
  },
  // 按当前学年计算年级（每年9月自动升级）
  calcGrade(p) {
    if (!p) return ''
    const gi = Number(p.grade_index) || 0
    const by = Number(p.grade_base_year) || 0
    if (!gi || !by) return ''
    return grade.currentLabel(gi, by)
  },
  refresh() {
    const s = store.getState()
    const mode = auth.getCachedMode()
    const p = auth.getProfile() || {}
    // 等级与星球名按累计获得计算，与首页宇宙卡、探索页同一口径
    const lv = sl.levelOf(Number(s.gamification.totalEarned || 0))
    this.setData({
      level: lv.level, levelName: lv.name,
      nickname: p.nickname || '', avatar: p.avatar || '',
      isAdminRole: p.role === 'admin',
      gradeLabel: this.calcGrade(p),
      needSetup: mode === 'openid' && auth.needProfileSetup()
    })
  },
  async onReminder() {
    if (!subscribe.isConfigured()) {
      wx.showModal({
        title: '每日打卡提醒', showCancel: false, confirmText: '知道了',
        content: '提醒功能正在开通中：需要在小程序后台申请订阅消息模板，通过后这里就能开启每天傍晚的打卡提醒。'
      })
      return
    }
    const r = await subscribe.requestDailyReminder()
    wx.showToast({ title: r.ok ? '已开启，明晚见' : '未开启提醒', icon: 'none' })
  },

  goProfile() { wx.navigateTo({ url: '/pages/profile/profile' }) },
  goStudyCard() { wx.navigateTo({ url: '/pages/studycard/studycard' }) },
  goParent() { wx.navigateTo({ url: '/pages/parent/parent' }) },
  goSubjects() { wx.navigateTo({ url: '/pages/subjects/subjects' }) },
  goEnergy() { wx.navigateTo({ url: '/pages/energy/energy' }) },
  goPoints() { wx.navigateTo({ url: '/pages/points/points' }) },
  goPrivacy() { wx.navigateTo({ url: '/pages/privacy/privacy' }) },
  guideProfile() {
    wx.showModal({
      title: '完善你的账号',
      content: '设置头像和昵称，方便老师同学认识你。现在去设置吗？',
      confirmText: '去设置',
      cancelText: '稍后',
      success: (res) => {
        if (res.confirm) wx.navigateTo({ url: '/pages/profile/profile?from=guide' })
        else auth.markProfileDone()
      }
    })
  },
  goConsole() { wx.navigateTo({ url: '/pages/adminconsole/adminconsole' }) }
})
