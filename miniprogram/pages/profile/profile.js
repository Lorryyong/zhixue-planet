/**
 * 用户资料设置页 —— 首次登录引导 / 从"我"页进入编辑
 *
 * 微信官方头像填写能力（2021 年后无法静默获取真实头像）：
 *   - <button open-type="chooseAvatar" bindchooseavatar> 选微信头像或相册图片
 * 昵称用普通 input 手动填写（type=nickname 输入框在真机会与主输入框抢焦点，已弃用）。
 * 头像先上传云存储拿 fileID，再随昵称一起写入 zx_users（用户管理模块）。
 */
const cloud = require('../../utils/cloud.js')
const auth = require('../../utils/auth.js')
const grade = require('../../utils/grade.js')

Page({
  data: {
    from: 'edit',        // guide=首次引导 | edit=从"我"页进入
    nickname: '',
    avatar: '',
    avatarLocal: '',     // 未上传前的本地临时路径（用于预览）
    role: 'student',
    saving: false,
    canSave: false,
    cloudReady: false,
    gradeOptions: grade.GRADES,   // 年级选择器选项
    gradeIndex: -1,                // 当前选中的年级序号(1-12)，-1=未设置
    gradeLabel: '',                // 展示用年级文字（已按当前学年自动升级）
    gradeBaseYear: 0               // 设置时的学年基准
  },

  onLoad(options) {
    // 记录用户是否已手动改过某字段：异步拉取云端资料时，绝不覆盖用户正在编辑的内容
    this._edited = { nickname: false, avatar: false, grade: false }
    this.setData({
      from: (options && options.from) === 'guide' ? 'guide' : 'edit',
      cloudReady: cloud.isCloudReady()
    })
    // 先读本地缓存，立即回填；再从云端同步最新资料（此时用户可能已在输入）
    const p = auth.getProfile()
    if (p) this.applyProfile(p)
    if (cloud.isCloudReady()) {
      auth.syncProfile().then(profile => {
        if (profile) this.applyProfile(profile)
      }).catch(() => {})
    }
  },

  applyProfile(p) {
    const gi = Number(p.grade_index) || 0
    const by = Number(p.grade_base_year) || 0
    const curIdx = gi && by ? grade.currentIndex(gi, by) : gi
    const e = this._edited || {}
    // 只回填用户尚未手动编辑过的字段，避免异步云端响应把输入到一半的内容清空
    const patch = { role: p.role || 'student' }
    if (!e.nickname) patch.nickname = p.nickname || ''
    if (!e.avatar) {
      patch.avatar = p.avatar || ''
      patch.avatarLocal = p.avatar || ''
    }
    if (!e.grade) {
      patch.gradeIndex = curIdx > 0 && curIdx <= 12 ? curIdx : -1
      patch.gradeLabel = curIdx > 0 ? grade.labelOf(curIdx) : '请选择年级'
      patch.gradeBaseYear = by || grade.schoolYearNow()
    }
    this.setData(patch)
    this.checkCanSave()
  },

  // 年级选择：picker 返回的是数组下标(0-11)，年级序号=下标+1
  onGradeChange(e) {
    this._edited.grade = true
    const idx = Number(e.detail.value) + 1
    this.setData({
      gradeIndex: idx,
      gradeLabel: grade.labelOf(idx),
      gradeBaseYear: grade.schoolYearNow()
    })
    this.checkCanSave()
  },

  // 选择头像：微信回调给出临时文件路径
  onChooseAvatar(e) {
    const url = e.detail.avatarUrl
    if (!url) return
    this._edited.avatar = true
    this.setData({ avatarLocal: url })
    this.checkCanSave()
  },

  // 昵称输入：标准双向绑定。页面上唯一的输入框，无任何 type=nickname 组件抢焦点。
  onNicknameInput(e) {
    this._edited.nickname = true
    this.setData({ nickname: e.detail.value || '' })
    this.checkCanSave()
  },

  checkCanSave() {
    const d = this.data
    // 昵称/头像/年级至少填一项即可保存
    const ok = !!(d.nickname && d.nickname.trim()) || !!d.avatarLocal || d.gradeIndex > 0
    this.setData({ canSave: ok })
  },

  async save() {
    const d = this.data
    if (d.saving) return
    if (!d.nickname.trim() && !d.avatarLocal && d.gradeIndex <= 0) {
      wx.showToast({ title: '请填写昵称、选择头像或年级', icon: 'none' })
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
      if (d.gradeIndex > 0) {
        patch.grade_index = d.gradeIndex
        patch.grade_base_year = d.gradeBaseYear || grade.schoolYearNow()
      }
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
