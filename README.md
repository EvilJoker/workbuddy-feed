# 📒 WorkBuddy Feed

> 一个为个人与小团队打造的轻量级信息流 + 待办看板。发 memo、打标签、星标收藏、管理 ToDo —— 全部装进一个零依赖的 Node 服务里。

<div align="center">

![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![Deps](https://img.shields.io/badge/dependencies-0-blue) ![DB](https://img.shields.io/badge/storage-PostgreSQL-informational) ![License](https://img.shields.io/badge/license-MIT-orange)

**Feed 信息流** · **ToDo 看板** · **标签 & 收藏** · **成员体系** · **60s 自动刷新** · **移动端适配**

</div>

---

## ✨ 它是什么

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
浏览器 ──> server.js（零依赖，node:http）
              │
              ├── 静态文件 public/index.html（单文件前端，原生 JS）
              │
              └── HTTPS ──> 腾讯云 CloudBase 数据库网关（PostgREST）
                               public.memos / public.todos / public.users
```

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
