/**
 * 行为埋点（v1.9.4）—— 非阻塞、失败静默、隐私优先。
 *
 * - 采集前读取 settings.privacy：minorMode=true 或 allowAnalytics=false → 不上报；
 * - 事件本地缓冲，达到阈值(5)或 App 切后台时批量 flush；
 * - 全程 fire-and-forget：任何异常都吞掉，绝不影响页面交互与主链路；
 * - 云端 trackEvent 会再做一次隐私兜底过滤。
 */
const cloud = require('./cloud.js')
const settings = require('./settings.js')

const BUF_KEY = 'zx_track_buf_v1'
const THRESHOLD = 5

function readBuf() {
  try { return wx.getStorageSync(BUF_KEY) || [] } catch (e) { return [] }
}
function writeBuf(arr) {
  try { wx.setStorageSync(BUF_KEY, (arr || []).slice(-50)) } catch (e) {}
}

function allowed() {
  try {
    const p = settings.cached().privacy || {}
    if (p.minorMode === true) return false
    if (p.allowAnalytics === false) return false
  } catch (e) { /* 读不到按允许处理（默认 allowAnalytics=false 会拦，见 settings.defaults） */ }
  return true
}

/** 记录一个事件（同步、极轻） */
function event(name, props) {
  try {
    if (!name || !allowed()) return
    const buf = readBuf()
    buf.push({
      event: String(name).slice(0, 40),
      ts: new Date().toISOString(),
      props: props || {}
    })
    writeBuf(buf)
    if (buf.length >= THRESHOLD) flush()
  } catch (e) { /* 埋点绝不抛错 */ }
}

/** 批量上报（非阻塞，失败静默保留缓冲下次重试） */
function flush() {
  try {
    if (!cloud.isCloudReady()) { writeBuf([]); return }
    const buf = readBuf()
    if (!buf.length) return
    const batch = buf.slice(0, 20)
    cloud.call('trackEvent', { events: batch })
      .then(function () { writeBuf(readBuf().slice(batch.length)) })
      .catch(function () { /* 保留缓冲，下次再试 */ })
  } catch (e) { /* 静默 */ }
}

module.exports = { event, flush }
