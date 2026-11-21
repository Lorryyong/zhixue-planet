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

本项目已配置真实 AppID `wx8874a19dbd6fa717`，并**默认采用「本地优先 + 云端降级」双模式**：
- **未开云开发**：全部逻辑走本地 Storage，真机上直接可玩，零配置。
- **开了云开发并部署云函数**：上传试卷自动走 `recognize` 云函数，联调控制台可验证三个云函数。

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
| 数据表 | 用 migration 建 8 张 PG 表：`users / papers / questions / daily_tasks / answer_record / wrongbook / mastery / knowledge_tree`（`cloudbase/migrations/`） |
| 云函数 SDK | `composeTask`/`submitAnswer` 从 `wx-server-sdk` 改为 `@cloudbase/js-sdk` v3 的 `app.rdb()`（云函数自动注入管理员凭证，无需密钥） |
| 依赖 | 云函数 `package.json` 依赖改为 `@cloudbase/js-sdk`，随包部署 |
| 部署配置 | `cloudbaserc.json` 记录 envId + 3 个函数的部署参数 |

**云端实测（全部通过）**：
- `tcb fn invoke recognize` → 返回 4 道结构化题 ✓
- `tcb fn invoke composeTask` → 按掌握度组出当日任务（含薄弱/强项分析）✓
- `tcb fn invoke submitAnswer` → 答错使 k1 掌握度 70→55、答对使 k2 55→60、错题自动排到次日重刷 ✓
- 读库复核：`answer_record` 写入、`mastery` 更新、`wrongbook` 排期均正确 ✓

**种子数据**（供「我的 → 云函数联调」验证）：migration `seed_demo_data` 为 `demo_student` 灌入 5 道题 + 3 条掌握度，可重复执行不重复插入。

**CLI 常用命令**（在项目根目录）：
```bash
tcb env use progressive-zupu-d8eb6lsc7ee9feb      # 绑定环境
tcb db pg migration up                              # 应用建表/种子迁移
tcb fn deploy <name> --dir cloudfunctions/<name> --force --install-dependency true   # 部署单个云函数
tcb fn invoke <name> --params '{"..."}'             # 云端调用验证
tcb db execute --sql "SELECT * FROM mastery LIMIT 5" --json   # 直接查 PG
```

> **⚠️ 真机联调的两个前提仍需你在电脑端完成**：
> 1. 该环境是腾讯云侧创建的，小程序端 `wx.cloud.callFunction` 要调到它，需确认 AppID `wx8874a19dbd6fa717` 已**关联/授权访问**这个环境（云开发控制台 → 环境 → 关联应用 / 环境共享）。这一步我无法代劳。
> 2. 真机预览若报 `-601034`，是微信侧权限/关联问题，按 5.3 排查。后端 PG 链路本身已在云端完整验证通过，与前端无关。
>
> 备注：`recognize` 仍返回预置样题（生产接入点见源码 TODO）。本地 Demo 逻辑不受影响。

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
3. **前端改造**：把 `utils/store.js` 的 `getState/saveState` 换成云数据库读写；页面逻辑（onShow/事件）基本可复用。
4. **AI 能力**：小程序端 `wx.cloud.extend.AI.createModel('hunyuan-exp')` 可做文字生成（模型 `hunyuan-2.0-instruct-20251111`）；注意小程序端不支持图片生成。
5. **合规**：定位「学习工具」，完成小程序备案，遵循未成年人信息保护规范。

## 七、配套文档

- `01_产品需求文档_PRD.md`
- `02_数据库设计.md`
- `03_高保真页面原型.html`
- `04_最小闭环Demo.html`（Web 版可交互 Demo，逻辑与本小程序一致）
