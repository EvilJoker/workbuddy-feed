'use strict';
/**
 * My Memos — 后端服务（CloudBase PostgreSQL / PostgREST 版）
 *
 * 设计要点：
 *  - 零第三方依赖，只用 node 内置模块（node >= 18，需要全局 fetch）
 *  - 存储全部走 CloudBase 的 PostgREST HTTP 接口，不直连数据库、不落本地 SQLite/JSON 文件
 *  - service_role 的 API Key 只存在于服务端环境变量，绝不下发到浏览器
 *  - 前端契约与线上版本保持完全一致（/api/login /api/memos ...）
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

const ENV_ID = process.env.CLOUDBASE_ENV_ID || 'sqyworkbuddybase-d6exnh2af5c8aef';
// PostgREST 基址：https://<env>.api.tcloudbasegateway.com/v1/rdb/rest
const REST_BASE =
  process.env.CLOUDBASE_REST_BASE ||
  `https://${ENV_ID}.api.tcloudbasegateway.com/v1/rdb/rest`;
const API_KEY = process.env.CLOUDBASE_API_KEY || '';
const TABLE = process.env.MEMOS_TABLE || 'memos';

const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || 'memos2026';
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update('wbmemos:' + ACCESS_PASSWORD).digest('hex');

const COOKIE_NAME = 'wbmemos';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 天

const PUBLIC_DIR = path.join(__dirname, 'public');

if (!API_KEY) {
  console.error('[fatal] 缺少 CLOUDBASE_API_KEY，服务端无法访问数据库');
  process.exit(1);
}

// ---------------------------------------------------------------- PostgREST 客户端
// fetch 失败时自动重试一次，并把底层错误码带出来方便诊断
async function rest(pathAndQuery, { method = 'GET', body, prefer } = {}, attempt = 0) {
  const url = `${REST_BASE}/${pathAndQuery}`;
  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      return rest(pathAndQuery, { method, body, prefer }, attempt + 1);
    }
    const cause = err && err.cause;
    const code = cause && (cause.code || cause.message);
    const e = new Error(`PostgREST fetch failed${code ? ` (${code})` : ''}`);
    e.detail = `${err.message}${code ? ` cause=${code}` : ''}`;
    throw e;
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const msg = typeof data === 'object' && data ? data.message || JSON.stringify(data) : data;
    throw new Error(`PostgREST ${method} ${pathAndQuery} -> ${res.status}: ${msg}`);
  }
  return data;
}

// ---------------------------------------------------------------- 数据映射
// DB 行 -> 前端契约（createdTs / updatedTs 为毫秒时间戳）
function toDto(row) {
  const created = Date.parse(row.created_at);
  const updated = Date.parse(row.updated_at || row.created_at);
  return {
    id: row.id,
    content: row.content,
    tags: row.tags || [],
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

// ---------------------------------------------------------------- 会话（无状态 HMAC cookie）
function sign(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}

function issueToken() {
  const exp = String(Date.now() + SESSION_MAX_AGE * 1000);
  return `${exp}.${sign(exp)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return false;
  const exp = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expect = sign(exp);
  if (sig.length !== expect.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  const expMs = Number(exp);
  return Number.isFinite(expMs) && expMs > Date.now();
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

function isAuthed(req) {
  return verifyToken(parseCookies(req)[COOKIE_NAME]);
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
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method || 'GET';

  try {
    // ---- 登录 / 登出
    if (p === '/api/login' && method === 'POST') {
      const body = await readBody(req);
      if (body.password !== ACCESS_PASSWORD) {
        return sendJson(res, 401, { error: 'bad_password' });
      }
      return sendJson(res, 200, { ok: true }, {
        'Set-Cookie': cookieHeader(issueToken()),
      });
    }

    if (p === '/api/logout' && method === 'POST') {
      return sendJson(res, 200, { ok: true }, {
        'Set-Cookie': cookieHeader('', 0),
      });
    }

    // ---- 健康检查（免登录，用于存活探测）
    if (p === '/api/health' && method === 'GET') {
      return sendJson(res, 200, { ok: true, storage: 'cloudbase-postgres', table: TABLE });
    }

    // ---- 以下接口都需要登录
    if (p.startsWith('/api/')) {
      if (!isAuthed(req)) return sendJson(res, 401, { error: 'unauth' });
    }

    // ---- 导出（放在 /api/memos/:id 之前匹配）
    if (p === '/api/memos/export' && method === 'GET') {
      const rows = await rest(
        `${TABLE}?select=id,content,tags,pinned,created_at,updated_at&order=created_at.desc`
      );
      const memos = (rows || []).map(toDto);
      const stamp = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="memos-${stamp}.json"`,
      });
      return res.end(JSON.stringify({ exportedAt: new Date().toISOString(), count: memos.length, memos }, null, 2));
    }

    // ---- 列表
    if (p === '/api/memos' && method === 'GET') {
      const rows = await rest(
        `${TABLE}?select=id,content,tags,pinned,created_at,updated_at&order=pinned.desc,created_at.desc`
      );
      return sendJson(res, 200, { memos: (rows || []).map(toDto) });
    }

    // ---- 新建
    if (p === '/api/memos' && method === 'POST') {
      const body = await readBody(req);
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      if (!content) return sendJson(res, 400, { error: 'empty' });
      const now = new Date().toISOString();
      const row = await rest(TABLE, {
        method: 'POST',
        body: [{ content, tags: parseTags(content), created_at: now, updated_at: now }],
        prefer: 'return=representation',
      });
      const created = Array.isArray(row) ? row[0] : row;
      return sendJson(res, 201, { memo: toDto(created) });
    }

    // ---- 单条：改 / 删
    const m = p.match(/^\/api\/memos\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (!/^[0-9a-fA-F-]{36}$/.test(id)) return sendJson(res, 400, { error: 'bad_id' });

      if (method === 'PATCH') {
        const body = await readBody(req);
        const patch = {};
        if (typeof body.content === 'string') {
          const content = body.content.trim();
          if (!content) return sendJson(res, 400, { error: 'empty' });
          patch.content = content;
          patch.tags = parseTags(content);
        }
        if (typeof body.pinned === 'boolean') patch.pinned = body.pinned;
        if (!Object.keys(patch).length) return sendJson(res, 400, { error: 'nothing_to_update' });
        patch.updated_at = new Date().toISOString();

        const row = await rest(`${TABLE}?id=eq.${id}`, {
          method: 'PATCH',
          body: patch,
          prefer: 'return=representation',
        });
        const updated = Array.isArray(row) ? row[0] : row;
        if (!updated) return sendJson(res, 404, { error: 'not_found' });
        return sendJson(res, 200, { memo: toDto(updated) });
      }

      if (method === 'DELETE') {
        await rest(`${TABLE}?id=eq.${id}`, { method: 'DELETE' });
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

server.listen(PORT, () => {
  console.log(`[memos-cloud] listening on :${PORT}`);
  console.log(`[memos-cloud] storage: ${REST_BASE}/${TABLE}`);
});
