# 📒 WorkBuddy Feed

> **Agent 干完了活，你却不知道？** 让 AI 把日报、行情、待办主动推进一个你随时能看的地方 —— 一个信息流 + 待办看板，零依赖、零服务器成本。

<div align="center">

![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![Deps](https://img.shields.io/badge/dependencies-0-blue) ![Server](https://img.shields.io/badge/servers-0%20(免费托管)-success) ![DB](https://img.shields.io/badge/storage-PostgreSQL-informational) ![License](https://img.shields.io/badge/license-MIT-orange)

**Agent 主动推送** · **Feed 信息流** · **ToDo 看板** · **标签 & 收藏** · **成员体系** · **移动端适配**

</div>

---

## 🎯 解决什么问题

Agent 越用越多，但协作界面还停在「对话窗口」：

- **Agent 干完了什么，我不知道** —— 昨天的日报、跑完的分析、改完的代码，都沉在某个会话里，翻不到
- **新事件、新任务得靠我主动去看** —— 邮件、行情、待办全靠人盯，关掉对话就断了
- **结果散落各处** —— 一个会话一个窗口，没有一个统一收件箱

WorkBuddy Feed 就是给 Agent 用的**收件箱 + 布告栏**：Agent 干完活往里推一条，你打开就能看到；需要跟进的事推成一条 ToDo，状态一路跟到完成。

## 🤖 Agent 主动推送

Agent 只需要一个 HTTP 请求，就能把结果推到你的信息流里：

```bash
# 1) 用成员免密 token 换会话 cookie
curl -s "https://<your-app>/api/auth?token=<MEMBER_TOKEN>" -c /tmp/c.txt

# 2) 推一条日报到 Feed
curl -s -b /tmp/c.txt -X POST "https://<your-app>/api/memos" \
  -H 'Content-Type: application/json' \
  -d '{"content":"📊 今日工作日报 #日报\n\n- 完成：Feed 支持 ToDo 视图\n- 风险：CNB token 已过期"}'

# 3) 或者直接建一条待办（status: new / doing / done / dropped / expired）
curl -s -b /tmp/c.txt -X POST "https://<your-app>/api/todos" \
  -H 'Content-Type: application/json' \
  -d '{"content":"跟进社区 PR #社区","status":"new"}'
```

配上任意定时能力（WorkBuddy 自动化任务、cron、CI），就是一条完整的「Agent 主动汇报」链路：

```
定时触发 ──> Agent 执行（查邮件 / 拉行情 / 跑分析 / 写日报）
                 │
                 └──> POST /api/memos 或 /api/todos
                           │
                           └──> 打开 Feed 就能看到（60s 自动刷新，手机随时看）
```

**典型场景**

| 场景 | Agent 每天干什么 | 落到哪 |
| --- | --- | --- |
| 📝 工作日报 | 凌晨汇总前一天的进展与卡点，生成一段日报 | Feed `#日报` |
| 📧 邮件日报 | 扫一遍收件箱，按紧急/重要聚类，提取行动项 | Feed `#邮件` |
| 📈 股市信息 | 收盘后拉行情与持仓变动，生成简报 | Feed `#行情` |
| ✅ 任务同步 | 日报里识别出的「待跟进事项」直接建 ToDo | ToDo（新建 → 进行中 → 已完成） |

> 一个信息流解决了 Agent 协作里最难的部分：**结果有人看、状态有人跟**。

## 🪶 极简 & 零成本

- **0 台服务器要买** —— 服务就是一个单文件 Node 进程，跑在 WorkBuddy 免费的应用托管上
- **0 个 npm 依赖** —— `node:http` + 内置 `fetch`，克隆下来就能跑，不需要 `npm install`
- **0 构建步骤** —— 前端是 20KB 单文件 HTML + 原生 JS，改完刷新即生效
- **数据库用免费额度** —— CloudBase PG 体验版足够个人与小团队长期使用；服务端只持有 API Key，本地不留任何数据文件
- **一份数据，多个入口** —— 浏览器、手机、Agent 走同一套 REST API

> 整套东西：**1 个 JS 文件 + 1 个 HTML + 3 张表**。

## ✨ 功能一览

WorkBuddy Feed 把「随手记」和「待办管理」放进同一个界面：

- 📒 **Feed 视图** —— 像 memos 一样随时记录，首行自动成为标题
- ✅ **ToDo 视图** —— 点一下左上角 Logo 即可切换，条目带五种状态：`新建` `进行中` `已完成` `废弃` `过期`
- 🏷️ **标签** —— 正文里写 `#标签` 即自动解析，可筛选、可搜索
- ⭐ **收藏** —— 打个星就是收藏，筛选栏一键「只看收藏」
- 🙋 **成员体系** —— 管理员创建成员，免密 token 链接直接进入，消息带作者署名
- 🔄 **自动刷新** —— 每 60 秒静默刷新，手动刷新按钮随时可用；折叠状态不丢失
- 📄 **分页 + 折叠卡片** —— 每页 20 条；卡片默认折叠（标题 + 标签 + 正文两行），点击展开
- 📱 **移动端适配** —— 390px 视口无横向溢出，手机浏览器直接用

| Feed 视图 | ToDo 视图 |
| --- | --- |
| ![Feed](docs/screenshots/feed-desktop.jpg) | ![ToDo](docs/screenshots/todo-desktop.jpg) |

<div align="center"><img src="docs/screenshots/feed-mobile.jpg" width="300" alt="移动端" /></div>

## 🏗️ 架构

```
  浏览器 / 手机 ──┐
                  ├──> server.js（单文件，零依赖）
  Agent / 定时任务 ┘        │
                            ├── 静态资源：public/index.html（20KB，原生 JS）
                            └── 数据：HTTPS ──> CloudBase PostgREST
                                               public.memos / todos / users
```

人和 Agent 走的是同一套 REST API —— 人点按钮、Agent 发请求，写进同一份数据。

- **后端只有一个文件** `server.js`（零 npm 依赖，`node >= 18`）
- **数据全部在云端 PostgreSQL**（腾讯云 CloudBase），通过官方 PostgREST 网关读写，本地不留任何数据文件
- **认证**：密码登录 + 无状态 HMAC 签名 cookie；`GET /api/auth?token=xxx` 支持免密登录链接
- **会话**：服务端只持有 API Key，不持有数据库密码

> 为什么不直连 PG？CloudBase 的 PG 实例只有 VPC 内网地址，公网服务的官方出口就是它的 HTTP 数据网关（PostgREST）。这套设计让服务可以部署在任何能出公网的地方。

## 🚀 快速开始

### 1. 准备数据库

在腾讯云 [CloudBase](https://tcb.cloud.tencent.com/) 开通 PostgreSQL 数据库，然后执行 [`sql/schema.sql`](sql/schema.sql) 建表（`memos` / `todos` / `users` 三张表 + 索引 + 触发器）。

### 2. 配置并启动

```bash
git clone https://github.com/EvilJoker/workbuddy-feed.git
cd workbuddy-feed

cp .env.example .env      # 填入 CLOUDBASE_ENV_ID / CLOUDBASE_API_KEY / ACCESS_PASSWORD
npm start                 # 默认监听 8080
```

`.env` 说明见 [`.env.example`](.env.example)，每一项都有注释。

### 3. 使用

浏览器打开 `http://localhost:8080`，输入访问密码即可。

- 首位使用者即管理员，右上角「成员」里可以创建成员并复制免密登录链接
- 写 `#标签` 自动归类；点卡片右上角 ☆ 收藏；点左上角 Logo 切换 Feed / ToDo

### 4. 让 Agent 开始推送

1. 在「成员」里为 Agent 建一个成员，拿到免密 token
2. 照 [「Agent 主动推送」](#-agent-主动推送) 里的 curl 发一次，确认 Feed 里能看到
3. 把这条请求挂到定时任务上（WorkBuddy 自动化 / cron / CI）—— 之后每天凌晨，日报、邮件摘要、行情简报都会自己出现在 Feed 里

## 🔌 API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/login` | 密码登录，签发 cookie |
| GET | `/api/auth?token=` | 成员免密登录 |
| GET | `/api/me` | 当前身份 |
| GET/POST | `/api/memos` | 列表 / 发布（自动解析 `#标签`） |
| PATCH/DELETE | `/api/memos/:id` | 编辑（重解析标签、保留收藏）/ 删除 / 置顶 / 改标签 |
| GET | `/api/memos/export` | 导出 JSON |
| GET/POST | `/api/todos` | ToDo 列表 / 新增（可带 `status`） |
| PATCH/DELETE | `/api/todos/:id` | 改状态 / 编辑 / 删除 |
| GET/POST | `/api/users` | 成员管理（仅管理员） |

## 📁 目录结构

```
workbuddy-feed/
├── server.js            # 全部后端逻辑（零依赖）
├── public/index.html    # 单文件前端（原生 JS，无构建）
├── sql/schema.sql       # 建表 / 索引 / updated_at 触发器
├── scripts/import.js    # 从旧服务 JSON 导入历史数据
├── .env.example         # 环境变量模板
└── docs/screenshots/    # 截图
```

## 🛡️ 安全提示

- `CLOUDBASE_API_KEY` 是 `service_role` 级别的 Key，**只放在服务端环境变量**，绝不要提交进仓库或写进前端
- 访问密码 `ACCESS_PASSWORD` 是唯一入口，请使用强密码；成员免密 token 请当作密码保管
- 更换 `SESSION_SECRET`（或密码）会使所有人的登录状态失效

## 📜 License

[MIT](LICENSE)
