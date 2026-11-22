const settings = require('../../utils/settings.js')

// 学科 → 可选教材版本
const SUBJECT_BOOKS = {
  '语文': ['人教版', '部编版', '北师大版', '苏教版', '语文版'],
  '数学': ['人教版', '北师大版', '华师大版', '苏科版', '沪科版'],
  '英语': ['人教版', '外研版', '译林版', '沪教版', '北师大版'],
  '物理': ['人教版', '沪科版', '苏科版', '北师大版'],
  '化学': ['人教版', '沪教版', '苏教版', '鲁科版'],
  '生物': ['人教版', '北师大版', '苏教版', '济南版'],
  '历史': ['部编版', '人教版', '北师大版', '华东师大版'],
  '地理': ['人教版', '湘教版', '鲁教版', '苏教版'],
  '道德与法治': ['部编版', '人教版']
}
const ALL_SUBJECTS = Object.keys(SUBJECT_BOOKS)

Page({
  data: {
    list: [],           // {name, checked, textbook, versions, versionIndex}
    saving: false
  },
  onShow() {
    settings.load().then(s => this.apply(s.subjects || []))
  },
  apply(saved) {
    const map = {}
    ;(saved || []).forEach(x => {
      if (x && x.name) map[x.name] = x
    })
    // 已勾选的排在前面，未勾选的默认版本为第一项
    const list = ALL_SUBJECTS.map(name => {
      const cfg = map[name] || {}
      const versions = SUBJECT_BOOKS[name]
      const checked = !!cfg.checked
      const textbook = cfg.textbook || versions[0]
      return {
        name, checked, textbook, versions,
        versionIndex: Math.max(0, versions.indexOf(textbook))
      }
    })
    this.setData({ list })
  },
  onCheck(e) {
    const i = Number(e.currentTarget.dataset.i)
    const list = this.data.list.slice()
    list[i] = Object.assign({}, list[i], { checked: !list[i].checked })
    this.setData({ list })
  },
  onVersion(e) {
    const i = Number(e.currentTarget.dataset.i)
    const vi = Number(e.detail.value)
    const list = this.data.list.slice()
    list[i] = Object.assign({}, list[i], { versionIndex: vi, textbook: list[i].versions[vi] })
    this.setData({ list })
  },
  save() {
    const selected = this.data.list.filter(x => x.checked).map(x => ({ name: x.name, textbook: x.textbook, checked: true }))
    if (!selected.length) { wx.showToast({ title: '请至少勾选一个学科', icon: 'none' }); return }
    this.setData({ saving: true })
    settings.update('subjects', selected).then(() => {
      this.setData({ saving: false })
      wx.showToast({ title: '已保存 ' + selected.length + ' 个学科', icon: 'success' })
    })
  }
})
