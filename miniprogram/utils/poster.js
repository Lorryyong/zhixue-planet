// 分享卡海报：旧版 canvas 绘制（只用已在真机验证过的 fillRect/fillText/线性渐变/arc，
// 不用 radialGradient/ellipse/drawImage 本地路径——旧版 CanvasContext 上不可靠）。
// 页面需放一个隐藏 canvas（canvas-id 与调用时一致），draw 完成后回调里再 canvasToTempFilePath。
function drawShareCard(ctx, opts) {
  const W = 750, H = 1000
  const grad = ctx.createLinearGradient(0, 0, W, H)
  grad.addColorStop(0, '#2b3a8f')
  grad.addColorStop(0.55, '#5b6cf6')
  grad.addColorStop(1, '#8a5cf6')
  ctx.setFillStyle(grad)
  ctx.fillRect(0, 0, W, H)
  // 装饰星点（固定坐标，避免随机导致每次不同）
  const stars = [[80, 120], [660, 90], [590, 210], [120, 300], [690, 420], [60, 560], [640, 700], [150, 820], [520, 120], [330, 70]]
  ctx.setFillStyle('rgba(255,255,255,0.5)')
  stars.forEach(function (p) { ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, 2 * Math.PI); ctx.fill() })
  // 顶部品牌
  ctx.setFillStyle('#ffffff')
  ctx.setFontSize(30)
  ctx.fillText('智学星球', 56, 92)
  ctx.setFillStyle('rgba(255,255,255,0.75)')
  ctx.setFontSize(24)
  ctx.fillText('探索宇宙，始于知识', 56, 132)
  // 标题与主数字
  ctx.setFillStyle('#ffffff')
  ctx.setFontSize(40)
  ctx.fillText(opts.title || '', 56, 250)
  ctx.setFontSize(110)
  ctx.fillText(String(opts.big == null ? '' : opts.big), 56, 390)
  ctx.setFontSize(28)
  ctx.setFillStyle('rgba(255,255,255,0.85)')
  ctx.fillText(opts.bigLabel || '', 58, 445)
  // 数据行
  let y = 560
  ;(opts.lines || []).forEach(function (ln) {
    ctx.setFillStyle('rgba(255,255,255,0.65)')
    ctx.setFontSize(26)
    ctx.fillText(ln[0], 56, y)
    ctx.setFillStyle('#ffffff')
    ctx.setFontSize(34)
    ctx.fillText(String(ln[1]), 300, y)
    y += 74
  })
  // 底部
  ctx.setFillStyle('rgba(255,255,255,0.55)')
  ctx.setFontSize(22)
  ctx.fillText(opts.footer || '', 56, H - 56)
  ctx.draw()
}

// 画完后导出图片并打开系统分享菜单（不支持时降级为预览长按保存）
function shareCanvasImage(page, canvasId, opts) {
  const ctx = wx.createCanvasContext(canvasId, page)
  drawShareCard(ctx, opts)
  setTimeout(function () {
    wx.canvasToTempFilePath({
      canvasId, width: 750, height: 1000, destWidth: 750, destHeight: 1000,
      success: function (res) {
        if (wx.showShareImageMenu) {
          wx.showShareImageMenu({ path: res.tempFilePath, fail: function () { wx.previewImage({ urls: [res.tempFilePath] }) } })
        } else {
          wx.previewImage({ urls: [res.tempFilePath] })
        }
      },
      fail: function () { wx.showToast({ title: '生成失败，请重试', icon: 'none' }) }
    }, page)
  }, 350)
}

module.exports = { drawShareCard, shareCanvasImage }
