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
│     ├─ papers/    试卷中心·上传（tab）
│     ├─ check/     AI识别·题目校对
│     ├─ quiz/      每日答题
│     ├─ wrong/     错题本·重刷（tab）
│     ├─ radar/     学情画像
│     ├─ planet/    养成·星球（tab）
│     └─ me/        个人中心（tab，含 Demo 控制台）
└─ cloudfunctions/              # 云函数（升级到真后端时用）
   ├─ recognize/     试卷识别拆题（Demo 返回样题，含生产 TODO）
   ├─ composeTask/   智能组卷
   └─ submitAnswer/  批改+掌握度+错题排期
```

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

「我的」页面有 **Demo 控制台**：模拟下一天、重置数据、直达学情，以及 **云函数联调测试**（见第六节）。

## 四、真实算法（非静态演示）

- **掌握度模型**：答对 `+12×(1−score/100)`，答错 `−15×(1+连错×0.1)`，0–100 截断。
- **智能组卷**：薄弱题(<60) + 到期错题 + 巩固题(≥85)，去重补足 10 题。
- **间隔重刷**：答错次日重刷；重刷答对按 1→3→7 天推进；连对 2 次且到第 3 阶段标记「攻克」。
- **养成激励**：打卡 +20、答对 +2、攻克盲区 +30 能量，星球按能量进化。

## 五、真机预览与云函数联调（重点）

本项目已配置真实 AppID `wx8874a19dbd6fa717`，并**默认采用「云端优先 + 本地降级」双模式**：
- **未配置云端**：全部逻辑走本地 Storage，真机上直接可玩，零配置。
- **配置好云端**：上传试卷、组卷、答题批改自动走云端三个云函数，联调控制台可验证。

### 5.0 当前架构：HTTP 访问服务（HTTP 网关）★ 必读

#### 真实 AI 识别试卷（2026-11-21 新增）

`recognize` 已接 CloudBase 视觉大模型，**拍照/选图即可自动 OCR + 拆题 + 打知识点标签**，不再是写死的样题。

- **识别链路**：小程序把图片/PDF 读成 base64 → HTTP 传给 recognize → `app.ai().createModel('cloudbase').generateText({model:'glm-5.3-flash'})` 视觉模型一次性拆题 → 解析 JSON 归一化 → 写入 PG 待校对。PDF 用 `glm-5.3-flash` 的文件输入能力。
- **一键开启（你要做）**：腾讯云控制台 → **AI → 生文模型** → 开启 `glm-5.3-flash`（或资源点套餐内其他视觉模型）。云函数内走环境凭证，**无需单独 API Key**。
- **可选环境变量**（云函数 `recognize` → 函数配置 → 环境变量）：
  | 变量 | 默认 | 说明 |
  |---|---|---|
  | `AI_MODEL` | `glm-5.3-flash` | 视觉模型名，支持图片/PDF 的均可（如 `hy4-flash`、`kimi-k2.6`） |
  | `RECOGNIZE_MODE` | `ai` | 设为 `demo` 可强制走样题（省钱/调试用） |
- **降级保证**：模型未开、无图片、识别/解析失败时自动回退样题，返回 `engine:'demo'` 和原因 `note`，答题闭环不中断。开启成功返回 `engine:'ai'`。
- **前端入口**：试卷页新增「📷 拍照 / 选图识别」（压缩图 < 5MB，效果最佳）和「📄 选择 PDF 文件」。

> 联调判断：识别后看返回/提示——「AI 识别完成，请校对」= 真实模型生效；「已用示例题体验识别」= 走了降级，去控制台开模型开关。

#### 用户登录与身份（2026-11-21 新增）

答题数据已按真实用户隔离，不再是全局共用的 `demo_student`。新增 `login` 云函数（路由 `/login`）：

- **自动登录**：App 启动后台调用 `utils/auth.js`，先读本地缓存 ID；没有则 `wx.login` 拿 code → `login` 云函数换真实 openid → 缓存。所有云端调用经 `ensureStudentId()` 拿到身份，并发只登录一次。
- **首次建档**：新用户自动在 `zx_users` 建档，并克隆 12 道确认种子题到自己名下，保证一进来就能组卷（幂等，重复登录不会重复克隆）。三个业务云函数无需改动。
- **两种模式**：
  | 模式 | 条件 | 特点 |
  |---|---|---|
  | `openid`（正式） | 云函数配了 `WX_APP_SECRET` | 真实微信身份，跨设备数据一致 |
  | `anonymous`（兜底） | 未配 secret 或登录失败 | 用本地匿名设备 ID，换设备数据不互通 |

**启用真实微信登录（上线前必做，一步配置）**：
1. 登录 `mp.weixin.qq.com` → 开发管理 → 开发设置 → 拿到 **AppSecret**（开发者密码）。
2. 腾讯云控制台 → 云函数 → `login` → 函数配置 → **环境变量** → 添加 `WX_APP_SECRET` = 上一步的密钥 → 保存。
   > AppSecret **只存在云端环境变量**，不写进代码、不进 GitHub 仓库。CLI 目前只能 `tcb fn env pull` 拉取，设置请走控制台。
3. 用户删掉小程序本地缓存（或卸载重装）后重新进入，即自动升级为 openid 模式。配置前匿名模式照常可用。

> ✅ **线上已部署验证通过（2026-11-21 20:48）**：三个业务云函数已部署到 PG 环境 `progressive-zupu-d8eb6lsc7ee9feb`，三条 HTTP 路由已创建，端到端 `POST` 测试均返回 `code:0`。`login` 云函数与 `/login` 路由于 21:20 追加部署，匿名建档 + 克隆 12 题 + 组卷 10 题已验证。
>
> **背景**：微信云开发 `wx.cloud` 不支持 PostgreSQL 环境，而本项目数据都在腾讯云 CloudBase 的 PG 环境里。因此**主链路已从 `wx.cloud.callFunction` 改为 HTTP 网关**：三个云函数各自挂一条 HTTPS 路由，小程序用 `wx.request` 调用。`wx.cloud` 现仅用于「上传 PDF/图片拿 fileID」，失败也不影响答题闭环。
>
> 下方 5.2/5.2.1/5.2.2 是早期 `wx.cloud` 直调方案的记录，作为历史保留；**以本节为准**。

**① 云函数部署**（代码已兼容 HTTP 触发：`parseEvent` 解析 `event.body`、`respond` 返回集成响应）：

```bash
tcb env use progressive-zupu-d8eb6lsc7ee9feb
tcb fn deploy --all --force --install-dependency true   # 含 login / recognize / composeTask / submitAnswer
```

**② 配置 HTTP 网关路由**：腾讯云控制台 → 环境 `progressive-zupu-d8eb6lsc7ee9feb` → **HTTP 网关 → 路由管理 → 新建**，加三条：

| 触发路径 | 关联资源 | 版本 |
|---|---|---|
| `/recognize` | recognize | $LATEST |
| `/composeTask` | composeTask | $LATEST |
| `/submitAnswer` | submitAnswer | $LATEST |

（等价 CLI：`tcb service create -p <路径> -f <函数> -e progressive-zupu-d8eb6lsc7ee9feb`）

**③ 前端域名（`miniprogram/utils/cloud.js` 顶部 `HTTP_BASE`）**：

```js
const HTTP_BASE = 'https://progressive-zupu-d8eb6lsc7ee9feb-1526320157.ap-shanghai.app.tcloudbase.com'
```

> 若控制台 HTTP 网关页显示的默认域名不同，改成那个域名即可（不含具体路由、结尾无斜杠）。

**④ 小程序 request 合法域名**：`mp.weixin.qq.com` → 开发管理 → 开发设置 → 服务器域名 → **request 合法域名**添加上面的域名。开发阶段可先在开发者工具勾选「不校验合法域名」，真机预览前务必补上。

**⑤ 数据存储**：PG 的 8 张 `zx_` 表和种子数据不变，迁移文件照旧导入（见 5.2.1/5.2.2）。云函数通过 `app.rdb()`（管理员凭证）访问，与 HTTP/wx.cloud 调用方式无关。

**⑥ 验证**：编译 → 预览 → 「我的 → HTTP 网关联调」三项全绿；首页出现"云端智能组卷"，答题有"知识点变化"反馈。

> ⚠️ 默认域名有访问提示中间页和限频，**生产环境必须绑定已备案自定义域名**。

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

> 说明：`composeTask`/`submitAnswer` 需要对应集合存在且有数据才能返回理想结果；刚建的空集合调用不会报错但结果为空，属正常。`recognize` 当前返回预置样题，生产接入点见其源码 TODO。

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
> 备注：`recognize` 仍返回预置样题（生产接入点见源码 TODO）。本地 Demo 逻辑不受影响。

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

# 2) 重新部署三个云函数（recognize 依赖已从 wx-server-sdk 换成 @cloudbase/js-sdk，务必带安装依赖）
for fn in recognize composeTask submitAnswer; do
  tcb fn deploy $fn --dir cloudfunctions/$fn --force --install-dependency true
done

# 3) 微信开发者工具重新编译；手机预览/真机调试走云端，开发者工具未开通云时自动降级本地
```

**验证方式**：
- 「我的 → 云函数联调」：三个函数应全绿；`recognize` 会提示「4 道题已写入 PG 待校对」。
- 「首页 → 开始打卡」：题目来自云端 `zx_questions`，加载态文案为"云端正在按你的掌握度智能组卷"。
- 答完题后查库确认闭环：`SELECT * FROM zx_answer_record ORDER BY answered_at DESC LIMIT 3;` + `SELECT knowledge_id, score, trend FROM zx_mastery;`

> 说明：养成数据（能量、连续打卡天数）当前仍存本地，云端 8 张表无对应表；如需跨设备同步，可后续扩展 `zx_users` 相关字段。

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
| `urlCheck` | `false` | 关闭域名校验，真机请求外部接口不被拦截（生产需配合法域名并改回 true） |
| `cloudfunctionRoot` | `cloudfunctions/` | 指定云函数根目录 |
| `wx.cloud.init.env` | `progressive-zupu-d8eb6lsc7ee9feb` | 指定云开发环境 ID，避免连错默认环境 |

## 六、从 Demo 升级到生产

1. **云环境**：开发者工具开通云开发，创建集合 `questions / mastery / wrongbook / daily_tasks / answer_record / users / papers`（字段见《数据库设计.md》）。
2. **部署云函数**：右键各云函数 → 上传并部署。`recognize` 里的 TODO 处接入真实 OCR + Hunyuan/DeepSeek。
3. **前端改造（已完成核心闭环）**：答题闭环已切到 `utils/cloudStore.js`，走 `recognize/composeTask/submitAnswer` 三个云函数，本地 Storage 仅作缓存与降级；剩余工作是接入真实 OCR/AI 拆题（见 `recognize` 的 TODO）与 openid 登录替换固定 `demo_student`。
4. **AI 能力**：小程序端 `wx.cloud.extend.AI.createModel('hunyuan-exp')` 可做文字生成（模型 `hunyuan-2.0-instruct-20251111`）；注意小程序端不支持图片生成。
5. **合规**：定位「学习工具」，完成小程序备案，遵循未成年人信息保护规范。

## 七、配套文档

- `01_产品需求文档_PRD.md`
- `02_数据库设计.md`
- `03_高保真页面原型.html`
- `04_最小闭环Demo.html`（Web 版可交互 Demo，逻辑与本小程序一致）
