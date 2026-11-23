# 智学星球 · 微信小程序最小闭环 Demo

真题识别 + 自适应刷题 + 养成打卡的微信小程序可运行 Demo。导入微信开发者工具即可跑通完整闭环。

## 一、目录结构

```
智学打卡小程序/
├─ project.config.json          # 项目配置（appid=wx8874a19dbd6fa717）
├─ miniprogram/                 # 小程序前端（主程序）
│  ├─ app.js / app.json / app.wxss
│  ├─ sitemap.json
│  ├─ utils/store.js            # 核心：种子数据 + 状态管理 + 全部算法
│  └─ pages/
│     ├─ index/     首页·今日打卡（tab）
│     ├─ papers/    试卷中心·三种导入（拍照/PDF/Excel）（tab）
│     ├─ check/     待确认题目校对·逐题修改·一键入库
│     ├─ quiz/      每日答题
│     ├─ wrong/     错题本·重刷（tab）
│     ├─ radar/     学情画像
│     ├─ planet/    养成·农场（tab）
│     ├─ me/        个人中心（tab：资料/家长/学科/能量/积分/隐私/管理端入口）
│     ├─ adminconsole/ 管理端（管理员账号登录 + 三个管理功能入口）
│     ├─ admin/     题库批量导入（管理员，拍照/PDF/Excel）
│     └─ feedback/  用户反馈错题清单（管理员处理：修正/删除/忽略）
└─ cloudfunctions/              # 云函数
   ├─ login/         微信云调用身份登录 + 建档
   ├─ adminAuth/     管理端鉴权：内置 admin/admin1 登录授权当前 openid
   ├─ recognize/     试卷识别拆题（AI视觉模型 + 样题降级）+ Excel批量导入 + 校对/编辑
   ├─ composeTask/   智能组卷
   ├─ submitAnswer/  批改+掌握度+错题排期+养成上云
   ├─ importQuestions/  管理员题库批量导入（JSON/CSV，系统级）
   ├─ trackEvent/    轻量行为埋点（隐私优先、失败静默）
   ├─ parent/        家长绑定（绑定码认领）+ 学情周报云端聚合
   ├─ radarData/     学情画像按学科动态数据
   ├─ farm/          科目农场：能量购买动物/食物/装饰，云端权威扣减
   └─ feedback/      题目错误反馈：学生提交 + 管理员修正/删除/忽略
```

> **v1.9.20 学习设置（学科教材 + 打卡规则）**：原「我的学科与教材」页升级为「学习设置」（导航标题、我的页入口同步改名），分两个区块。① 第一区「我的学科与教材」保留原学科勾选 + 教材版本功能。② 第二区「打卡设置」新增三项：`每天打卡题目数`（5/10/15/20 题，决定 `composeTask` 的 `DAILY_GOAL`）、`错题与新题比例`（错题 0/20/30/50/60/70%，按 `DAILY_GOAL×比例` 算每日组卷错题目标数）、`错题复习频率`（艾宾浩斯方案：密集 1/2/4/7/15、标准 1/3/7/15、舒缓 1/3/7/15/30 天，决定 `submitAnswer` 答对后的 `next_review_at` 间隔）。设置写入 `settings.checkin`（前端 `utils/settings.js` + 云端 `login` 的 `defaultSettings`/白名单同步扩展），`composeTask` 组卷前读取题数与比例、`submitAnswer` 错题递进时读取复习方案，读取失败均用默认值兜底，不影响主流程。三个云函数已重部署；设置从下次组卷起生效。

> **v1.9.19 错题本筛选 + 解析查看**：错题本顶部由静态摆设筛选（全部/数学/知识漏洞/计算失误）改为真正可用的纵向平铺筛选面板——三个维度「科目（从错题题目 subject 去重，兜底未分类）/错因（知识漏洞/概念混淆/计算失误/审题偏差）/状态（待重刷/已攻克）」各占一行、选项 chip 平铺，点选本地过滤、再点取消、一键清除。错题条目新增科目·题型行与「点击查看题目解析」提示，点击弹出详情弹窗，展示题干、选项、参考答案、评分要点、知识点、解析（analysis）及错次/连对/重刷进度，帮助学习。题目无解析时提示可在「试卷→校对」补全。

> **v1.9.18 年级改名 + 刷题三态 + 校对页标志**：① 全局年级「初一/初二/初三」统一改为「七年级/八年级/九年级」——`utils/grade.js`、`question-editor`、`questionMeta.js`（新增 `normalizeGrade` 兼容旧值）、`excelParser.js`、前端/云端样例同步；迁移 `20261123210000_rename_grade_names.sql` 更新存量 `zx_questions/zx_knowledge_tree`，云端 listSources/loadPaper/loadSource 输出再做一次归一化（双保险）。② 试卷中心刷题状态由「未刷/已刷」扩为「未刷/已刷/刷完」三态（`brushState`=none/part/done，已答题数≥总题数即刷完），筛选与试卷行标签均支持；`loadSource/loadPaper` 按 `zx_answer_record` 给每题返回 `brushed`。③ 题目校对页右上角「已确认/待确认」标签改为「已刷/未刷」标志，左下角「✓ 已确认」按钮去掉（确认按钮仅在题目首次录入/待确认时保留）。试卷名去掉省略号改为完整换行显示。`recognize` 云函数已重部署、迁移已执行。

> **v1.9.17 取消勾选后任务仍显示旧题修复**：① 云端 `composeTask` 复用当天 pending 任务前先校验任务题目是否仍启用，任一题被停用（在「我的试卷」取消勾选来源）即不复用、按最新启用题池重新组卷；② 前端首页 `refresh` 收到 `-2/emptySubject`（该科无启用题）时清掉本地残留任务缓存并重渲染，显示 0 题空态，「开始打卡」按钮正确禁用。已完成（done）任务不受影响，打卡记录与能量不丢失。

> **v1.9.16 我的试卷筛选改版**：五个筛选维度（科目/省市/年级/范围/刷题）由横排下拉框改为纵向筛选面板——每个维度一行、左侧标签右侧选项全部平铺，用户从上往下逐个点选；再次点击已选项即取消回到「全部」，可一键清除全部筛选。筛选仍为本地过滤零网络开销。

> **v1.9.15 导入页 UI 重设计**：三种导入方式由三列网格改为纵向全宽卡片（图标 + 标题 + 说明 + 箭头），修复窄屏下 Excel 卡片被挤出裁切的问题；「默认学科」压缩为一行可选学科点选（拍照/PDF 识别的学科提示，Excel 以表内 subject 列为准）；Excel 列头说明改为「查看 Excel 列头格式要求」点击弹窗，不再常驻占位。

> **v1.9.14 题库批量导入精简**：管理端「题库批量导入」页只保留「拍照导入 / PDF 导入 / Excel 导入」三种方式，移除「JSON/CSV 粘贴」通道、顶部「题库导入/用户管理」切换 tab 及「下载样例」按钮。「用户管理」仍可从管理端首页独立入口进入（带 `tab=users`），功能不受影响。三种文件导入继续复用试卷页解析 + 校对流程，`asSystem=true` 发布为系统题库。

> **v1.9.13 管理端导入复用试卷能力**：管理端「题库批量导入」新增「文件导入」方式（拍照/选图、PDF、Excel），复用试卷页「导入新试卷」的 AI/Excel 解析与校对流程——导入时以 `asSystem=true` 走 `recognize` 云函数（服务端校验管理员身份），题目先以 `scope=system` 写在管理员名下进入 check 页逐题校对；点「确认入库」时云函数在 `confirm` 动作里把题发布到公共题库 `demo_student` 并分发克隆给所有已有用户，新用户首次登录自动获得，确认后弹窗提示「已发布为系统题库」。原「JSON/CSV 粘贴」通道保留（直接入库到公共库），作为批量补充方式。

> **v1.9.12 管理端 + 范围维度**：① 新增独立「管理端」页面（我的 → 管理端），内置管理员账号 `admin` / `admin1`（`zx_admin_accounts` 表，builtin 不可删除），登录后授权当前微信 openid，复用现有 openid 白名单鉴权，普通用户无法访问三个管理功能；② 试卷/题目新增「范围」维度（`scope`=system 系统题库 / user 我的题库），管理员导入为系统级（所有用户可见），用户自行导入为用户级（仅自己可见）；③ 我的试卷新增「全部范围/系统题库/我的题库」筛选，元数据补全范围并完整展示；④ 试卷列表性能优化：本地缓存秒显 + 首次才做学段初始化 + 筛选本地化零网络开销。

> **v1.9.9 打卡体验修复 + 题目反馈闭环**：① 首页科目切换题数/标题实时跟随选中科目，空科目"开始打卡"按钮置灰；② 移除与主维度不同类的"今日打卡目标"栏；③ 修复"无题科目开始打卡却混入其它科错题"——云端无题直接空态、本地降级组卷也按科目过滤（错题必须落在本科目题池内）；④ 打卡页每道题以小字展示元数据（科目/年级/来源/省市/年份）；⑤ 新增「题错误」反馈：打卡中右下角按钮 → 三类反馈（题分类错误/题目错误/答案错误）→「已反馈」提示，记录到「我的 → 题库管理 → 用户反馈错题清单」，管理员可修正题目/删除题目/忽略，处理过的自动移出清单（`zx_question_feedback` 表 + `feedback` 云函数）。

> **v1.9.8 科目农场**：原「星球」栏目改造为「农场」——每门科目一个农场、绑定一种专属小动物（`farmData.js` 定义科目→动物映射及商品/成长规则）；用户用能量领养动物、购买食物喂养提升成长值、购买装饰永久装扮农场。能量收支由 `farm` 云函数权威扣减并写入能量账本（`zx_farms` 表每科一行），无云端时本地降级同样可玩。

> **v1.9.4 安全与合规加固**：① 管理员自举默认关闭（需显式 `ALLOW_ADMIN_BOOTSTRAP=true` 或预置 `ADMIN_OPENIDS`/`zx_admins`）；② 答题加归属校验 + 幂等，堵住重复提交刷能量；③ 内容安全检测（本地高危词拦截 + 可选 `SEC_USE_MSGCSEC=true` 云端检测，fail-open 不阻断闭环）；④ 正式版关闭 vConsole；⑤ 新增尊重隐私设置的行为埋点（`zx_events` 表，默认不采集，需在隐私页开启匿名统计）。

## 二、如何运行

1. 打开**微信开发者工具** → 导入项目 → 选择本目录（`智学打卡小程序/`）。
2. AppID 已配置为 `wx8874a19dbd6fa717`（真实 AppID，支持真机预览/调试）。导入时请确保开发者工具已用该小程序管理员/开发者账号扫码登录。
3. 编译即可运行。**无需云环境**——Demo 阶段数据存在本地 Storage。

> 注意：项目根目录是含 `project.config.json` 的这一层，`miniprogramRoot` 已指向 `miniprogram/`。

## 三、体验完整闭环

| 步骤 | 操作 |
| --- | --- |
| ① 组卷 | 首页点「开始今日打卡」→ 系统按掌握度智能组 10 题 |
| ② 答题 | 选题提交 → 即时解析 → 掌握度实时加减分 |
| ③ 错题 | 故意答错 → 自动进错题本，按 1/3/7 天排期 |
| ④ 重刷 | 「我的」→「模拟下一天」推进日期 → 看错题到期重刷 |
| ⑤ 上传 | 「试卷」→「载入示例试卷」→ 模拟 OCR → 校对入库 |
| ⑥ 养成 | 答题得能量 → 星球进化、连签、徽章 |
| ⑦ 学情 | 答几题后看雷达图与薄弱点动态变化 |

> 注：早期 Demo 控制台（模拟下一天/重置数据/云函数联调）已在 v1.9.2 移除。「我的」页现为正式功能入口：资料、家长绑定与周报、学科教材、能量明细与补签、积分等级、隐私设置、管理员工具。

## 四、真实算法（非静态演示）

- **掌握度模型**：答对 `+12×(1−score/100)`，答错 `−15×(1+连错×0.1)`，0–100 截断。
- **智能组卷**：薄弱题(<60) + 到期错题 + 巩固题(≥85)，去重补足 10 题。
- **间隔重刷**：答错次日重刷；重刷答对按 1→3→7 天推进；连对 2 次且到第 3 阶段标记「攻克」。
- **养成激励**：打卡 +20、答对 +2、攻克盲区 +30 能量，星球按能量进化。

### 4.1 题型体系（与中考一致）

支持 **10 种题型 + 分科专属**，客观题云端自动判分，主观题 AI 按评分要点判分（模型不可用时降级学生自评）：

| 判分族 | q_type | 名称 | 作答控件 | answer 格式 |
| --- | --- | --- | --- | --- |
| 客观 | `single` | 单选题 | 选项点选 | 下标数字 |
| 客观 | `multiple` | 多选题 | 选项多选 | 下标数组 |
| 客观 | `judge` | 判断题 | 选项点选 | 0/1 |
| 客观 | `blank` | 填空题 | 逐空输入框 | 字符串数组（支持 `\|` 多答案别名） |
| 主观 | `solve` | 解答题 | 文本域 | 参考答案 + 评分要点 |
| 主观 | `calculation` | 计算题 | 文本域 | 参考答案 + 评分要点 |
| 主观 | `reading` | 阅读理解 | 文本域 | 参考答案 + 评分要点 |
| 主观 | `experiment` | 实验题 | 文本域 | 参考答案 + 评分要点 |
| 主观 | `translation` | 翻译题 | 文本域 | 参考答案 + 评分要点 |
| 主观 | `essay` | 作文 | 文本域 | 评分维度 + 满分 |

- **分科别名**：导入/AI 拆题支持中考叫法——完形填空→单选、默写→填空、书面表达→作文、证明题→解答。
- **AI 辅助判分**：主观题提交后调用生文模型按 `scoring_points` 给分（得分率 ≥0.6 判对），返回得分/点评；`AI_GRADE_MODEL` 可指定评分模型（默认 `glm-5.3-flash`）。模型不可用→对照参考答案学生自评，闭环不中断。
- **判分以云端为准**：客观题按 `zx_questions.answer` 自动比对，前端不传「是否正确」，杜绝伪造。
- **导入示例**：管理页「填入示例」给出单选/多选/填空/解答/作文的完整 JSON 与 CSV 样例。
- **相关迁移**：`cloudbase/migrations/20261122330000_question_types.sql`（加字段 + 全题型种子题）。

## 五、真机预览与云函数联调（重点）

本项目已配置真实 AppID `wx8874a19dbd6fa717`，并**默认采用「云端优先 + 本地降级」双模式**：
- **未配置云端**：全部逻辑走本地 Storage，真机上直接可玩，零配置。
- **配置好云端**：上传试卷、组卷、答题批改自动走云端三个云函数，联调控制台可验证。

### 5.0 当前架构：微信云函数直通（wx.cloud.callFunction）★ 必读

> 🔒 **安全架构（2026-11-22 升级）**：主链路已从 HTTP 网关切回 `wx.cloud.callFunction`。小程序已开通云开发并绑定 PG 环境 `progressive-zupu-d8eb6lsc7ee9feb`。**云函数身份只认微信运行时注入的 openid**（`wx-server-sdk.getWXContext().OPENID`，兜底环境变量 `WX_OPENID`），**完全忽略前端传入的 studentId**——外部/网关/CLI 调用拿不到 openid，一律返回 `-401` 拒绝，彻底堵死越权。HTTP 网关依赖的 request 合法域名、AppSecret 均不再需要。
>
> 验证：`tcb fn invoke login --params '{}'` 返回 `code:-401`（无微信身份被拒）；真机经 `wx.cloud.callFunction` 调用返回 `code:0` + 真实 openid。

#### 用户身份（openid 由云端注入，无需 AppSecret）

新增 `login` 云函数。App 启动后台调 `utils/auth.js` → `cloud.call('login')` → 云端拿到真实 openid → 缓存本地。所有云端方法经 `ensureStudentId()` 触发首次登录，**前端不传任何身份字段**。

- **首次建档**（幂等）：新 openid 自动在 `zx_users` 建档，并克隆 12 道确认种子题到自己名下，保证一进来就能组卷；重复登录不重复克隆。
- **数据隔离**：`composeTask`/`submitAnswer`/`recognize` 三个函数均以云端 openid 作为 `student_id`，答题、掌握度、错题按用户隔离。
- **跨设备一致**：同一微信账号在任何设备都是同一 openid（不再需要 AppSecret/code2session）。
- **降级**：仅当云开发不可用（未部署/基础库过旧）时，用本地匿名 ID 走纯本地 Demo。
- **真机验证**：「我的 → 云开发联调」显示身份为「微信身份（云端注入）」且四项全绿即生效；可删本地缓存后重进触发建档。

#### 真实 AI 识别试卷（2026-11-21 新增）

`recognize` 已接 CloudBase 视觉大模型，**拍照/选图即可自动 OCR + 拆题 + 打知识点标签**，不再是写死的样题。

- **识别链路**：图片读成 base64 data URL；PDF 先上传微信云存储换**公网临时 URL**（GLM 文件输入只接受公网 URL，不接受 base64）→ 经 `wx.cloud.callFunction` 传给 recognize → `app.ai().createModel('cloudbase').generateText({model:'glm-5.3-flash'})` 视觉模型一次性拆题 → 解析 JSON 归一化 → 写入 PG 待校对。
- **一键开启（你要做）**：腾讯云控制台 → **AI → 生文模型** → 开启 `glm-5.3-flash`（或资源点套餐内其他视觉模型）。云函数内走环境凭证，**无需单独 API Key**。
- **可选环境变量**（云函数 `recognize` → 函数配置 → 环境变量）：
  | 变量 | 默认 | 说明 |
  |---|---|---|
  | `AI_MODEL` | `glm-5.3-flash` | 视觉模型名，支持图片/PDF 的均可（如 `hy4-flash`、`kimi-k2.6`） |
  | `RECOGNIZE_MODE` | `ai` | 设为 `demo` 可强制走样题（省钱/调试用） |
  | `RECOGNIZE_DAILY_LIMIT` | `10` | 每人每天 AI 识别次数上限，防刷爆成本；超限返回 `-429` |
- **降级保证**：模型未开、无图片、识别/解析失败时自动回退样题，返回 `engine:'demo'` 和原因 `note`，答题闭环不中断。开启成功返回 `engine:'ai'`。
- **前端入口**：试卷页新增「📷 拍照 / 选图识别」（压缩图 < 5MB，效果最佳）和「📄 选择 PDF 文件」。

> 联调判断：识别后看返回/提示——「AI 识别完成，请校对」= 真实模型生效；「已用示例题体验识别」= 走了降级，去控制台开模型开关。

#### 试卷中心：三种导入方式统一入口（2026-11-22 新增）

「试卷」页提供三种把试卷变成题库的方式，**导入后都进入同一个「校对」页**，逐题确认/修改后一键入库：

| 方式 | 入口 | 后端 | 是否需要 AI |
| --- | --- | --- | --- |
| ① 拍照 / 选图识别 | 📷 | `recognize` 视觉模型（图片 base64） | 是 |
| ② 导入 PDF 识别 | 📄 | `recognize` 视觉模型（云存储公网 URL） | 是 |
| ③ Excel 批量导入 | 📊 | `recognize` 的 `importExcel` 动作（xlsx 解析） | **否** |

- **Excel 导入流程**：点「📥 下载样例」拿到 `题目导入样例.csv`（Excel 可直接打开，含全 10 种题型示例）→ 按列头填题 → 点「📊 选择 Excel」（支持 `.xlsx/.xls/.csv`，从微信聊天选文件）→ 云函数解析+全题型校验 → 进入校对页逐题确认/修改 → 「确认全部并入库」。
- **Excel 列头**（中文/英文别名均可）：`stem`题干、`q_type`题型、`options`选项（`|`分隔）、`answer`答案、`analysis`解析、`knowledge_tags`知识点、`subject`学科、`score`分值、`scoring_points`评分要点（`要点:分|要点:分`）。
- **题型**：`single`单选 / `multiple`多选 / `judge`判断 / `blank`填空 / `solve`解答 / `calculation`计算 / `reading`阅读 / `experiment`实验 / `translation`翻译 / `essay`作文，也支持中考叫法别名（完形填空、默写、书面表达等）。
- **无效行处理**：答案下标越界、缺答案、题干为空等行会被跳过并在导入后提示，有效题正常进入校对页；全无效则返回错误明细不入库。
- **身份与隔离**：Excel 由用户本人在试卷页导入，题目写在其 openid 名下，`need_confirm=true`，与 AI 识别题走同一确认链路；不占用 AI 识别次数（`RECOGNIZE_DAILY_LIMIT` 只统计 AI 来源）。

> 说明：管理端「我的 → 题库批量导入」（`importQuestions`）是另一条**管理员**通道，直接写入公共题库 `demo_student` 且 `confirmed=true`（无需校对、对所有新用户生效）；与试卷页的用户态 Excel 导入互不影响。

#### 养成数据上云（2026-11-22 新增）

能量/等级/连续打卡/徽章不再只存本地，改为 PostgreSQL `zx_gamification` 表按 openid 持久化，**换设备数据一致**。迁移文件：`20261122000001_gamification_cloud.sql`。

- **服务端权威**：能量计算在 `submitAnswer` 云函数内完成（答对 +2，完成打卡 +20 并记连续天数），前端无法伪造；login 建档时初始化，并回传快照供前端恢复。
- **前端**：`auth.js` 登录成功后、`cloudStore.submitAnswer` 批改后，用云端快照覆盖本地缓存（`store.applyCloudGamification`）。云不可用时仍走本地 Demo 逻辑。

#### 用户账号与头像昵称（2026-11-22 新增）

首次微信登录自动在 `zx_users`（用户管理模块）建档；用户可设置自己的昵称和头像，供老师同学识别。

- **微信官方能力**：头像用 `<button open-type="chooseAvatar">`（可选微信头像或相册），昵称用 `<input type="nickname">`（可一键用微信昵称）。微信 2021 年后已禁止静默获取真实头像昵称，此为官方现行方式，需用户主动填写。
- **存储链路**：头像先 `wx.cloud.uploadFile` 上传云存储拿 fileID，再随昵称写入 `zx_users.avatar / nickname`（表字段已就绪，无需迁移）。前端在「我 → 头像/昵称」进入设置页；首次登录未设置时自动弹窗引导。
- **云端接口**：`login` 云函数新增三个 action——`getProfile`（读本人资料）、`updateProfile`（只改本人昵称/头像，白名单字段，openid 鉴权）、`listUsers`（管理员查看所有注册用户，白名单 `ADMIN_OPENIDS ∪ zx_admins`，非管理员 `-403`）。
- **用户管理**：「我的 → 用户管理（管理员）」列出所有注册用户（头像/昵称/角色/注册与最近登录时间），入口等同 `admin` 页 `?tab=users`。

#### 校对编辑与错题导出（2026-11-22 新增）

- **题目校对**：「题目校对」页的「✎ 修改」打开编辑弹窗，可改题干/四选项/正确答案/解析/知识点标签，保存后经 `recognize` 的 `updateQuestion` 动作写回 PG（校验归属，只改本人题目）。此前是空壳提示。
- **错题导出**：错题本「📋 导出错题册」生成排版文本复制到剪贴板，可粘贴到备忘录/微信保存或打印。此前是空壳提示。

#### 不用 AI：题库批量导入（2026-11-22 新增）

不想开 AI 模型 / 没有试卷图片时，可用「我的 → 题库批量导入」直接把题目灌进公共题库，一次导入对所有新用户生效（新用户首次登录自动克隆 `demo_student` 名下已确认题）。

- **两种格式**：JSON 数组（或 `{subject,questions:[...]}`）与 CSV（首行表头 `stem,options,answer,analysis,knowledge_tags,subject`，选项/标签用 `|` 分隔，含逗号题干用英文双引号包裹）。
- **字段**：`stem`题干、`options`选项数组、`answer`正确答案下标（0=A,1=B,2=C,3=D）、`analysis`解析、`knowledge_tags`知识点（k1全等/k2一元二次/k3勾股距离/k4二次/k5一次/k6圆/k7相似/k8实数）、`id`可选（不填自动生成，同 id 重复导入会更新）、`difficulty`可选。
- **流程**：粘贴 → 「🔍 预览校验」（只校验不写库，显示有效/无效/错误明细）→ 「✅ 确认导入」。可勾选「同步给已有用户」让老账号也立刻拿到（跳过已有同题干）。
- **管理员鉴权**：`importQuestions` 云函数只认微信注入的 openid。白名单取「环境变量 `ADMIN_OPENIDS`（多个用逗号分隔）∪ 表 `zx_admins`」并集；两处都为空时**首个访问者自动自举为管理员**并写入 `zx_admins`。非管理员在页面可看到自己的 openid，发给管理员加白名单即可。无身份的 HTTP/CLI 调用返回 `-401`。
- **建表**：`cloudbase/migrations/20261122010000_admin_import.sql`（`zx_admins`）。

> 批量导入的题目 `confirmed=true`，直接进入组卷池，无需校对；这与 AI 识别题（`need_confirm=true` 待校对）不同。

#### 分科目打卡（2026-11-22 新增）

- **规则**：每天选 1 个科目打卡（首页科目条：综合 / 数学 / 英语 / 物理 / 化学 / 语文），组卷只出该科题目，当天仍只打卡一次（能量/连续天数逻辑不变）。**开始前可换科目，一旦开始答题则锁定当天科目，次日可换**。
- **综合模式**：默认「综合」= 所有科目混合出题，兼容旧行为。
- **组卷隔离**：题目池按 `subject` 过滤；薄弱点/强项只取本科目题目标签，错题只取本科目题目，避免数学标签干扰英语组卷。
- **空科目提示**：选了没有题目的科目会提示「该科目暂无题目，请先导入」，不会静默出空卷。
- **数据**：`zx_daily_tasks` 加 `subject` 字段（migration `20261122230000_daily_task_subject.sql`）；科目偏好存本地 `zx_quiz_subject`。
- **配套**：导入页新增快捷学科按钮；JSON 每条题目可带各自 `subject`，CSV 用 `subject` 列，实现一次导入多学科。

> ✅ **线上已部署验证通过（2026-11-22）**：云函数（`login`/`recognize`/`composeTask`/`submitAnswer`/`importQuestions`）已部署到 PG 环境 `progressive-zupu-d8eb6lsc7ee9feb`，均已加 `wx-server-sdk` 依赖；CLI/HTTP 无身份调用返回 `-401` 验证越权已堵死。真机经 `wx.cloud.callFunction` 的 openid 注入需在开发者工具验证（见上方"真机验证"）。
>
> ⚠️ **本次题型扩展后需重新部署**：`submitAnswer` 新增 `@cloudbase/node-sdk` 依赖（主观题 AI 判分），务必用 `--install-dependency true` 重新部署；并导入新迁移 `20261122330000_question_types.sql`。
>
> 下方 5.2/5.2.1/5.2.2 是早期 HTTP 网关 / wx.cloud 直调方案的记录，作为历史保留；**以本节为准**。

**① 云函数部署**（五个函数；`login`/`composeTask`/`submitAnswer`/`importQuestions` 依赖 `wx-server-sdk` + `@cloudbase/js-sdk`，recognize 另含 `@cloudbase/node-sdk`）：

```bash
tcb env use progressive-zupu-d8eb6lsc7ee9feb
tcb fn deploy --all --force --install-dependency true
```

**② 小程序云开发绑定**：开发者工具 → 云开发 → 确认当前 AppID 已开通并绑定环境 `progressive-zupu-d8eb6lsc7ee9feb`。代码 `app.js`/`cloud.js` 已写死该 ENV。

**③ 无需 HTTP 网关 / request 合法域名 / AppSecret**：主链路走 `wx.cloud.callFunction`，不经过 HTTPS，身份由微信运行时注入。旧的 `/login`、`/recognize`、`/composeTask`、`/submitAnswer` 网关路由已删除。

**④ 数据存储**：PG 的 `zx_` 表和种子数据不变，迁移文件照旧导入（见 5.2.1/5.2.2）。云函数通过 `app.rdb()`（管理员凭证）访问。

**⑤ 验证**：编译 → 预览 → 「我的 → 云开发联调」显示身份为「微信身份（云端注入）」且四项全绿；首页出现"云端智能组卷"，答题有"知识点变化"反馈。CLI 侧 `tcb fn invoke login --params '{}'` 应返回 `code:-401`（证明无微信身份被拒）。

### 5.1 真机预览（无需云开发）
1. 微信开发者工具用该 AppID 的管理员/开发者账号扫码登录。
2. 点工具栏「**预览**」→ 手机微信扫码，即可在真机跑完整 Demo。
3. 需要实时日志时用「**真机调试**」，电脑端可看 Console/AppData/Storage。

### 5.2 云函数联调（可选，需云开发）
> 本项目 `app.js` 已指定云环境 ID：`progressive-zupu-d8eb6lsc7ee9feb`，无需再手动填写。请确认该环境属于当前 AppID 且已部署下述云函数。

1. **开通云开发**：开发者工具顶部点「云开发」→ 开通（按提示创建环境，个人可用免费基础版）。
2. **创建数据库集合**：云开发控制台 → 数据库，新建以下集合（权限设为「仅创建者可读写」或按《数据库设计.md》）：
   `questions`、`mastery`、`wrongbook`、`daily_tasks`、`answer_record`、`papers`、`users`。
3. **部署云函数**：展开 `cloudfunctions/` 目录，对 `recognize`、`composeTask`、`submitAnswer` 三个目录**右键 → 上传并部署（云端安装依赖）**。
4. **重新编译**小程序（确保 `app.js` 的 `wx.cloud.init` 生效）。
5. **验证**：
   - 「试卷」页上传/载入示例 → 顶部提示「云函数识别完成」即走通 `recognize`。
   - 「我的」→「云函数联调」→「测试三个云函数」，逐个显示 ✓ 结果即全部部署成功。
   - 若某云函数显示 ✗，多为未部署或集合未建，按提示排查。

> 说明：`composeTask`/`submitAnswer` 需要对应集合存在且有数据才能返回理想结果；刚建的空集合调用不会报错但结果为空，属正常。`recognize` 已接 AI 视觉模型，未开模型开关或无图片时降级为样题。

#### 5.2.1 当前环境是 PostgreSQL：已改造为 PG 版并云端验证通过（2026-11-21）

环境 `progressive-zupu-d8eb6lsc7ee9feb` 的 `tcb env detail` 显示 `Source=qcloud`、`EnvChannel=qc_console`、`postgresql: enable`，是**腾讯云控制台创建的 PostgreSQL 环境，没有文档型 NoSQL**。因此已把云数据库层从 `wx-server-sdk` 的文档集合**彻底改造为 PostgreSQL**：

| 改造项 | 实现 |
| --- | --- |
| 数据表 | 用 migration 建 8 张 PG 表：`users / papers / questions / daily_tasks / answer_record / wrongbook / mastery / knowledge_tree`（`cloudbase/migrations/`），**均带 `zx_` 前缀** |
| 表分组隔离 | 8 张表统一命名为 `zx_*`（如 `zx_questions`、`zx_mastery`），与同库其他项目的表（`exam_papers`、`question_bank`、`ft_*` 等）清晰分开，避免混淆 |
| 云函数 SDK | `composeTask`/`submitAnswer` 从 `wx-server-sdk` 改为 `@cloudbase/js-sdk` v3 的 `app.rdb()`（云函数自动注入管理员凭证，无需密钥） |
| 依赖 | 云函数 `package.json` 依赖改为 `@cloudbase/js-sdk`，随包部署 |
| 部署配置 | `cloudbaserc.json` 记录 envId + 3 个函数的部署参数 |

> **为什么用表名前缀而不是 PostgreSQL Schema 分组？**
> PostgreSQL 原生的分组隔离是 Schema（模式），且 `@cloudbase/js-sdk` 的 `app.rdb({ schema })` 在类型上确实支持切换 schema。但**实测发现 CloudBase 托管的 PostgREST 网关只暴露固定 schema**（`public`/`auth`/`storage` 等），自建 schema 会被网关以 `Invalid schema: xxx` 拒绝，云函数完全读不到数据。因此在 CloudBase 环境下，用 `zx_` 表名前缀是唯一既能实现"分组不混淆"、又不破坏云函数访问的方案。迁移文件 `rename_to_zx_prefix.sql` 采用幂等写法，可在新旧环境安全重复执行。

**云端实测（全部通过）**：
- `tcb fn invoke recognize` → 返回 4 道结构化题 ✓
- `tcb fn invoke composeTask` → 按掌握度组出当日任务（含薄弱/强项分析）✓
- `tcb fn invoke submitAnswer` → 答错使 k2 掌握度 55→40、错题自动排到次日重刷 ✓
- 读库复核：`zx_answer_record` 写入、`zx_mastery` 更新、`zx_wrongbook` 排期均正确 ✓
- 表分组：8 张表全部改为 `zx_*` 前缀且数据无损，7 张核心表经 `app.rdb()` 读取全部正常 ✓

**种子数据**（供「我的 → 云函数联调」验证）：migration `seed_demo_data` 为 `demo_student` 灌入 5 道题 + 3 条掌握度，可重复执行不重复插入。

**CLI 常用命令**（在项目根目录）：
```bash
tcb env use progressive-zupu-d8eb6lsc7ee9feb      # 绑定环境
tcb db pg migration up                              # 应用建表/种子迁移
tcb fn deploy <name> --dir cloudfunctions/<name> --force --install-dependency true   # 部署单个云函数
tcb fn invoke <name> --params '{"..."}'             # 云端调用验证
tcb db execute --sql "SELECT * FROM zx_mastery LIMIT 5" --json   # 直接查 PG（注意 zx_ 前缀）
```

> **⚠️ 真机联调的两个前提仍需你在电脑端完成**：
> 1. 该环境是腾讯云侧创建的，小程序端 `wx.cloud.callFunction` 要调到它，需确认 AppID `wx8874a19dbd6fa717` 已**关联/授权访问**这个环境（云开发控制台 → 环境 → 关联应用 / 环境共享）。这一步我无法代劳。
> 2. 真机预览若报 `-601034`，是微信侧权限/关联问题，按 5.3 排查。后端 PG 链路本身已在云端完整验证通过，与前端无关。
>
> 备注：`recognize` 已接 AI 视觉模型（详见 5.0），未开模型开关时降级样题。本地 Demo 逻辑不受影响。

#### 5.2.2 答题闭环已切换云端（2026-11-21）

> 前端答题闭环已从「本地 Storage」切换为「**云端优先 + 本地缓存兜底**」。云端是权威数据源，本地 Storage 退化为缓存；云函数不可用时自动降级，Demo 仍可完整体验。

**改造范围**：

| 环节 | 云端函数 | 前端变化 |
| --- | --- | --- |
| 试卷识别 + 入库 | `recognize` | `papers.js` 上传文件到云存储后调用；题目直接写入 `zx_questions`（待校对） |
| 人工校对确认 | `recognize`（`action:'confirm'`） | `check.js` 确认后回调云端把题置为 confirmed，随后即可被组卷 |
| 智能组卷 | `composeTask` | `quiz.js` / `index.js` 调用；云端返回**任务 + 题目详情**，题目详情同步进缓存 |
| 答题判卷 | `submitAnswer` | `quiz.js` 调用；云端返回**掌握度增减 + 最新快照**，前端即时反馈并回写缓存 |

**关键文件**：
- `miniprogram/utils/cloudStore.js`：云端数据层，封装三个函数调用 + 缓存同步；云端失败直接抛出供页面降级。
- `cloudfunctions/composeTask/index.js`：新增返回题目详情（按 `question_ids` 顺序），答案/选项/知识点标签归一化。
- `cloudfunctions/submitAnswer/index.js`：新增返回 `deltas / mastery / wrongbook / taskProgress`，并推进每日任务进度。
- `cloudfunctions/recognize/index.js`：改用 `@cloudbase/js-sdk`，识别时写 PG、支持 `confirm` 动作。
- `cloudbase/migrations/20261121120000_seed_full_questions.sql`：补全 q1–q12 的完整选项/答案/解析（旧种子题 options 为空，云端组出的题无法渲染判题）。

**上线/联调前必做（三步）**：
```bash
# 1) 导入补全后的种子题库（幂等，可重复执行）
tcb db pg migration up

# 2) 重新部署云函数（全题型改造涉及 login 之外全部函数，submitAnswer 新增 node-sdk 依赖，务必带安装依赖）
for fn in recognize composeTask submitAnswer importQuestions login; do
  tcb fn deploy $fn --dir cloudfunctions/$fn --force --install-dependency true
done

# 3) 微信开发者工具重新编译；手机预览/真机调试走云端，开发者工具未开通云时自动降级本地
```

**验证方式**：
- 「我的 → 云函数联调」：三个函数应全绿；`recognize` 会提示「4 道题已写入 PG 待校对」。
- 「首页 → 开始打卡」：题目来自云端 `zx_questions`，加载态文案为"云端正在按你的掌握度智能组卷"。
- 答完题后查库确认闭环：`SELECT * FROM zx_answer_record ORDER BY answered_at DESC LIMIT 3;` + `SELECT knowledge_id, score, trend FROM zx_mastery;`

> 主观题 AI 判分需在云开发控制台「AI → 生文模型」开启模型权限（与识别共用开关）；未开启时主观题自动降级为「对照参考答案学生自评」。养成数据（能量、连续打卡天数）已上云 `zx_gamification`，换设备可恢复。

### 5.3 常见报错排查
| 报错 | 原因 | 解决 |
| --- | --- | --- |
| `-601034 没有权限，请先开通云开发或者云托管` | 该 AppID 尚未开通云开发 | 开发者工具左侧点「**云开发**」→ 开通并创建环境。**注意：真机预览也会报此错，因为开通操作只能在电脑端开发者工具完成，手机端无法开通。** 首次开通后需等约 10 分钟云 API 才可用 |
| `-501000 environment not found` | 环境 ID 不对或不属于该 AppID | 核对 `app.js` 中 `wx.cloud.init` 的 `env`（当前为 `progressive-zupu-d8eb6lsc7ee9feb`）是否为**环境 ID 而非环境名**，且该环境属于当前 AppID |
| `-501001 resource not found`（`collection.xxx:fail`） | 旧版云函数用文档型集合，但当前环境是 PostgreSQL | 已解决：云函数改用 `app.rdb()` 访问 PG 并建好表（见 5.2.1）。若仍见此错，确认已重新部署最新版云函数 |
| `FunctionName parameter could not be found` | 云函数未部署 | 右键云函数目录 → 上传并部署（云端安装依赖） |
| 控制台提示"已授权服务商"导致无权限 | 小程序绑定了第三方云开发服务商 | 公众平台 → 设置 → 第三方设置 → 解绑后重启开发者工具 |

### 5.4 联调相关配置说明
| 配置项 | 当前值 | 作用 |
| --- | --- | --- |
| `appid` | `wx8874a19dbd6fa717` | 真实 AppID，支持真机预览/调试 |
| `urlCheck` | `false` | 旧 HTTP 网关时代遗留，现走 wx.cloud 不经外部 HTTPS，保持默认即可 |
| `cloudfunctionRoot` | `cloudfunctions/` | 指定云函数根目录 |
| `wx.cloud.init.env` | `progressive-zupu-d8eb6lsc7ee9feb` | 指定云开发环境 ID，避免连错默认环境 |

## 六、从 Demo 升级到生产

1. **云环境**：开发者工具开通云开发，创建集合 `questions / mastery / wrongbook / daily_tasks / answer_record / users / papers`（字段见《数据库设计.md》）。
2. **部署云函数**：右键各云函数 → 上传并部署（含 `login`）；或 CLI `tcb fn deploy --all --force --install-dependency true`。
3. **前端改造（已完成）**：答题闭环已切到 `utils/cloudStore.js`，经 `wx.cloud.callFunction` 走四个云函数（`login`/`recognize`/`composeTask`/`submitAnswer`），身份由微信云端注入；本地 Storage 仅作缓存与降级。真实 AI 识别与 openid 登录均已接入（详见 5.0）。
4. **AI 能力**：小程序端 `wx.cloud.extend.AI.createModel('hunyuan-exp')` 可做文字生成（模型 `hunyuan-2.0-instruct-20251111`）；注意小程序端不支持图片生成。
5. **合规**：定位「学习工具」，完成小程序备案，遵循未成年人信息保护规范。

## 七、配套文档

- `01_产品需求文档_PRD.md`
- `02_数据库设计.md`
- `03_高保真页面原型.html`
- `04_最小闭环Demo.html`（Web 版可交互 Demo，逻辑与本小程序一致）
