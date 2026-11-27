const store = require('../../utils/store.js')
const cloudStore = require('../../utils/cloudStore.js')
const cloud = require('../../utils/cloud.js')
const auth = require('../../utils/auth.js')
const settings = require('../../utils/settings.js')
const spaceLevels = require('../../utils/spaceLevels.js')

// 科目视觉（与试卷页 SUBJECT_VISUALS 同一套图标与底色，全站一致）
// grad/hole：每科固定的专属渐变与环心色——所有卡片恒为渐变主卡样式、颜色只随科目不变随选中态变，
// 消除旧版「当前卡才变渐变」在横滑切换瞬间整卡变色造成的闪烁感（2026-11-27 用户反馈）。
const SUBJ_META = {
  '语文': { img: '/images/icons/chinese.png', icon: '📖', bg: '#fdecec', grad: 'linear-gradient(120deg,#e0685f,#c94f6d)', hole: '#d65a68' },
  '数学': { img: '/images/icons/math.png', icon: '📐', bg: '#e6ebff', grad: 'linear-gradient(120deg,#4a90d9,#5b6cf6 55%,#9678f0)', hole: '#626ef0' },
  '英语': { img: '/images/icons/english.png', icon: '🔤', bg: '#e8f6ff', grad: 'linear-gradient(120deg,#3d9be9,#4a6fd9)', hole: '#4485e1' },
  '物理': { img: '/images/icons/physics.png', icon: '🧲', bg: '#e9f7f1', grad: 'linear-gradient(120deg,#2f9e77,#2b7a9e)', hole: '#2d8c8a' },
  '化学': { img: '/images/icons/chemistry.png', icon: '🧪', bg: '#f0eafd', grad: 'linear-gradient(120deg,#7a5af8,#9b4dca)', hole: '#8a53e1' },
  '生物': { img: '/images/icons/biology.png', icon: '🌿', bg: '#e7f8e9', grad: 'linear-gradient(120deg,#43aa5b,#2f9e77)', hole: '#38a465' },
  '历史': { img: '/images/icons/history.png', icon: '📜', bg: '#fdf3e0', grad: 'linear-gradient(120deg,#d9932c,#c05f2e)', hole: '#cc7a2e' },
  '地理': { img: '/images/icons/geography.png', icon: '🌍', bg: '#e4f5fb', grad: 'linear-gradient(120deg,#2ea3c7,#3d7bd9)', hole: '#358fd0' },
  '道德与法治': { img: '/images/icons/politics.png', icon: '⚖️', bg: '#fdeef4', grad: 'linear-gradient(120deg,#d9608f,#a855c9)', hole: '#c158ac' },
  '道法': { img: '/images/icons/politics.png', icon: '⚖️', bg: '#fdeef4', grad: 'linear-gradient(120deg,#d9608f,#a855c9)', hole: '#c158ac' }
}
function subjMeta(name) { return SUBJ_META[name] || { icon: '📄', bg: '#eef0ff', grad: 'linear-gradient(120deg,#5b6cf6,#8a5cf6)', hole: '#626ef0' } }

// 未设置学科时的兜底科目（保底展示，避免首页无科目可选）
const FALLBACK_SUBJECTS = ['数学', '语文', '英语', '物理', '化学', '生物']

/**
 * 依据用户勾选的学科生成首页科目列表（本地优先，同步读取）。
 * 列表 = 用户勾选的学科（不再含「综合」总览；不强制包含任何科目——
 * 2026-11-26 用户反馈：没勾数学时首页不应出现数学卡），
 * 并按「语文，数学，英语，物理，化学，生物，历史，地理，道法」的固定顺序排列；
 * 未设置时用兜底科目（学习设置保存时强制至少勾选一科，故空列表只会是未配置）。
 */
const SUBJECT_ORDER = ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '地理', '道德与法治']
function subjectOrderIdx(name) {
  if (name === '道法') return SUBJECT_ORDER.indexOf('道德与法治')
  const i = SUBJECT_ORDER.indexOf(name)
  return i < 0 ? SUBJECT_ORDER.length : i
}
function buildSubjectNames() {
  const picked = (settings.cached().subjects || [])
    .filter(x => x && x.checked && x.name)
    .map(x => x.name)
    .filter(n => n !== '综合')
  const names = picked.filter((n, i, a) => a.indexOf(n) === i)
  if (!names.length) return FALLBACK_SUBJECTS.slice()
  return names
    .map((n, i) => ({ n, i }))
    .sort((a, b) => (subjectOrderIdx(a.n) - subjectOrderIdx(b.n)) || (a.i - b.i))
    .map(x => x.n)
}

// 打卡排名视图模型：数据来自 login 返回的 leaderboard（云端按累计获得能量 total_earned 排序）。
// 前三名给奖牌；列表区最多露 5 行、其余滚动；自己的名次另有固定行（rank-mybar）常驻显示。
const RANK_MEDALS = ['🥇', '🥈', '🥉']
function buildRank(g) {
  const rows = (g.leaderboard || []).map(r => Object.assign({}, r, {
    medal: r.rank >= 1 && r.rank <= 3 ? RANK_MEDALS[r.rank - 1] : ''
  }))
  const mine = rows.find(r => r.isMe)
  return {
    rows,
    myRank: mine ? mine.rank : 0,
    myTotalEarned: mine ? mine.totalEarned : (g.totalEarned || 0),
    scrollH: Math.max(1, Math.min(rows.length, 5)) * 84
  }
}

// 当天已完成打卡的科目：只读 cloudStore 按「云端任务日期+云端状态」记的标记
// （zx_done_map / zx_cloud_today）。旧版按本地任务日期记账，本地组卷用手机日期、
// 与云端北京时间差一天会串账，没打卡的科目会冒假✓，故旧标记一次性清掉不再用。
function readCloudDoneSubjects() {
  try {
    if (!wx.getStorageSync('zx_done_map_v2')) {
      const info = wx.getStorageInfoSync()
      ;(info.keys || []).filter(k => k.indexOf('zx_done_subjects_') === 0)
        .forEach(k => { try { wx.removeStorageSync(k) } catch (e) {} })
      wx.setStorageSync('zx_done_map_v2', 1)
    }
    const today = wx.getStorageSync('zx_cloud_today') || ''
    const map = wx.getStorageSync('zx_done_map') || {}
    return today ? (map[today] || []) : []
  } catch (e) { return [] }
}

// 按当前时段生成问候语
function greetingText() {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 13) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

Page({
  data: {
    subjects: [],
    subject: '数学',
    curIndex: 0,
    greeting: '你好',
    nickname: '',
    avatar: '',
    streak: 0, acc: 0, conquered: 0,
    taskDone: false, taskCount: 0, wrongCount: 0, bankCount: 0, taskSubject: '', taskLoading: false, taskPending: false, last: null,
    rankRows: [], myRank: 0, myTotalEarned: 0, showRank: false,
    doneCount: 0,
    // 打卡正确率曲线（本学期 vs 上学期，按周）：数据来自 composeTask accuracyCurve，本地缓存秒显
    accCurve: null, accHasData: false, accPrevHas: false, accCanvasW: 300, accCurLabel: '', accPrevLabel: '',
    uLevel: 1, uName: '', uImg: '', uTitle: '', uEnergy: 0, uPct: 0, uToNext: 0, uNextName: '', uIsMax: false,
    ringDeg: 0
  },
  onShow() {
    // 先按本地勾选学科即时渲染（设置后返回首页立即生效）
    const subject = cloudStore.getPreferredSubject()
    this.setData({ subject })
    // 正确率曲线：先用本地缓存秒显，后台在 _syncHome 里按节流刷新
    try {
      const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      this.setData({ accCanvasW: Math.max(260, Math.round(win.windowWidth - 56)) })
    } catch (e) {}
    this._renderAccCurve()
    // 本次进入首页时，若定位科目已打卡则自动停到第一个未完成科目（仅进入时定位一次，
    // 之后用户手动滑动查看已完成科目的战绩时不再抢位）
    this._autoPos = true
    this.applySubjectSettings()
    this.applyProfile()
    this.refresh()
    // 从云端同步最新资料与设置（他处修改/换设备后一致）
    if (cloud.isCloudReady()) {
      auth.syncProfile().then(p => { if (p) this.applyProfile(p) }).catch(() => {})
      // 先同步云端权威养成快照（修复迁移清理脏能量后本地缓存虚高），再重渲染
      auth.syncGamification().then(() => this.refresh()).catch(() => {})
      settings.load().then(() => {
        this.applySubjectSettings()
        this.refresh()
      })
    }
  },

  // 应用勾选学科到首页科目列表；若当前科目不在新列表中则回退到列表第一科
  applySubjectSettings() {
    const names = buildSubjectNames()
    let subject = this.data.subject || names[0]
    if (names.indexOf(subject) < 0) {
      subject = names[0]
      cloudStore.setPreferredSubject(subject)
    }
    // 科目名单没变时不重设 subjects 数组：swiper 对 items 数组引用变化很敏感，
    // onShow 会多次走这里，无谓的重设会让滑动卡片反复重排、闪烁甚至错位。
    const curNames = (this.data.subjects || []).map(x => x.name).join('|')
    const patch = { subject }
    if (curNames !== names.join('|')) {
      patch.subjects = names.map(name => Object.assign({ name, done: false }, subjMeta(name)))
      this._subjSig = names.map(n => n + '0').join('|')
    }
    const ci = Math.max(0, names.indexOf(subject))
    if (ci !== this.data.curIndex) patch.curIndex = ci
    this.setData(patch)
  },

  applyProfile(p) {
    const profile = p || auth.getProfile() || {}
    this.setData({
      nickname: profile.nickname || '同学',
      avatar: profile.avatar || '',
      greeting: greetingText()
    })
  },

  refresh() {
    this._renderHome()
    this._syncHome()
  },

  // 渲染只读本地（任务缓存 + 今日看板缓存），不等云端：首页打开即出数据；
  // 云端对账在 _syncHome 里后台进行，回来后有变化再重渲染。
  _renderHome() {
      const s = store.getState()
      const t = s.dailyTask
      // 已打卡科目标记：只认云端任务的日期与状态（cloudStore.noteCloudTask 记账），
      // 本地任务的日期是手机日期、与云端差一天，按它记账会串账冒假✓。
      const doneList = readCloudDoneSubjects()
      const names = buildSubjectNames()
      // 每张卡自带副标题与按钮状态：所有卡同构渲染（渐变主卡），切换时只有位置变、样式不变。
      // 当前科目的口径与下方分支完全一致（看板构成 / 本地任务构成 / 准备中 / 待生成）。
      const board0 = cloudStore.getBoard()
      const boardSubs = (board0 && board0.subjects) || {}
      let curWrong = 0, curTotal = 0
      if (t && t.subject === this.data.subject && t.questionIds && t.questionIds.length) {
        const aw = {}
        ;(s.wrongbook || []).forEach(w => { if (w.status === 'active') aw[w.questionId] = true })
        curTotal = t.questionIds.length
        curWrong = t.questionIds.filter(id => aw[id]).length
      }
      const subjects = names.map(name => {
        const done = doneList.indexOf(name) >= 0
        const entry = boardSubs[name] || null
        const isCur = name === this.data.subject
        let subText, btnDisabled = false
        if (done) {
          subText = '今日已完成打卡'
          if (isCur && s.lastQuiz && typeof s.lastQuiz.correct === 'number') {
            subText += ' · 答对 ' + s.lastQuiz.correct + '/' + s.lastQuiz.total + ' 题 · 获得 ⚡' + (s.lastQuiz.energy || 0)
          }
        } else if (entry && entry.count > 0) {
          subText = isCur
            ? '错题重刷 ' + (entry.wrong || 0) + ' 题 · 巩固练习 ' + Math.max(0, entry.count - (entry.wrong || 0)) + ' 题'
            : '共 ' + entry.count + ' 题' + (entry.done > 0 ? ' · 已答 ' + entry.done + ' 题' : '')
        } else if (isCur && curTotal > 0) {
          subText = '错题重刷 ' + curWrong + ' 题 · 巩固练习 ' + (curTotal - curWrong) + ' 题'
        } else if (!board0 && cloud.isCloudReady()) {
          subText = '正在准备今日任务…'
          if (isCur) btnDisabled = true
        } else if (board0) {
          subText = '今日任务待生成，点开始打卡即可'
        } else {
          subText = '今日暂无可打卡题目'
          if (isCur) btnDisabled = true
        }
        return Object.assign({ name, done, subText, btnDisabled }, subjMeta(name))
      })
      const curIndex = Math.max(0, names.indexOf(this.data.subject))
      const g = s.gamification || {}
      // 首页统计：云端权威口径优先（login 快照），本地仅兜底
      const acc = store.weekAccuracy(s)
      const conquered = typeof g.conqueredCount === 'number'
        ? g.conqueredCount
        : (s.wrongbook || []).filter(w => w.status === 'conquered').length
      const rank = buildRank(g)
      // 宇宙探索卡：等级按累计获得（与排行榜同口径），节点图 n1–n12 均有图
      const lv = spaceLevels.levelOf(rank.myTotalEarned || g.totalEarned || 0)
      const lvCfg = spaceLevels.LEVELS[lv.level - 1] || {}
      // 【防闪烁】subjects/curIndex 只在内容真的变了时才进 patch：
      // swiper 收到新 items 数组或 current 变化会重排，onShow 期间 refresh 会跑多次，
      // 无守卫的重复 setData 正是上一版卡片闪烁、停在半页的根源。
      const sig = subjects.map(x => x.name + (x.done ? '1' : '0') + ':' + x.subText).join('|')
      const base = {
        rankRows: rank.rows, myRank: rank.myRank, myTotalEarned: rank.myTotalEarned,
        doneCount: subjects.filter(x => x.done).length,
        ringDeg: subjects.length ? Math.round(subjects.filter(x => x.done).length / subjects.length * 360) : 0,
        uLevel: lv.level, uName: lv.name, uImg: lvCfg.node || '', uTitle: lv.title,
        uEnergy: g.energy || 0, uPct: lv.pct, uToNext: lv.toNext, uNextName: lv.nextName, uIsMax: lv.isMax
      }
      if (sig !== this._subjSig) { base.subjects = subjects; this._subjSig = sig }
      if (curIndex !== this.data.curIndex) base.curIndex = curIndex
      const taskMatches = !!(t && t.subject && t.subject === this.data.subject)
      if (!taskMatches || !t.questionIds || !t.questionIds.length) {
        // 本地任务缓存不是当前科目的：改读今日看板缓存（各科任务摘要），不再干等组卷
        const board = cloudStore.getBoard()
        const entry = board && board.subjects ? board.subjects[this.data.subject] : null
        if (entry && entry.count > 0) {
          this.setData(Object.assign(base, {
            taskDone: entry.status === 'done',
            taskCount: entry.count, wrongCount: entry.wrong || 0,
            bankCount: Math.max(0, entry.count - (entry.wrong || 0)),
            conquered, acc, taskSubject: this.data.subject,
            taskLoading: false, taskPending: false,
            streak: g.streak || 0,
            last: s.lastQuiz
          }))
          return
        }
        this.setData(Object.assign(base, {
          taskDone: taskMatches && !!t && t.status === 'done' && !!(t.questionIds && t.questionIds.length),
          taskCount: 0, wrongCount: 0, bankCount: 0,
          conquered, acc, taskSubject: this.data.subject,
          // 看板已就位且本科目今天还没任务 → 待生成（点开始打卡由答题页现场组卷，不阻塞首页）；
          // 完全没有本地数据（今天第一次打开）才显示「准备中」。
          taskLoading: cloud.isCloudReady() && !board,
          taskPending: !!board,
          streak: g.streak || 0,
          last: s.lastQuiz
        }))
        return
      }
      // 构成按「当前任务实际题目」×「错题本 active」实时交叉计算，不依赖组卷时的 composition 快照：
      // 修复旧任务/未到期错题导致 composition.wrong 过期、显示与实际不符的问题。
      const taskIds = t.questionIds || []
      const activeWrongIds = {}
      ;(s.wrongbook || []).forEach(w => { if (w.status === 'active') activeWrongIds[w.questionId] = true })
      const wrongInTask = taskIds.filter(id => activeWrongIds[id]).length
      this.setData(Object.assign(base, {
        streak: g.streak || 0, acc, conquered,
        taskDone: t.status === 'done', taskCount: taskIds.length,
        taskSubject: t.subject || this.data.subject,
        taskLoading: false, taskPending: false,
        // wrong=任务中属于错题本的题；bank=题库补齐（两者自洽）
        wrongCount: wrongInTask,
        bankCount: Math.max(0, taskIds.length - wrongInTask),
        last: s.lastQuiz
      }))
  },

  // 后台对账：拉今日看板（一次小查询）刷新各科摘要；当前科目还没有任务时再后台组卷。
  // 3 秒内多次 refresh（onShow 的几个同步回调）只真正同步一次。
  _syncHome() {
    if (!cloud.isCloudReady()) return
    const now = Date.now()
    if (this._lastSync && now - this._lastSync < 3000) return
    this._lastSync = now
    this._syncAccCurve()
    cloudStore.todayBoard().then(() => {
      this._renderHome()
      this._autoPosition()
      this._ensureSubject(this.data.subject)
      // 顺手预热试卷列表（写原始聚合缓存）：等用户点进试卷页时可直接秒显
      if (!this._prefetchedPapers) {
        this._prefetchedPapers = true
        cloudStore.listSources(null, false).catch(() => {})
      }
    }).catch(() => {
      // 看板不可用时退回为当前科目组卷，保证至少当前科可用
      this._ensureSubject(this.data.subject)
    })
  },

  // 正确率曲线：本地缓存 10 分钟节流（数据只随答题变化）；口径与学情页一致（云端聚合）
  _syncAccCurve() {
    if (!cloud.isCloudReady()) return
    try {
      const c = wx.getStorageSync('zx_acc_curve_v1')
      if (c && c.at && Date.now() - c.at < 600000 && c.data) return
    } catch (e) {}
    cloud.call('composeTask', { action: 'accuracyCurve' }).then(r => {
      if (!r || !r.cur) return
      try { wx.setStorageSync('zx_acc_curve_v1', { at: Date.now(), data: r }) } catch (e) {}
      this._renderAccCurve()
    }).catch(() => {})
  },

  _renderAccCurve() {
    let data = this.data.accCurve
    if (!data) {
      try { const c = wx.getStorageSync('zx_acc_curve_v1'); if (c && c.data) data = c.data } catch (e) {}
    }
    if (!data || !data.cur) { if (this.data.accHasData) this.setData({ accHasData: false }); return }
    const has = (data.cur.weeks || []).length > 0
    const prevHas = (data.prev.weeks || []).length > 0
    this.setData({
      accCurve: data, accHasData: has, accPrevHas: prevHas,
      accCurLabel: data.cur.label || '本学期', accPrevLabel: data.prev.label || '上学期'
    }, () => { if (has) setTimeout(() => this._drawAccChart(), 40) })
  },

  // 只用基础线条/填充/文字绘制（旧版 canvas 兼容，与学情雷达图同策略）：
  // 上学期浅灰虚线弱化，本学期品牌色实线 + 淡色面积填充突出。
  _drawAccChart() {
    const data = this.data.accCurve
    if (!data || !data.cur) return
    const W = this.data.accCanvasW, H = 168
    const ctx = wx.createCanvasContext('accChart', this)
    const padL = 30, padR = 10, padT = 12, padB = 20
    const iw = W - padL - padR, ih = H - padT - padB
    const maxW = Math.max(data.cur.maxWeek || 1, data.prev.maxWeek || 1, 2)
    const X = w => padL + (maxW <= 1 ? 0 : (w - 1) / (maxW - 1) * iw)
    const Y = acc => padT + ih - (acc / 100) * ih
    ctx.setStrokeStyle('#eceef5'); ctx.setLineWidth(1)
    ctx.setFillStyle('#a0a6bd'); ctx.setFontSize(9)
    ;[0, 50, 100].forEach(v => {
      ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(W - padR, Y(v)); ctx.stroke()
      ctx.fillText(v + '%', 2, Y(v) + 3)
    })
    const drawLine = (weeks, color, width, dash, dotR, area) => {
      if (!weeks.length) return
      if (area) {
        ctx.beginPath()
        weeks.forEach((p, i) => { const x = X(p.w), y = Y(p.acc); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y) })
        ctx.lineTo(X(weeks[weeks.length - 1].w), Y(0)); ctx.lineTo(X(weeks[0].w), Y(0)); ctx.closePath()
        ctx.setFillStyle(area); ctx.fill()
      }
      ctx.beginPath()
      if (dash) ctx.setLineDash(dash, 0)
      weeks.forEach((p, i) => { const x = X(p.w), y = Y(p.acc); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y) })
      ctx.setStrokeStyle(color); ctx.setLineWidth(width); ctx.stroke()
      if (dash) ctx.setLineDash([], 0)
      weeks.forEach(p => {
        ctx.beginPath(); ctx.arc(X(p.w), Y(p.acc), dotR, 0, 2 * Math.PI)
        ctx.setFillStyle(color); ctx.fill()
      })
    }
    drawLine(data.prev.weeks || [], '#c3c9dd', 1.5, [4, 4], 2, null)
    drawLine(data.cur.weeks || [], '#5b6cf6', 2.5, null, 3, 'rgba(91,108,246,0.10)')
    ctx.setFillStyle('#a0a6bd'); ctx.setFontSize(9)
    ctx.fillText('第1周', padL - 4, H - 6)
    ctx.fillText('第' + maxW + '周', W - padR - 28, H - 6)
    if (maxW >= 6) { const mid = Math.round(maxW / 2); ctx.fillText('第' + mid + '周', X(mid) - 12, H - 6) }
    ctx.draw()
  },

  // 当前科目还没有今日任务时后台组卷（不阻塞渲染，答题页进入时也会自检组卷）
  _ensureSubject(subject) {
    if (!cloud.isCloudReady() || !subject) return
    const s = store.getState()
    const t = s.dailyTask
    if (t && (t.subject || '综合') === subject && t.questionIds && t.questionIds.length) return
    const board = cloudStore.getBoard()
    if (board && board.subjects && board.subjects[subject]) return
    this._ensuring = this._ensuring || {}
    if (this._ensuring[subject]) return
    this._ensuring[subject] = true
    cloudStore.composeTask(subject).then(() => {
      this._ensuring[subject] = false
      if (this.data.subject === subject) this._renderHome()
    }).catch((err) => {
      this._ensuring[subject] = false
      // 【v1.9.17】该科已无启用题：清掉本地残留的旧任务缓存，避免首页显示旧题
      if (err && (err.code === -2 || err.emptySubject)) {
        const s2 = store.getState()
        if (s2.dailyTask && (s2.dailyTask.subject || '综合') === subject) {
          s2.dailyTask = null
          store.saveState(s2)
        }
        if (this.data.subject === subject) this._renderHome()
      }
    })
  },

  // 进入首页时的一次性定位：当前科已打卡 → 停到第一个未完成科目（仅进入时判断一次）
  _autoPosition() {
    if (!this._autoPos) return
    this._autoPos = false
    const cur = this.data.subject
    const dl = readCloudDoneSubjects()
    if (dl.indexOf(cur) < 0) return
    const first = buildSubjectNames().find(n => dl.indexOf(n) < 0)
    if (first && first !== cur) {
      cloudStore.setPreferredSubject(first)
      this.setData({ subject: first })
      this._renderHome()
      this._ensureSubject(first)
    }
  },

  // 横滑切换科目：每科每天各有一次独立打卡任务，可自由切换
  onSwiperChange(e) {
    const idx = e.detail.current
    const item = this.data.subjects[idx]
    if (!item) return
    if (item.name === this.data.subject) {
      this.setData({ curIndex: idx })
      return
    }
    cloudStore.setPreferredSubject(item.name)
    this.setData({ subject: item.name, curIndex: idx })
    // 不再清上一科的任务缓存：先用本地看板渲染这科的摘要，缺任务时后台补组卷
    this._renderHome()
    this._ensureSubject(item.name)
  },

  // 点微型状态行的科目名：跳到那张卡（swiper 的 change 事件会接手切换逻辑）
  onSubjectTap(e) {
    const idx = Number(e.currentTarget.dataset.i)
    if (idx === this.data.curIndex) return
    this.setData({ curIndex: idx })
  },

  startQuiz() { wx.navigateTo({ url: '/pages/quiz/quiz' }) },

  // 非当前卡上的「开始打卡」：先把选中科目切到这一科，再进答题页（答题页会自检组卷）
  onCardStart(e) {
    const name = e.currentTarget.dataset.name
    if (!name || name === this.data.subject) { this.startQuiz(); return }
    cloudStore.setPreferredSubject(name)
    const idx = this.data.subjects.findIndex(x => x.name === name)
    this.setData({ subject: name, curIndex: idx >= 0 ? idx : this.data.curIndex })
    this._renderHome()
    this._ensureSubject(name)
    this.startQuiz()
  },
  // 一行入口跳转：数据行 → 我的学情卡；头像 → 我的
  goStudyCard() { wx.navigateTo({ url: '/pages/studycard/studycard' }) },
  goWrong() { wx.switchTab({ url: '/pages/wrong/wrong' }) },
  goMe() { wx.switchTab({ url: '/pages/me/me' }) },
  goPlanet() { wx.switchTab({ url: '/pages/planet/planet' }) },
  // 排行榜：首页只留一行入口，完整榜单在弹层里看（数据仍是 login 快照的 leaderboard）
  openRank() { this.setData({ showRank: true }) },
  closeRank() { this.setData({ showRank: false }) },
  noop() {}
})
