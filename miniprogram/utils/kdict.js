'use strict'
/**
 * 知识点字典（前端）：从 recognize 的 knowledgeDict 动作拉取受控词表并本地缓存。
 * 用途：①把题目里的字典代码翻译成中文名展示（nameOf）；②校对编辑器里的点选器数据（blocks）。
 * 字典不存在的学科返回空，nameOf 原样返回标签，不影响其他学科。
 */
const cloud = require('./cloud.js')
const KEY = 'zx_kdict_v1'
const mem = {} // subject -> { version, items, byCode }
let loading = {}

function _index(subject, version, items) {
  const byCode = {}
  ;(items || []).forEach(it => { if (it && it.code) byCode[it.code] = it })
  mem[subject] = { version: version || '', items: items || [], byCode }
  return mem[subject]
}

function _fromStorage(subject) {
  if (mem[subject]) return mem[subject]
  try {
    const all = wx.getStorageSync(KEY) || {}
    const s = all[subject]
    if (s && Array.isArray(s.items) && s.items.length) return _index(subject, s.version, s.items)
  } catch (e) {}
  return null
}

/** 拉取字典（内存/本地缓存先行，云端刷新在后台）；返回 Promise<{version, items}> */
function load(subject) {
  subject = subject || '英语'
  const hit = _fromStorage(subject)
  if (!loading[subject]) {
    loading[subject] = cloud.call('recognize', { action: 'knowledgeDict', subject })
      .then(r => {
        if (r && r.code === 0 && Array.isArray(r.items) && r.items.length) {
          _index(subject, r.version, r.items)
          try {
            const all = wx.getStorageSync(KEY) || {}
            all[subject] = { version: r.version || '', at: Date.now(), items: r.items }
            wx.setStorageSync(KEY, all)
          } catch (e) {}
        }
        return mem[subject] || { version: '', items: [] }
      })
      .catch(() => mem[subject] || { version: '', items: [] })
      .then(v => { delete loading[subject]; return v })
  }
  return hit ? Promise.resolve(hit) : loading[subject]
}

/** 代码 → 中文名；不是字典代码时返回 null（调用方决定回退） */
function nameOf(subject, tag) {
  const d = _fromStorage(subject || '英语')
  if (!d) return null
  const it = d.byCode[tag]
  return it ? it.name : null
}

function isCode(subject, tag) {
  const d = _fromStorage(subject || '英语')
  return !!(d && d.byCode[tag])
}

const ALL_SUBJECTS = ['英语', '数学', '语文', '生物', '历史', '地理', '道德与法治', '物理', '化学']
/** 不分学科地把代码翻译成中文名（代码空间不重叠时安全）；找不到返回 null */
function nameOfAny(tag) {
  for (let i = 0; i < ALL_SUBJECTS.length; i++) {
    const n = nameOf(ALL_SUBJECTS[i], tag)
    if (n) return n
  }
  return null
}

function isCodeAny(tag) {
  for (let i = 0; i < ALL_SUBJECTS.length; i++) {
    if (isCode(ALL_SUBJECTS[i], tag)) return true
  }
  return false
}

/** 点选器数据：[{ block, items: [{code, name}] }] */
function blocks(subject) {
  const d = _fromStorage(subject || '英语')
  if (!d) return []
  const out = []
  const seen = {}
  d.items.forEach(it => {
    if (!seen[it.block]) { seen[it.block] = { block: it.block, items: [] }; out.push(seen[it.block]) }
    seen[it.block].items.push(it)
  })
  return out
}

module.exports = { load, nameOf, isCode, blocks, nameOfAny, isCodeAny, ALL_SUBJECTS }
