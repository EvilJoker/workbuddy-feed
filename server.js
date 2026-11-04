'use strict';
/**
 * My Memos — 后端服务（本地 SQLite 版）
 *
 * 设计要点：
 *  - 零第三方依赖：node:http + node:sqlite（node >= 22.5），不需要 npm install
 *  - 数据落在本地单个 SQLite 文件（默认 ./data/feed.db），备份 = 复制文件
 *  - 不依赖任何云服务，没有配额、没有按小时计费、不会被平台停机
 *  - 前端契约保持不变（/api/login /api/memos ...），换存储不影响页面
 */

const http = require('node:http');
const dns = require('node:dns');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// 部分沙箱环境 IPv6 解析优先但出口不支持 IPv6，强制 IPv4 优先
try { dns.setDefaultResultOrder('ipv4first'); } catch {}

// ---------------------------------------------------------------- .env（零依赖加载，不覆盖已有环境变量）
(function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
})();

// ---------------------------------------------------------------- 配置
const PORT = Number(process.env.PORT || 8080);

const db = require('./src/db');

// TODO 状态：新建 / 进行中 / 已完成 / 废弃 / 过期
const TODO_STATUS = ['new', 'doing', 'done', 'dropped', 'expired'];

const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || 'memos2026';
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update('wbmemos:' + ACCESS_PASSWORD).digest('hex');

const COOKIE_NAME = 'wbmemos';
const SESSION_MAX_AGE = 60 * 60 * 24 * 365; // 1 年：token 链接进入后长期免密

// 星标收藏 = 藏在 tags 里的固定标签，前端 ★ 直接读写这个标签
const FAV_TAG = '收藏';

const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------- 数据访问
// 全部收敛在 ./src/db.js（本地 SQLite）。这里只保留业务需要的组合逻辑。

// ---------------------------------------------------------------- 数据映射
// DB 行 -> 前端契约（createdTs / updatedTs 为毫秒时间戳）
function toDto(row) {
  const created = Date.parse(row.created_at);
  const updated = Date.parse(row.updated_at || row.created_at);
  return {
    id: row.id,
    content: row.content,
    tags: row.tags || [],
    author: row.author || '管理员',
    pinned: !!row.pinned,
    createdTs: Number.isFinite(created) ? created : Date.now(),
    updatedTs: Number.isFinite(updated) ? updated : Date.now(),
  };
}

// 从正文里解析 #标签（首字符或空白之后，遇到空白/#/< 结束）
function parseTags(content) {
  const out = new Set();
  const re = /(?:^|\s)#([^\s#<>"'`]+)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const tag = m[1].replace(/[，。、；：！？）】」』,.;:!?)\]}"']+$/u, '');
    if (tag) out.add(tag);
  }
  return [...out];
}

// DB 行 -> TODO 前端契约
function toTodoDto(row) {
  const t = toDto(row);
  return { ...t, status: TODO_STATUS.includes(row.status) ? row.status : 'new' };
}

// ---------------------------------------------------------------- 会话（无状态 HMAC cookie）
function sign(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}

function issueToken(session) {
  const exp = Date.now() + SESSION_MAX_AGE * 1000;
  const body = Buffer.from(JSON.stringify({ exp, name: session.name, role: session.role })).toString('base64url');
  return `${body}.${sign(body)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return false;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expect = sign(body);
  if (sig.length !== expect.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;

  let session = null;
  let exp = NaN;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload && typeof payload.exp === 'number' && payload.name && payload.role) {
      exp = payload.exp;
      session = { name: String(payload.name).slice(0, 40), role: payload.role === 'admin' ? 'admin' : 'member' };
    }
  } catch { /* 旧版纯 exp 格式，走下面兼容分支 */ }
  if (!session) {
    // 兼容旧 cookie（"毫秒时间戳.签名"）
    const n = Number(body);
    if (Number.isFinite(n)) { exp = n; session = { name: '管理员', role: 'admin' }; }
  }
  if (!Number.isFinite(exp) || exp <= Date.now()) return false;
  return session;
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function getSession(req) {
  return verifyToken(parseCookies(req)[COOKIE_NAME]);
}

function isAuthed(req) {
  return !!getSession(req);
}

function cookieHeader(token, maxAge = SESSION_MAX_AGE) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (process.env.COOKIE_SECURE === '1') parts.push('Secure');
  return parts.join('; ');
}

// ---------------------------------------------------------------- HTTP 工具
function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 256) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // SPA 兜底：非静态资源一律回首页
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) return res.writeHead(404).end('not found');
        res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(html);
      });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

// ---------------------------------------------------------------- 路由
// 分页：?limit=N&offset=M，缺省不限（保持老行为）
function applyRange(rows, params) {
  const off = Number(params.get('offset') || 0);
  const lim = Number(params.get('limit') || 0);
  let out = rows;
  if (Number.isFinite(off) && off > 0) out = out.slice(off);
  if (Number.isFinite(lim) && lim > 0) out = out.slice(0, lim);
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method || 'GET';

  try {
    // ---- 登录 / 登出 / token 免密进入
    if (p === '/api/login' && method === 'POST') {
      const body = await readBody(req);
      if (body.password !== ACCESS_PASSWORD) {
        return sendJson(res, 401, { error: 'bad_password' });
      }
      return sendJson(res, 200, { ok: true, name: '管理员', role: 'admin' }, {
        'Set-Cookie': cookieHeader(issueToken({ name: '管理员', role: 'admin' })),
      });
    }

    // 专属 token 链接免密登录：GET /api/auth?token=<uuid>
    if (p === '/api/auth' && method === 'GET') {
      const tk = url.searchParams.get('token') || '';
      if (!/^[0-9a-fA-F-]{36}$/.test(tk)) return sendJson(res, 401, { error: 'bad_token' });
      const u = db.findUserByToken(tk);
      if (!u) return sendJson(res, 401, { error: 'bad_token' });
      return sendJson(res, 200, { ok: true, name: u.name, role: u.role }, {
        'Set-Cookie': cookieHeader(issueToken({ name: u.name, role: u.role })),
      });
    }

    if (p === '/api/logout' && method === 'POST') {
      return sendJson(res, 200, { ok: true }, {
        'Set-Cookie': cookieHeader('', 0),
      });
    }

    // ---- 健康检查（免登录，用于存活探测）
    if (p === '/api/health' && method === 'GET') {
      return sendJson(res, 200, { ok: true, storage: 'sqlite', dbPath: db.DB_PATH, ...db.stats() });
    }

    // ---- 以下接口都需要登录
    if (p.startsWith('/api/')) {
      if (!isAuthed(req)) return sendJson(res, 401, { error: 'unauth' });
    }

    // ---- 当前登录身份
    if (p === '/api/me' && method === 'GET') {
      const s = getSession(req);
      return sendJson(res, 200, { name: s.name, role: s.role });
    }

    // ---- 成员管理（仅管理员）
    if (p === '/api/users' && method === 'GET') {
      const s = getSession(req);
      if (s.role !== 'admin') return sendJson(res, 403, { error: 'forbidden' });
      return sendJson(res, 200, { users: db.listUsers() });
    }

    if (p === '/api/users' && method === 'POST') {
      const s = getSession(req);
      if (s.role !== 'admin') return sendJson(res, 403, { error: 'forbidden' });
      const body = await readBody(req);
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 24) : '';
      if (!name) return sendJson(res, 400, { error: 'empty_name' });
      if (db.findUserByName(name)) return sendJson(res, 409, { error: 'name_exists' });
      const created = db.createUser({ name, role: 'member' });
      return sendJson(res, 201, { user: { id: created.id, name: created.name, role: created.role, token: created.token } });
    }

    const mu = p.match(/^\/api\/users\/([^/]+)$/);
    if (mu && method === 'DELETE') {
      const s = getSession(req);
      if (s.role !== 'admin') return sendJson(res, 403, { error: 'forbidden' });
      const id = decodeURIComponent(mu[1]);
      if (!/^[0-9a-fA-F-]{36}$/.test(id)) return sendJson(res, 400, { error: 'bad_id' });
      const target = db.findUserById(id);
      if (!target) return sendJson(res, 404, { error: 'not_found' });
      if (target.role === 'admin') return sendJson(res, 400, { error: 'cannot_delete_admin' });
      db.deleteUser(id);
      return sendJson(res, 200, { ok: true });
    }

    // ---- 导出（放在 /api/memos/:id 之前匹配）
    if (p === '/api/memos/export' && method === 'GET') {
      const memos = db.listMemos().map(toDto);
      const stamp = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="memos-${stamp}.json"`,
      });
      return res.end(JSON.stringify({ exportedAt: new Date().toISOString(), count: memos.length, memos }, null, 2));
    }

    // ---- SQLite 一致性快照下载（仅管理员；供外部备份管线拉取）
    if (p === '/api/backup' && method === 'GET') {
      const s = getSession(req);
      if (s.role !== 'admin') return sendJson(res, 403, { error: 'forbidden' });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const tmp = `${db.DB_PATH}.snap-${stamp}`;
      // VACUUM INTO：单读事务导出完整快照，WAL 模式下也不会拷到半个事务
      db.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const body = fs.readFileSync(tmp);
      fs.unlinkSync(tmp);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': body.length,
        'Content-Disposition': `attachment; filename="feed-${stamp}.db"`,
      });
      return res.end(body);
    }

    // ---- 列表（支持 limit/offset/tag/status/q/fav 服务端过滤，缺省返回全部）
    if (p === '/api/memos' && method === 'GET') {
      let rows = db.listMemos().map(toDto);
      const tag = url.searchParams.get('tag');
      const fav = url.searchParams.get('fav');
      const q = (url.searchParams.get('q') || '').trim();
      if (tag) rows = rows.filter((r) => (r.tags || []).includes(tag));
      if (fav === '1' || fav === 'true') rows = rows.filter((r) => (r.tags || []).includes(FAV_TAG));
      if (q) rows = rows.filter((r) => String(r.content || '').includes(q));
      rows = applyRange(rows, url.searchParams);
      return sendJson(res, 200, { memos: rows });
    }

    // ---- 新建（作者取当前登录身份）
    if (p === '/api/memos' && method === 'POST') {
      const s = getSession(req);
      const body = await readBody(req);
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      if (!content) return sendJson(res, 400, { error: 'empty' });
      const created = db.createMemo({
        content,
        tags: parseTags(content),
        author: s.name,
      });
      return sendJson(res, 201, { memo: toDto(created) });
    }

    // ---- 单条：改 / 删
    const m = p.match(/^\/api\/memos\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (!/^[0-9a-fA-F-]{36}$/.test(id)) return sendJson(res, 400, { error: 'bad_id' });

      if (method === 'GET') {
        const one = db.getMemo(id);
        if (!one) return sendJson(res, 404, { error: 'not_found' });
        return sendJson(res, 200, { memo: toDto(one) });
      }

      if (method === 'PATCH') {
        const body = await readBody(req);
        const patch = {};
        if (typeof body.content === 'string') {
          const content = body.content.trim();
          if (!content) return sendJson(res, 400, { error: 'empty' });
          patch.content = content;
          const tags = parseTags(content);
          // 正文里没写 #收藏 时也要保住星标（否则一编辑就掉星）
          if (!tags.includes(FAV_TAG)) {
            const cur = db.getMemo(id);
            const old = cur && Array.isArray(cur.tags) ? cur.tags : [];
            if (old.includes(FAV_TAG)) tags.push(FAV_TAG);
          }
          patch.tags = tags;
        }
        // 星标收藏：直接覆盖 tags（前端 ★ 走这里）
        if (Array.isArray(body.tags)) {
          const clean = body.tags
            .filter((t) => typeof t === 'string')
            .map((t) => t.trim().replace(/^#+/, '').replace(/\s+/g, '').slice(0, 40))
            .filter(Boolean);
          patch.tags = [...new Set(clean)].slice(0, 30);
        }
        if (typeof body.pinned === 'boolean') patch.pinned = body.pinned;
        if (!Object.keys(patch).length) return sendJson(res, 400, { error: 'nothing_to_update' });
        patch.updated_at = new Date().toISOString();

        const updated = db.updateMemo(id, patch);
        if (!updated) return sendJson(res, 404, { error: 'not_found' });
        return sendJson(res, 200, { memo: toDto(updated) });
      }

      if (method === 'DELETE') {
        db.deleteMemo(id);
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 405, { error: 'method_not_allowed' });
    }

    // ---- TODO：列表（支持 limit/offset/tag/status/q/fav 服务端过滤）
    if (p === '/api/todos' && method === 'GET') {
      let rows = db.listTodos().map(toTodoDto);
      const tag = url.searchParams.get('tag');
      const status = url.searchParams.get('status');
      const fav = url.searchParams.get('fav');
      const q = (url.searchParams.get('q') || '').trim();
      if (tag) rows = rows.filter((r) => (r.tags || []).includes(tag));
      if (status) rows = rows.filter((r) => r.status === status);
      if (fav === '1' || fav === 'true') rows = rows.filter((r) => (r.tags || []).includes(FAV_TAG));
      if (q) rows = rows.filter((r) => String(r.content || '').includes(q));
      rows = applyRange(rows, url.searchParams);
      return sendJson(res, 200, { todos: rows });
    }

    // ---- TODO：新建
    if (p === '/api/todos' && method === 'POST') {
      const s = getSession(req);
      const body = await readBody(req);
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      if (!content) return sendJson(res, 400, { error: 'empty' });
      const status = TODO_STATUS.includes(body.status) ? body.status : 'new';
      const created = db.createTodo({
        content,
        tags: parseTags(content),
        author: s.name,
        status,
      });
      return sendJson(res, 201, { todo: toTodoDto(created) });
    }

    // ---- TODO：单条改 / 删
    const td = p.match(/^\/api\/todos\/([^/]+)$/);
    if (td) {
      const id = decodeURIComponent(td[1]);
      if (!/^[0-9a-fA-F-]{36}$/.test(id)) return sendJson(res, 400, { error: 'bad_id' });

      if (method === 'GET') {
        const one = db.getTodo(id);
        if (!one) return sendJson(res, 404, { error: 'not_found' });
        return sendJson(res, 200, { todo: toTodoDto(one) });
      }

      if (method === 'PATCH') {
        const body = await readBody(req);
        const patch = {};
        if (typeof body.content === 'string') {
          const content = body.content.trim();
          if (!content) return sendJson(res, 400, { error: 'empty' });
          patch.content = content;
          const tags = parseTags(content);
          // 正文里没写 #收藏 时也要保住星标
          if (!tags.includes(FAV_TAG)) {
            const cur = db.getTodo(id);
            const old = cur && Array.isArray(cur.tags) ? cur.tags : [];
            if (old.includes(FAV_TAG)) tags.push(FAV_TAG);
          }
          patch.tags = tags;
        }
        if (Array.isArray(body.tags)) {
          const clean = body.tags
            .filter((t) => typeof t === 'string')
            .map((t) => t.trim().replace(/^#+/, '').replace(/\s+/g, '').slice(0, 40))
            .filter(Boolean);
          patch.tags = [...new Set(clean)].slice(0, 30);
        }
        if (TODO_STATUS.includes(body.status)) patch.status = body.status;
        if (!Object.keys(patch).length) return sendJson(res, 400, { error: 'nothing_to_update' });
        patch.updated_at = new Date().toISOString();

        const updated = db.updateTodo(id, patch);
        if (!updated) return sendJson(res, 404, { error: 'not_found' });
        return sendJson(res, 200, { todo: toTodoDto(updated) });
      }

      if (method === 'DELETE') {
        db.deleteTodo(id);
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 405, { error: 'method_not_allowed' });
    }

    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not_found' });

    // ---- 静态页面
    if (method === 'GET' || method === 'HEAD') return serveStatic(req, res, url.pathname);
    return res.writeHead(405).end('method not allowed');
  } catch (err) {
    console.error('[error]', req.method, req.url, err && err.message);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error', detail: String(err && err.detail || err && err.message) });
    else res.end();
  }
});

// 首次启动时确保存在管理员记录（专属免密链接依赖它）
const adminUser = db.ensureAdmin();

server.listen(PORT, () => {
  console.log(`[memos-cloud] listening on :${PORT}`);
  console.log(`[memos-cloud] storage: sqlite ${db.DB_PATH}`);
  const s = db.stats();
  console.log(`[memos-cloud] data: ${s.memos} memos / ${s.todos} todos / ${s.users} users`);
  console.log(`[memos-cloud] admin token: ${adminUser.token}`);

  // 可选：COS 异地备份定时任务（默认关闭；需要时在 .env 配置 COS_* 即启用）
  const cos = require('./src/cos_task').createCosTask({ DB_PATH: db.DB_PATH, db });
  if (cos.enabled()) cos.schedule();
});
