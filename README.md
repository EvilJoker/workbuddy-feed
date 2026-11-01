# My Memos · CloudBase 版后端

个人 memo 服务的**服务端改造版**：数据层从"自建 SQL / 本地文件"换成 **腾讯云 CloudBase PostgreSQL**，
通过 CloudBase 的 PostgREST HTTP 接口读写。前端一行没改，接口契约与线上完全一致。

- 线上原版：`https://a52908d90661c0f0c.app.workbuddy.host/?sharecode=...`
- 数据库：CloudBase 环境 `sqyworkbuddybase-d6exnh2af5c8aef` / 库 `postgres-nbuh23sa` / 表 `public.memos`

## 为什么走 HTTP API 而不是直连 PG

CloudBase 的 PG 实例只有 VPC 内网地址（`30.251.13.89:50213`），云沙箱/公网服务连不上。
官方给的对外通道是 PostgREST：

```
https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest/<表名>
Authorization: Bearer <API Key>
```

所以本服务端**只持有 API Key、不持有数据库密码**，也不在本地留任何 SQLite/JSON 数据文件。

> ⚠️ 用的 Key 是 `web-server`（`service_role`，绕过 RLS，等同超级权限）。
> **只能放在服务端环境变量里**，绝不能出现在前端代码、Git 仓库或截图里。

## 目录

```
memos-cloud/
├── server.js          # 全部后端逻辑（零依赖，node >= 18）
├── public/index.html  # 前端（与线上版本一致）
├── sql/schema.sql     # 建表 / 索引 / updated_at 触发器
├── scripts/import.js  # 旧数据导入（保留原始时间戳）
├── .env.example       # 环境变量模板
└── package.json
```

## 部署

### 1. 准备数据库（只需一次，已在本机执行过）

```bash
export PATH=~/.workbuddy/binaries/node/versions/22.22.2/bin:$HOME/.workbuddy/binaries/node/cli-connector-packages/bin:$PATH
export TCB_CLI_SOURCE=workbuddy
tcb db execute -e sqyworkbuddybase-d6exnh2af5c8aef --sql "$(cat sql/schema.sql)"
```

表结构：

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid PK | `gen_random_uuid()` |
| content | text | 正文（含 `#标签`） |
| tags | text[] | 写入时由服务端从正文解析 |
| pinned | boolean | 置顶 |
| created_at | timestamptz | 创建时间 |
| updated_at | timestamptz | 修改时间（触发器自动刷新） |

索引：`created_at desc`、`(pinned desc, created_at desc)`、`tags` 的 GIN。

### 2. 配置并启动

```bash
cp .env.example .env
# 填 CLOUDBASE_API_KEY（真值在 ~/.config/cloudbase/web-server.apikey）
node server.js        # 默认 8080
```

环境变量：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `CLOUDBASE_API_KEY` | ✅ | service_role key，仅服务端 |
| `CLOUDBASE_ENV_ID` | ✅ | 默认 `sqyworkbuddybase-d6exnh2af5c8aef` |
| `CLOUDBASE_REST_BASE` | | 默认由 envId 推导，一般不用填 |
| `ACCESS_PASSWORD` | | 页面访问密码，默认 `memos2026` |
| `SESSION_SECRET` | | cookie 签名密钥；不填则从密码派生（换密码=全员掉线） |
| `MEMOS_TABLE` | | 默认 `memos` |
| `PORT` | | 默认 8080 |

### 3. 发布到 WorkBuddy site

把本项目（`server.js` + `public/` + `.env`）作为 Node 应用发布即可，
启动命令 `node server.js`，健康检查 `GET /api/health`。
部署环境必须能访问 `https://<envId>.api.tcloudbasegateway.com`（公网 HTTPS）。

## 接口（与旧版一致）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | `{password}` → 校验通过下发 HttpOnly cookie |
| POST | `/api/logout` | 清 cookie |
| GET | `/api/memos` | `{memos:[{id,content,tags,pinned,createdTs,updatedTs}]}` |
| POST | `/api/memos` | `{content}` → 新建（自动解析 `#标签`） |
| PATCH | `/api/memos/:id` | `{content?}` / `{pinned?}` |
| DELETE | `/api/memos/:id` | 删除 |
| GET | `/api/memos/export` | 下载 JSON 全量备份 |
| GET | `/api/health` | 免登录存活探测 |

会话是**无状态 HMAC cookie**（30 天），服务重启不掉线，也不需要 Redis。

## 旧数据迁移

```bash
# 旧服务导出：浏览器打开 /api/memos/export，或 curl
node scripts/import.js ./memos-2026-11-01.json --dry-run   # 先看前 3 条
node scripts/import.js ./memos-2026-11-01.json             # 真正写入
```

时间戳会按原始 `createdTs/updatedTs` 保留，导入后顺序不变。

## 排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 启动报 `缺少 CLOUDBASE_API_KEY` | `.env` 没填或没读到 |
| 接口 500 且日志有 `PostgREST ... 404` | 表不存在 / 表名不对，重跑 `sql/schema.sql` |
| 接口 500 且 `401` / `JWSError` | API Key 失效或不是该环境的 key |
| 页面一直停在登录框 | 密码不对，或 cookie 被浏览器拦（跨站时设 `COOKIE_SECURE=1` 走 https） |
| 打开是 JSON 不是页面 | 上次那个 bug 的老问题：检查是否还残留「把 HTML 序列化成 JSON」的响应逻辑，本版静态文件用 `fs.readFile` + `text/html` 直出 |
