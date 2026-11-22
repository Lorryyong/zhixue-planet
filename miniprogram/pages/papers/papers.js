const store = require('../../utils/store.js')
const cloudStore = require('../../utils/cloudStore.js')
const cloud = require('../../utils/cloud.js')
const track = require('../../utils/track.js')

// Excel 导入样例（列头 + 全题型示例），与云函数 excelParser.SAMPLE_ROWS 一致
const SAMPLE_ROWS = [
  ['stem', 'q_type', 'options', 'answer', 'analysis', 'knowledge_tags', 'knowledge_points', 'subject', 'score', 'scoring_points', 'original', 'year', 'grade', 'region'],
  ['若 a−b=3，ab=2，则 a²+b² 的值为（　）', 'single', '5|9|13|11', '2', 'a²+b²=(a−b)²+2ab=13', '整式乘法|完全平方', '整式乘法:八年级上册|完全平方公式:八年级上册', '数学', '2', '', '2024北京中考真题', '2024', '初三', '北京'],
  ['下列数中为无理数的是（　）', 'multiple', '√2|0.5|π|3', '0|2', '√2 与 π 是无理数', '实数', '实数:七年级下册|无理数:七年级下册', '数学', '3', '', '2024北京中考真题', '2024', '初三', '北京'],
  ['全等三角形的对应边相等。', 'judge', '正确|错误', '1', '全等三角形对应边相等', '全等三角形', '全等三角形:八年级上册', '数学', '2', '', '人教版八上', '', '初二', ''],
  ['计算：2x+3=7，则 x=___', 'blank', '', '2', '移项得 x=2', '一元一次方程', '一元一次方程:七年级上册', '数学', '3', '', '人教版七上', '', '初一', ''],
  ['已知 AB=AC，∠A=60°，求证△ABC 是等边三角形。', 'solve', '', '∵AB=AC 且∠A=60°，∴∠B=∠C=60°，故为等边三角形', '有一个角60°的等腰三角形是等边三角形', '等边三角形', '等边三角形:八年级上册', '数学', '10', '说明AB=AC:3|得出∠B=∠C=60°:3|结论等边:4', '2024北京中考真题', '2024', '初三', '北京']
]

Page({
  data: {
    importing: false,
    sources: [],          // 按「来源+学科」合并的试卷组（已按筛选过滤）
    allSources: [],       // 全部试卷组（未过滤，用于统计）
    enabledCount: 0,
    loadingSources: false,
    // 筛选项
    filterSubject: '', filterRegion: '', filterGrade: '', filterBrushed: '',
    subjectOptions: [], regionOptions: [], gradeOptions: [],
    brushedOptions: [
      { value: '', label: '全部' },
      { value: 'yes', label: '已刷' },
      { value: 'no', label: '未刷' }
    ],
    initInfo: null        // 首次按年级启用提示
  },
  onShow() { this.refresh() },

  // 我的试卷：云端「来源+学科」合并列举 + 四维度筛选；云端不可用时降级本地分组
  async refresh() {
    if (cloud.isCloudReady()) {
      this.setData({ loadingSources: true })
      try {
        const filters = {
          subject: this.data.filterSubject,
          region: this.data.filterRegion,
          grade: this.data.filterGrade,
          brushed: this.data.filterBrushed
        }
        // doInit=true：云端幂等判断，首次或升学跨学段时按学段自动启用
        const r = await cloudStore.listSources(filters, true)
        const sources = (r.sources || []).map(x => Object.assign({}, x, {
          key: x.subject + '\n' + x.original,
          metaText: this._metaText(x)
        }))
        const fo = r.filterOptions || {}
        this.setData({
          sources,
          allSources: sources,
          enabledCount: sources.filter(x => x.enabled).length,
          subjectOptions: fo.subjects || [],
          regionOptions: fo.regions || [],
          gradeOptions: fo.grades || [],
          initInfo: r.initInfo || null,
          loadingSources: false
        })
        return
      } catch (e) {
        this.setData({ loadingSources: false })
      }
    }
    // 降级：本地已确认题目按 subject + original 分组
    const s = store.getState()
    const map = {}
    ;(s.questions || []).filter(q => q.confirmed).forEach(q => {
      const subj = q.subject || '其他'
      const orig = (q.original || '').trim() || '未标注来源'
      const key = subj + '\n' + orig
      if (!map[key]) map[key] = { subject: subj, original: orig, count: 0, enabled: true, year: q.year || 0, grade: q.grade || '', region: q.region || '' }
      map[key].count++
    })
    const allSources = Object.keys(map).map(k => Object.assign({}, map[k], { key: k, metaText: this._metaText(map[k]) }))
    allSources.sort((a, b) => (a.subject.localeCompare(b.subject, 'zh')) || (a.original.localeCompare(b.original, 'zh')))
    this.setData({
      sources: allSources, allSources,
      enabledCount: allSources.filter(x => x.enabled).length,
      subjectOptions: Array.from(new Set(allSources.map(x => x.subject))),
      regionOptions: Array.from(new Set(allSources.map(x => x.region).filter(Boolean))),
      gradeOptions: Array.from(new Set(allSources.map(x => x.grade).filter(Boolean)))
    })
  },

  // 组卷维度摘要：年份 · 省市 · 年级
  _metaText(x) {
    const parts = []
    if (x.year) parts.push(x.year + '年')
    if (x.region) parts.push(x.region)
    if (x.grade) parts.push(x.grade)
    return parts.join(' · ')
  },

  // ===== 筛选事件（picker 返回索引，需转成实际值）=====
  onFilterSubject(e) {
    const v = this.data.subjectOptions[Number(e.detail.value)] || ''
    this.setData({ filterSubject: v }, () => this.refresh())
  },
  onFilterRegion(e) {
    const v = this.data.regionOptions[Number(e.detail.value)] || ''
    this.setData({ filterRegion: v }, () => this.refresh())
  },
  onFilterGrade(e) {
    const v = this.data.gradeOptions[Number(e.detail.value)] || ''
    this.setData({ filterGrade: v }, () => this.refresh())
  },
  onFilterBrushed(e) {
    const opt = this.data.brushedOptions[Number(e.detail.value)] || {}
    this.setData({ filterBrushed: opt.value || '' }, () => this.refresh())
  },
  resetFilter() {
    this.setData({ filterSubject: '', filterRegion: '', filterGrade: '', filterBrushed: '' }, () => this.refresh())
  },

  // 阻止开关区域的点击冒泡到试卷行（避免点开关时误进入编辑页）
  noop() {},

  // 勾选启用/停用：按 subject+original 定位（筛选后索引会变），乐观更新 + 失败回滚
  async onToggle(e) {
    const subject = e.currentTarget.dataset.subject
    const original = e.currentTarget.dataset.original
    const checked = e.detail.value
    if (!original) return
    const patchList = (list) => list.map(x =>
      (x.subject === subject && x.original === original) ? Object.assign({}, x, { enabled: checked }) : x)
    this.setData({
      sources: patchList(this.data.sources),
      allSources: patchList(this.data.allSources)
    })
    if (!cloud.isCloudReady()) {
      wx.showToast({ title: '本地模式不支持云端同步', icon: 'none' })
      return
    }
    try {
      await cloudStore.setSourceEnabled(subject, original, checked)
    } catch (err) {
      const rollback = (list) => list.map(x =>
        (x.subject === subject && x.original === original) ? Object.assign({}, x, { enabled: !checked }) : x)
      this.setData({
        sources: rollback(this.data.sources),
        allSources: rollback(this.data.allSources)
      })
      wx.showToast({ title: (err && err.message) || '设置失败', icon: 'none' })
    }
  },

  // 点击某个来源组：加载该组全部题目进入校对/查看页
  async onSource(e) {
    const subject = e.currentTarget.dataset.subject
    const original = e.currentTarget.dataset.original
    if (!original) return
    if (!cloud.isCloudReady()) {
      wx.showToast({ title: '需云开发才能查看云端试卷', icon: 'none' })
      return
    }
    wx.showLoading({ title: '加载试卷…' })
    try {
      const r = await cloudStore.loadSource(subject, original)
      wx.hideLoading()
      store.openPaperForEdit(store.getState(), Object.assign({}, r.paper, { status: 'confirmed' }), r.questions || [])
      wx.navigateTo({ url: '/pages/check/check' })
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' })
    }
  },

  // ===== 方式一：拍照 / 选图识别 =====
  chooseImage() {
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['camera', 'album'], sizeType: ['compressed'],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0]
        if (f) this.doRecognize(f.tempFilePath, '试卷图片.' + (/\.png$/i.test(f.tempFilePath) ? 'png' : 'jpg'))
      },
      fail: () => {}
    })
  },

  // ===== 方式二：PDF 识别 =====
  chooseFile() {
    wx.chooseMessageFile({
      count: 1, type: 'file', extension: ['pdf'],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0]
        if (f) this.doRecognize(f.path, f.name)
      },
      fail: () => {}
    })
  },

  loadSample() { this.doRecognize(null, null) },

  // 进入待确认清单（check 页）
  gotoCheck(engine, title) {
    wx.navigateTo({ url: '/pages/check/check' })
    wx.showToast({
      title: engine === 'ai' ? 'AI 识别完成，请逐题校对' : (engine === 'excel' ? '导入完成，请逐题校对' : (title ? '已载入示例试卷' : '请校对')),
      icon: 'none'
    })
  },

  doRecognize(filePath, fileName) {
    wx.showLoading({ title: 'AI 识别中…' })
    const fallback = () => {
      setTimeout(() => {
        store.loadSamplePaper(store.getState())
        wx.hideLoading()
        this.gotoCheck('demo')
      }, 1000)
    }
    if (!cloud.isCloudReady()) { fallback(); return }
    cloudStore.recognize(filePath, fileName || '示例试卷.pdf', '数学')
      .then(res => {
        const qs = res && res.questions
        wx.hideLoading()
        if (!qs || !qs.length) { fallback(); return }
        store.loadCloudPaper(store.getState(), qs, {
          title: fileName || 'AI识别·云试卷', subject: res.subject || '数学', paperId: res.paperId
        })
        track.event('recognize_done', { engine: res.engine, count: qs.length, source: fileName ? 'upload' : 'demo' })
        this.gotoCheck(res.engine)
      })
      .catch(err => {
        wx.hideLoading()
        if (err && (err.code === -429 || (err.message && err.message.indexOf('上限') >= 0))) {
          wx.showModal({ title: '识别受限', content: err.message || '今日识别次数已达上限', showCancel: false })
          return
        }
        fallback()
      })
  },

  // ===== 方式三：Excel 批量导入 =====
  chooseExcel() {
    if (this.data.importing) return
    wx.chooseMessageFile({
      count: 1, type: 'file', extension: ['xlsx', 'xls', 'csv'],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0]
        if (!f) return
        this.setData({ importing: true })
        wx.showLoading({ title: '解析 Excel 中…' })
        if (!cloud.isCloudReady()) {
          wx.hideLoading(); this.setData({ importing: false })
          wx.showModal({ title: '需要云开发', content: 'Excel 导入需先开通云开发并部署云函数', showCancel: false })
          return
        }
        cloudStore.importExcel(f.path, f.name, '数学')
          .then(r => {
            wx.hideLoading(); this.setData({ importing: false })
            store.loadCloudPaper(store.getState(), r.questions, {
              title: f.name || 'Excel导入', subject: r.subject || '数学', paperId: r.paperId
            })
            track.event('import_excel_done', { engine: 'excel', count: (r.questions || []).length })
            this.gotoCheck('excel')
            if ((r.invalid && r.invalid.length) || r.needFixCount) {
              const parts = []
              parts.push('共 ' + r.total + ' 行，导入 ' + (r.imported || (r.questions || []).length) + ' 题')
              if (r.needFixCount) parts.push(r.needFixCount + ' 题信息不全（缺选项/答案），已标红待补全')
              if (r.invalid && r.invalid.length) parts.push(r.invalid.length + ' 行无效已跳过')
              parts.push('已进入校对页，请逐题补全并确认')
              setTimeout(() => wx.showModal({ title: '导入结果', content: parts.join('；') + '。', showCancel: false }), 600)
            }
          })
          .catch(err => {
            wx.hideLoading(); this.setData({ importing: false })
            if (err && err.code === -2 && err.invalid) {
              wx.showModal({ title: '未导入有效题目', content: (err.message || '') + '\n\n首行错误：' + (err.invalid[0].error || ''), showCancel: false })
            } else {
              wx.showModal({ title: '导入失败', content: (err && err.message) || '请检查 Excel 格式', showCancel: false })
            }
          })
      },
      fail: () => {}
    })
  },

  // 下载/查看 Excel 样例：展示样例并保存到本地（Excel 可直接打开 csv）
  downloadSample() {
    const lines = SAMPLE_ROWS.map(row => row.map(function (cell) {
      const s = String(cell == null ? '' : cell)
      return /[,\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
    }).join(','))
    const csv = '\ufeff' + lines.join('\n') // BOM 让 Excel 正确识别中文
    const fs = wx.getFileSystemManager()
    const path = wx.env.USER_DATA_PATH + '/题目导入样例.csv'
    try {
      fs.writeFileSync(path, csv, 'utf8')
      wx.shareFileMessage
        ? wx.shareFileMessage({ filePath: path, fileName: '题目导入样例.csv', fail: () => {}, success: () => {} })
        : wx.showModal({ title: '样例已生成', content: '样例文件已保存到本地：' + path, showCancel: false })
    } catch (e) {
      wx.showModal({ title: '样例内容', content: '列头：stem,q_type,options,answer,analysis,knowledge_tags,knowledge_points,subject,score,scoring_points,original,year,grade,region\n（题型：single单选/multiple多选/judge判断/blank填空/solve解答…；选项与答案用 | 分隔；knowledge_tags=知识点名，多个用 | 分隔；knowledge_points=知识点与课本册次，形如「全等三角形:八年级上册|勾股定理:八年级下册」，可留空自动推断；original=来源；year=出题年份；grade=年级；region=省市）', showCancel: false })
    }
  },

  // 点击「我的试卷」：加载该试卷全部题目，进入可编辑的校对页
  async onPaper(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    const isCloud = id.indexOf('p_') === 0
    // 本地示例试卷（非云端 id）：若正在校对直接进，否则提示
    if (!isCloud) {
      const s = store.getState()
      if (s.pendingPaperId === id && s.pendingQuestions && s.pendingQuestions.length) {
        wx.navigateTo({ url: '/pages/check/check' })
      } else {
        wx.showToast({ title: '本地示例试卷暂无可编辑题目', icon: 'none' })
      }
      return
    }
    // 云端试卷：从云端拉取该试卷全部题目
    wx.showLoading({ title: '加载试卷…' })
    try {
      const r = await cloudStore.loadPaper(id)
      wx.hideLoading()
      const paper = r.paper || {}
      store.openPaperForEdit(store.getState(), Object.assign({}, paper, { id }), r.questions || [])
      wx.navigateTo({ url: '/pages/check/check' })
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: (err && err.message) || '加载失败', icon: 'none' })
    }
  }
})
