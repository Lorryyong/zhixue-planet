const settings = require('../../utils/settings.js')
const auth = require('../../utils/auth.js')

Page({
  data: {
    minorMode: false, allowAnalytics: false, allowPersonalization: false,
    identity: '本地演示身份', saving: false
  },
  onShow() {
    settings.load().then(s => {
      const p = s.privacy || {}
      this.setData({
        minorMode: !!p.minorMode, allowAnalytics: !!p.allowAnalytics,
        allowPersonalization: !!p.allowPersonalization
      })
    })
    const mode = auth.getCachedMode()
    this.setData({ identity: mode === 'openid' ? '微信身份（云端注入 openid）' : (mode === 'anonymous' ? '本地演示身份' : '未登录') })
  },
  onMinor() { this.setData({ minorMode: !this.data.minorMode }) },
  onAnalytics() { this.setData({ allowAnalytics: !this.data.allowAnalytics }) },
  onPersonalization() { this.setData({ allowPersonalization: !this.data.allowPersonalization }) },
  save() {
    this.setData({ saving: true })
    settings.update('privacy', {
      minorMode: this.data.minorMode,
      allowAnalytics: this.data.allowAnalytics,
      allowPersonalization: this.data.allowPersonalization,
      updatedAt: new Date().toISOString()
    }).then(() => {
      this.setData({ saving: false })
      wx.showToast({ title: '隐私设置已保存', icon: 'success' })
    })
  }
})
