/**
 * 用户资料设置页 —— 首次登录引导 / 从"我"页进入编辑
 *
 * 微信官方头像昵称填写能力（2021 年后无法静默获取真实头像昵称）：
 *   - <button open-type="chooseAvatar" bindchooseavatar> 选微信头像或相册图片
 *   - <input type="nickname"> 让用户确认/输入昵称
 * 头像先上传云存储拿 fileID，再随昵称一起写入 zx_users（用户管理模块）。
 */
const cloud = require('../../utils/cloud.js')
const auth = require('../../utils/auth.js')

Page({
  data: {
    from: 'edit',        // guide=首次引导 | edit=从"我"页进入
    nickname: '',
    avatar: '',
    avatarLocal: '',     // 未上传前的本地临时路径（用于预览）
    role: 'student',
    saving: false,
    canSave: false,
    cloudReady: false
  },

  onLoad(options) {
    this.setData({
      from: (options && options.from) === 'guide' ? 'guide' : 'edit',
      cloudReady: cloud.isCloudReady()
    })
    // 先读本地缓存，立即回填；再从云端同步最新资料
    const p = auth.getProfile()
    if (p) this.applyProfile(p)
    if (cloud.isCloudReady()) {
      auth.syncProfile().then(profile => {
        if (profile) this.applyProfile(profile)
      }).catch(() => {})
    }
  },

  applyProfile(p) {
    this.setData({
      nickname: p.nickname || '',
      avatar: p.avatar || '',
      avatarLocal: p.avatar || '',
      role: p.role || 'student'
    })
    this.checkCanSave()
  },

  // 选择头像：微信回调给出临时文件路径
  onChooseAvatar(e) {
    const url = e.detail.avatarUrl
    if (!url) return
    this.setData({ avatarLocal: url })
    this.checkCanSave()
  },

  // 昵称输入
  onNicknameInput(e) {
    this.setData({ nickname: e.detail.value || '' })
    this.checkCanSave()
  },

  checkCanSave() {
    const d = this.data
    // 昵称和头像至少有一个变化/填写即可保存；首次引导需填昵称
    const ok = !!(d.nickname && d.nickname.trim()) || !!d.avatarLocal
    this.setData({ canSave: ok })
  },

  async save() {
    const d = this.data
    if (d.saving) return
    if (!d.nickname.trim() && !d.avatarLocal) {
      wx.showToast({ title: '请填写昵称或选择头像', icon: 'none' })
      return
    }
    if (!cloud.isCloudReady()) {
      wx.showToast({ title: '云开发未就绪，无法保存', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    wx.showLoading({ title: '保存中…', mask: true })
    try {
      let avatarFileId = d.avatar // 默认沿用已有云端头像
      // 本地临时路径（新选的头像）→ 上传云存储
      if (d.avatarLocal && d.avatarLocal !== d.avatar) {
        avatarFileId = await this.uploadAvatar(d.avatarLocal)
      }
      const patch = {}
      if (d.nickname.trim()) patch.nickname = d.nickname.trim()
      if (avatarFileId) patch.avatar = avatarFileId
      await auth.updateProfile(patch)
      wx.hideLoading()
      this.setData({ saving: false, avatar: avatarFileId, avatarLocal: avatarFileId })
      wx.showToast({ title: '已保存到用户管理', icon: 'success' })
      setTimeout(() => {
        if (d.from === 'guide') {
          wx.switchTab({ url: '/pages/index/index' })
        } else {
          wx.navigateBack()
        }
      }, 800)
    } catch (e) {
      wx.hideLoading()
      this.setData({ saving: false })
      wx.showToast({ title: (e && e.message) || '保存失败，请重试', icon: 'none' })
    }
  },

  // 上传头像到云存储，返回 fileID
  uploadAvatar(localPath) {
    return new Promise((resolve, reject) => {
      const ext = (localPath.match(/\.(\w+)($|\?)/) || [])[1] || 'png'
      const cloudPath = 'avatars/' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext
      wx.cloud.uploadFile({
        cloudPath,
        filePath: localPath,
        success: res => resolve(res.fileID),
        fail: err => reject({ message: (err && err.errMsg) || '头像上传失败' })
      })
    })
  },

  skip() {
    auth.markProfileDone()
    wx.switchTab({ url: '/pages/index/index' })
  }
})
