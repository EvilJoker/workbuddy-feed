#!/usr/bin/env node
'use strict';
/**
 * feed-cli —— WorkBuddy Feed / ToDo 的命令行客户端（Agent 友好）
 *
 * 设计目标：**省 token**。
 *  - 一次调用完成"认证 + 操作"，Agent 不需要先登录再发请求
 *  - 输出默认精简（只回 id / 标题），需要详情再 --full
 *  - 错误信息直接给出下一步动作，不回传大段 HTML
 *
 * 用法：
 *   feed-cli add "今日日报 #日报"                # 新建 memo
 *   feed-cli add "跟进 PR" --todo --status doing # 新建 todo
 *   feed-cli list --limit 5                      # 列 memo
 *   feed-cli list --todo --status doing          # 列进行中的 todo
 *   feed-cli list --tag 日报 --full              # 按标签查，带全文
 *   feed-cli get <id>                            # 看单条
 *   feed-cli update <id> --status done           # 改 todo 状态
 *   feed-cli update <id> --fav                   # 加收藏星标
 *   feed-cli update <id> --content "新内容"      # 改正文
 *   feed-cli delete <id>                         # 删
 *   feed-cli search 关键字                        # 全文搜索（memo + todo）
 *
 * 配置（环境变量或 .env）：
 *   FEED_BASE       服务地址，如 https://memos-cloud.app.workbuddy.host
 *   FEED_TOKEN      成员免密 token
 *   FEED_SHARECODE  分享码（托管网关要求每个请求都带）
 *   FEED_PASSWORD   访问密码（没有 token 时用；或用管理员密码建成员）
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');

// ---------------------------------------------------------------- 配置

function loadDotEnv() {
  // 从脚本所在项目根找 .env（也支持 ~/.config/feed-cli.env）
  const candidates = [
    process.env.FEED_ENV_FILE,
    path.join(__dirname, '..', '..', '.env'),
    path.join(process.env.HOME || '', '.config', 'feed-cli.env'),
  ].filter(Boolean);
  for (const f of candidates) {
    try {
      if (!fs.existsSync(f)) continue;
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        const key = m[1];
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
      }
      return true;
    } catch { /* 忽略 */ }
  }
  return false;
}
loadDotEnv();

// 凭据库兜底：密钥可以放在一个 JSON 文件里，避免出现在命令行 / 代码库中。
// 通过 FEED_KV_FILE 指定路径（形如 {"FEED_TOKEN":"xxx"}），未设置则不启用。
function fromKv(name) {
  if (process.env[name]) return process.env[name];
  const kvPath = process.env.FEED_KV_FILE;
  if (!kvPath) return '';
  try {
    if (!fs.existsSync(kvPath)) return '';
    const kv = JSON.parse(fs.readFileSync(kvPath, 'utf8'));
    const v = kv[name];
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

const BASE = (fromKv('FEED_BASE') || '').replace(/\/+$/, '');
const SHARE = fromKv('FEED_SHARECODE') || '';
const TOKEN = fromKv('FEED_TOKEN') || '';
const PASSWORD = fromKv('FEED_PASSWORD') || '';

// 服务端硬限制（server.js /api/messages）：一律在本地先拦，
// 不要让 agent 发出去才发现 413 too_long，或被 cleanName 静默截断成别人。
const MAX_MSG_CHARS = 8000;
const MAX_NAME_CHARS = 24;

// 应急文件柜：单文件 2MB（服务端同值），授权口令单独一把，和登录凭据分开
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const VAULT_KEY = fromKv('FEED_VAULT_KEY') || process.env.FEED_VAULT_KEY || '';

// ---------------------------------------------------------------- HTTP

// 为什么不用 fetch：部分精简运行时的 undici 会因 WASM 内存限制失败，node:https 更稳
function request(url, { method = 'GET', headers = {}, body, timeout = 40000, binary = false } = {}) {
  const u = new URL(url);
  const mod = u.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
      },
      (res) => {
        // 下载文件：原样收字节，不做 utf8 解码（会把二进制弄坏）
        if (binary) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }));
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
      }
    );
    // 必须设超时：托管网关偶发 ETIMEDOUT，没有超时会让整个调用挂住
    req.setTimeout(timeout, () => {
      req.destroy(new Error(`请求超时（${timeout}ms）：${method} ${u.pathname}`));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function withShare(pathname) {
  if (!SHARE) return BASE + pathname;
  return BASE + pathname + (pathname.includes('?') ? '&' : '?') + 'sharecode=' + encodeURIComponent(SHARE);
}

// ---------------------------------------------------------------- 会话

let COOKIE = '';

/** 用 token 换会话 cookie；没有 token 就用密码登录。网络失败自动重试。 */
async function login(attempt = 0) {
  if (COOKIE) return COOKIE;
  let res;
  try {
    if (TOKEN) {
      res = await request(withShare('/api/auth?token=' + encodeURIComponent(TOKEN)));
      if (res.status >= 400) die(`token 认证失败（HTTP ${res.status}）：token 可能已失效，请检查 FEED_TOKEN`);
    } else if (PASSWORD) {
      res = await request(withShare('/api/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      if (res.status >= 400) die(`密码登录失败（HTTP ${res.status}）：检查 FEED_PASSWORD`);
    } else {
      die('缺少凭据：设置 FEED_TOKEN（推荐）或 FEED_PASSWORD，或在项目 .env 里配置');
    }
  } catch (err) {
    // 登录是 GET 语义，重试安全
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      return login(attempt + 1);
    }
    die(`认证请求失败：${err && err.message ? err.message : String(err)}`);
  }
  // 注意：托管网关会下发多个 Set-Cookie（自己的 + 我们的），必须全部带上，
  // 只取第一条会 401
  const raw = res.headers['set-cookie'] || [];
  COOKIE = raw.map((c) => String(c).split(';')[0]).join('; ');
  if (!COOKIE) die('未拿到会话 cookie（服务端版本过旧？）');
  return COOKIE;
}

async function api(method, pathname, body, attempt = 0) {
  const cookie = await login();
  const payload = body === undefined ? undefined : JSON.stringify(body);
  let res;
  try {
    res = await request(withShare(pathname), {
      method,
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
      },
      body: payload,
    });
  } catch (err) {
    // 网络抖动 / 超时：自动重试 2 次（只对幂等风险低的写操作也重试，
    // 因为同一 id 的重复 POST 会产生重复内容，所以 POST 不重试）
    const canRetry = method !== 'POST';
    if (attempt < 2 && canRetry) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      return api(method, pathname, body, attempt + 1);
    }
    die(`网络请求失败：${err && err.message ? err.message : String(err)}${canRetry ? '' : '（写操作不做自动重试，避免重复写入）'}`);
  }
  let data = null;
  try { data = JSON.parse(res.text); } catch { /* 非 JSON */ }
  if (res.status >= 400) {
    const code = data && data.error ? data.error : '';
    const hint = {
      unauthorized: 'token 失效或未登录',
      forbidden: '权限不足（该操作需要管理员）',
      not_found: '对象不存在（id 可能写错）',
      bad_id: 'id 格式不对（需 36 位 UUID）',
      empty: '内容为空',
      vault_closed: '文件柜关着：先执行 feed vault open 30m 授权（人的动作，不是自动的）',
      bad_key: '授权口令不对：FEED_VAULT_KEY 与服务器 .env 的 VAULT_KEY 不一致',
      disabled: '服务器没配 VAULT_KEY，文件柜整体禁用（这是默认状态）',
      too_large: '文件超过 2MB 上限',
      quota_exceeded: '文件柜 10MB 已满：feed vault ls 看清单，删掉旧的再传',
    }[code] || `HTTP ${res.status}`;
    die(`操作失败：${hint}${code ? `（${code}）` : ''}`);
  }
  return data || {};
}

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (key === 'full' || key === 'fav' || key === 'unfav' || key === 'pin' || key === 'unpin' || key === 'help' || key === 'h') {
      out[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
    out[key] = next;
    i++;
  }
  return out;
}

function die(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

// ---------------------------------------------------------------- 输出

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function oneLine(s, max = 40) {
  const flat = String(s || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

// 精简输出：每条一行，只保留必要字段。--full 才给全文。
function printItems(items, kind, full) {
  if (!items.length) {
    console.log('（无结果）');
    return;
  }
  for (const it of items) {
    const tags = (it.tags || []).filter((t) => t !== '收藏').map((t) => '#' + t).join(' ');
    const fav = (it.tags || []).includes('收藏') ? '★' : ' ';
    const status = kind === 'todo' ? `[${it.status}] ` : '';
    if (full) {
      console.log(`${it.id}\n  ${fav}${status}${it.content}${tags ? '  ' + tags : ''}`);
      console.log(`  ${fmtTime(it.createdTs)} by ${it.author}`);
    } else {
      console.log(`${it.id.slice(0, 8)}  ${fav}${status}${oneLine(it.content, 46)}${tags ? '  ' + tags : ''}`);
    }
  }
  console.log(`共 ${items.length} 条`);
}

// 读取正文。
//  - add：位置参数就是正文（feed-cli add "文本"）
//  - update：位置参数是 id，正文只能来自 --content / --file / --stdin
//    （否则 `update <id> --status done` 会把 id 写成正文，把内容覆盖掉）
function readContent(args, { positional = false } = {}) {
  if (args.file) return fs.readFileSync(args.file, 'utf8').trim();
  if (args.stdin) return fs.readFileSync(0, 'utf8').trim();
  if (typeof args.content === 'string') return args.content.trim();
  if (positional && args._[0]) return args._[0].trim();
  return '';
}

// ---------------------------------------------------------------- 文件柜
// 原始字节请求：上传时 body 是 Buffer，下载时 binary=true 拿回 Buffer。
// 和 api() 分开是为了不把二进制塞进 JSON.stringify，也不想让 2MB 走 utf8 解码。
async function apiRaw(method, pathname, { body, binary = false, timeout = 120000 } = {}) {
  const cookie = await login();
  let res;
  try {
    res = await request(withShare(pathname), {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/octet-stream' } : {}),
        Cookie: cookie,
      },
      body,
      binary,
      timeout,
    });
  } catch (err) {
    die(`网络请求失败：${err && err.message ? err.message : String(err)}`);
  }
  if (res.status >= 400) {
    const txt = res.text !== undefined ? res.text : (res.buffer || Buffer.alloc(0)).toString('utf8');
    let d = null;
    try { d = JSON.parse(txt); } catch { /* 非 JSON */ }
    const code = (d && d.error) || '';
    const hint = {
      vault_closed: '文件柜关着：先执行 feed vault open 30m 授权（人的动作，不是自动的）',
      bad_key: '授权口令不对：FEED_VAULT_KEY 与服务器 .env 的 VAULT_KEY 不一致',
      disabled: '服务器没配 VAULT_KEY，文件柜整体禁用',
      too_large: '文件超过 2MB 上限',
      quota_exceeded: '文件柜 10MB 已满：feed vault ls 看清单，删掉旧的再传',
      not_found: '文件不存在（id 写错，或已过期被清理）',
    }[code] || `HTTP ${res.status}`;
    die(`操作失败：${hint}${code ? `（${code}）` : ''}`);
  }
  return res;
}

// '30m' / '2h' / '90'（无单位按分钟）→ 毫秒时长。
// 注意别和 parseSince 混：那个返回的是时间戳（now - 时长），不能拿来当窗口长度。
function parseDuration(v) {
  if (!v) return 0;
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*([smhd])?$/i);
  if (!m) return 0;
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[String(m[2] || 'm').toLowerCase()];
  return parseFloat(m[1]) * unit;
}

function fmtSize(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}K`;
  return `${(b / 1048576).toFixed(2)}M`;
}

function vaultUsageLine(s) {
  const state = s.enabled === false
    ? '已禁用（服务器未配 VAULT_KEY）'
    : s.open
      ? `已开启，剩 ${Math.ceil((s.remainingSec || 0) / 60)} 分钟`
      : '已关闭';
  return `文件柜：${state} · ${s.count || 0} 个文件 · ${fmtSize(s.used)} / ${fmtSize(s.quota)}（单文件上限 ${fmtSize(s.maxFile)}）`;
}

async function cmdVault(args) {
  const sub = args._[0] || 'status';

  if (sub === 'open' || sub === 'on') {
    if (!VAULT_KEY) die('没有授权口令：先把服务器的 VAULT_KEY 记到凭据库（setkey FEED_VAULT_KEY <值>）');
    const raw = args._[1] || args.minutes || '15m';
    const minutes = Math.max(1, Math.round(parseDuration(raw) / 60000));
    const res = await api('POST', '/api/vault/open', { minutes, key: VAULT_KEY });
    console.log(`✓ 已授权，窗口开启 ${Math.round(res.remainingSec / 60)} 分钟（到期自动关闭，进程重启也失效）`);
    console.log('  ' + vaultUsageLine(res));
    return;
  }

  if (sub === 'off' || sub === 'close') {
    const res = await api('POST', '/api/vault/close');
    console.log('✓ 文件柜已关闭');
    console.log('  ' + vaultUsageLine(res));
    return;
  }

  if (sub === 'ls' || sub === 'list') {
    const res = await api('GET', '/api/vault/files');
    const files = res.files || [];
    console.log(vaultUsageLine(res));
    if (!files.length) return;
    for (const f of files) {
      const age = Math.round((Date.now() - f.ts) / 60000);
      console.log(`${f.id}  ${fmtSize(f.size).padStart(7)}  ${f.name}  ${f.from}→${f.to}  ${age}m前`);
    }
    return;
  }

  if (sub === 'put' || sub === 'up') {
    const p = args._[1];
    if (!p) die('用法：feed vault put <本地文件> [--to 收件人] [--name 显示名]');
    if (!fs.existsSync(p)) die(`文件不存在：${p}`);
    const st = fs.statSync(p);
    if (st.isDirectory()) die(`这是目录，不支持整目录上传：${p}`);
    if (!st.size) die('文件是空的，没必要传');
    if (st.size > MAX_FILE_BYTES) {
      die(
        `文件 ${fmtSize(st.size)} 超过单文件上限 2MB（超 ${fmtSize(st.size - MAX_FILE_BYTES)}），未上传。\n` +
        '  改法：压缩、截取需要的片段，或分卷切成几个 ≤2MB 的文件'
      );
    }
    const buf = fs.readFileSync(p);
    const name = args.name || path.basename(p);
    const qs = '?name=' + encodeURIComponent(name) + (args.to ? '&to=' + encodeURIComponent(args.to) : '');
    const res = await apiRaw('POST', '/api/vault/files' + qs, { body: buf });
    const f = (res.text ? JSON.parse(res.text) : {}).file || {};
    console.log(`✓ file ${f.id} ${fmtSize(f.size)} ${f.name} → ${f.to}`);
    if (res.text && JSON.parse(res.text).dup) console.log('  （内容与已有文件相同，复用了那份，不额外占空间）');
    return;
  }

  if (sub === 'get' || sub === 'dl' || sub === 'down') {
    const id = args._[1];
    if (!id) die('用法：feed vault get <id> [--out 本地路径]');
    const list = await api('GET', '/api/vault/files');
    const hits = (list.files || []).filter((f) => f.id.startsWith(id));
    if (!hits.length) die(`没有这个文件：${id}（用 feed vault ls 看现有 id）`);
    if (hits.length > 1) die(`id "${id}" 不唯一，匹配到 ${hits.length} 个，请多给几位`);
    const meta = hits[0];
    const out = args.out || meta.name;
    const res = await apiRaw('GET', '/api/vault/files/' + meta.id, { binary: true });
    fs.writeFileSync(out, res.buffer);
    console.log(`✓ 已保存 ${out}（${fmtSize(res.buffer.length)}，来自 ${meta.from}→${meta.to}）`);
    return;
  }

  if (sub === 'rm' || sub === 'del' || sub === 'delete') {
    const id = args._[1];
    if (!id) die('用法：feed vault rm <id>');
    const res = await api('DELETE', '/api/vault/files/' + encodeURIComponent(id));
    console.log(`✓ 已删除 ${id}`);
    console.log('  ' + vaultUsageLine(res));
    return;
  }

  // 默认 status
  const s = await api('GET', '/api/vault/status');
  console.log(vaultUsageLine(s));
  if (s.enabled === false) {
    console.log('  服务器没有 VAULT_KEY，这个功能整体不可用（这是默认状态）');
  } else if (!s.open) {
    console.log('  要用先授权：feed vault open 30m');
  }
  if (s.ttlHours) console.log(`  文件 ${s.ttlHours} 小时后自动清理`);
}

// ---------------------------------------------------------------- 命令

async function cmdAdd(args) {
  const isTodo = args.todo === true || args.type === 'todo';
  const content = readContent(args, { positional: true });
  if (!content) die('内容为空：feed-cli add "文本" 或 --file <路径> 或 --stdin');
  const body = { content };
  if (isTodo) body.status = args.status || 'new';
  const res = await api('POST', isTodo ? '/api/todos' : '/api/memos', body);
  const it = res.memo || res.todo || {};
  const id = it.id || '';
  console.log(`✓ ${isTodo ? 'todo' : 'memo'} ${id.slice(0, 8)} ${(it.tags || []).map((t) => '#' + t).join(' ')}`.trim());
  if (args.full && it.content) console.log(it.content);
}

async function cmdList(args) {
  const isTodo = args.todo === true || args.type === 'todo';
  const params = [];
  if (args.limit) params.push('limit=' + encodeURIComponent(args.limit));
  if (args.offset) params.push('offset=' + encodeURIComponent(args.offset));
  if (args.tag) params.push('tag=' + encodeURIComponent(args.tag));
  if (args.status) params.push('status=' + encodeURIComponent(args.status));
  if (args.q) params.push('q=' + encodeURIComponent(args.q));
  if (args.fav) params.push('fav=1');
  const qs = params.length ? '?' + params.join('&') : '';
  const res = await api('GET', (isTodo ? '/api/todos' : '/api/memos') + qs);
  printItems(isTodo ? res.todos || [] : res.memos || [], isTodo ? 'todo' : 'memo', args.full);
}

// 解析 id：支持完整 UUID，也支持 list 输出里的 8 位短 id。
// 短 id 会被当作前缀匹配，先列出再定位（命中 0 个或多个都报明确错误）。
// 未显式指定 --todo 时，memo 与 todo 都查，避免"忘了加 --todo 就找不到"。
// 返回 { id, isTodo }：调用方据此决定用哪张表操作，
// 这样 `update <短id> --status done` 不必再加 --todo。
async function resolveId(id, isTodo) {
  if (/^[0-9a-fA-F-]{36}$/.test(id)) return { id, isTodo };

  const kinds = isTodo ? [['todo', '/api/todos', 'todos']] : [['memo', '/api/memos', 'memos']];
  if (!isTodo) kinds.push(['todo', '/api/todos', 'todos']);

  const checked = [];
  for (const [kind, path, key] of kinds) {
    const res = await api('GET', path);
    const hits = (res[key] || []).filter((it) => String(it.id).startsWith(id));
    if (hits.length === 1) return { id: hits[0].id, isTodo: kind === 'todo' };
    if (hits.length > 1) die(`短 id "${id}" 在 ${kind} 中不唯一，匹配到 ${hits.length} 条，请补全 id`);
    checked.push(kind);
  }
  die(`没找到 id 以 ${id} 开头的记录（已查 ${checked.join(' 和 ')}），用 list 确认 id`);
  return { id, isTodo };
}

async function cmdGet(args) {
  const raw = args._[0];
  if (!raw) die('用法：feed-cli get <id>');
  const r = await resolveId(raw, args.todo === true);
  const res = await api('GET', (r.isTodo ? '/api/todos/' : '/api/memos/') + encodeURIComponent(r.id));
  const it = res.memo || res.todo || {};
  console.log(JSON.stringify(it, null, 2));
}

async function cmdUpdate(args) {
  const raw = args._[0];
  if (!raw) die('用法：feed-cli update <id> [--content "文本"] [--status doing] [--fav|--unfav] [--pin|--unpin]');
  const r = await resolveId(raw, args.todo === true);
  const isTodo = r.isTodo;
  const patch = {};
  const content = readContent(args);
  if (content) patch.content = content;

  if (args.status) {
    if (!isTodo) die('--status 只适用于 todo（这条是 memo）');
    patch.status = args.status;
  }
  if (args.fav || args.unfav) {
    // 收藏是 tags 里的固定标签，需要先读当前 tags 再整体覆盖
    const cur = await api('GET', (isTodo ? '/api/todos/' : '/api/memos/') + encodeURIComponent(r.id));
    const it = cur.memo || cur.todo || {};
    const tags = new Set(it.tags || []);
    if (args.fav) tags.add('收藏'); else tags.delete('收藏');
    patch.tags = [...tags];
  }
  if (args.pin !== undefined || args.unpin !== undefined) {
    if (isTodo) die('--pin/--unpin 只适用于 memo（这条是 todo）');
    patch.pinned = args.pin === true;
  }
  if (!Object.keys(patch).length) die('没有要改的内容：加 --content / --status / --fav / --unfav');

  const res = await api('PATCH', (isTodo ? '/api/todos/' : '/api/memos/') + encodeURIComponent(r.id), patch);
  const it = res.memo || res.todo || {};
  console.log(`✓ 已更新 ${r.id.slice(0, 8)} ${(it.tags || []).map((t) => '#' + t).join(' ')}`.trim());
  if (args.full && it.content) console.log(it.content);
}

async function cmdDelete(args) {
  const raw = args._[0];
  if (!raw) die('用法：feed-cli delete <id> [--todo]');
  const r = await resolveId(raw, args.todo === true);
  await api('DELETE', (r.isTodo ? '/api/todos/' : '/api/memos/') + encodeURIComponent(r.id));
  console.log(`✓ 已删除 ${r.id.slice(0, 8)}`);
}

// ---------------------------------------------------------------- 消息队列
// 极简 MQ：一条消息 = 发送者 + 收件人 + 正文。收件人缺省 all（广播）。
// 服务端只保留最近 1000 条，所以这是"传话"，不是归档。

// 相对时间：30m / 2h / 3d；纯数字按毫秒（小于 1e12 当秒）；也接受 ISO 字符串
function parseSince(v) {
  if (!v) return 0;
  const s = String(v).trim();
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([smhd])$/i);
  if (m) {
    const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2].toLowerCase()];
    return Date.now() - parseFloat(m[1]) * unit;
  }
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

// 收件人/发送者名字：服务端 cleanName 会去掉所有空白并截到 24 字符。
// 静默截断会让消息发给一个不存在的名字（或看起来发给别人），所以本地先对齐规则：
// 去空白后仍超长 → 直接报错；只是去了空白 → stderr 提示真实收件人，不阻塞。
function normName(flag, v) {
  if (v == null || v === '') return undefined;
  const s = String(v);
  const norm = s.replace(/\s+/g, '');
  if (!norm) die(`${flag} 是空白，请给一个名字（默认 all）`);
  if (norm.length > MAX_NAME_CHARS) {
    die(`${flag} 太长：去空白后 ${norm.length} 字符，上限 ${MAX_NAME_CHARS} 字符 —— "${norm.slice(0, MAX_NAME_CHARS)}…" 请改短`);
  }
  if (norm !== s) console.error(`! ${flag} "${s}" 含空白，按服务端规则实际用 "${norm}"`);
  return norm;
}

async function cmdSend(args) {
  const content = readContent(args, { positional: true });
  if (!content) die('内容为空：feed-cli send "文本" [--to 收件人] [--from 发送者]');
  if (content.length > MAX_MSG_CHARS) {
    const over = content.length - MAX_MSG_CHARS;
    die(
      `消息正文 ${content.length} 字符，超过上限 ${MAX_MSG_CHARS}（超 ${over} 字符），未发送。\n` +
      '  改法二选一：① 拆成几条短消息发 ② 正文写到文件，消息里只给路径（服务端硬限 8000，超了必回 413）'
    );
  }
  const to = normName('--to', args.to) || 'all';
  const from = normName('--from', args.from);
  const body = { content, to };
  if (from) body.from = from;
  const res = await api('POST', '/api/messages', body);
  const it = res.message || {};
  console.log(`✓ msg ${String(it.id).slice(0, 8)} → ${it.recipient}（来自 ${it.sender}）`);
}

async function cmdInbox(args) {
  const params = [];
  if (args.to) params.push('to=' + encodeURIComponent(args.to));
  const since = parseSince(args.since);
  if (since) params.push('since=' + since);
  if (args.limit) params.push('limit=' + encodeURIComponent(args.limit));
  if (args.q) params.push('q=' + encodeURIComponent(args.q));
  const res = await api('GET', '/api/messages' + (params.length ? '?' + params.join('&') : ''));
  const list = res.messages || [];
  if (!list.length) {
    console.log('（暂无消息）');
    return;
  }
  for (const it of list) {
    const who = `${it.sender} → ${it.recipient}`;
    if (args.full) {
      console.log(`${it.id}\n  ${who} · ${fmtTime(it.createdTs)}\n  ${String(it.content).replace(/\n/g, '\n  ')}`);
    } else {
      console.log(`${String(it.id).slice(0, 8)}  ${fmtTime(it.createdTs)}  ${who}  ${oneLine(it.content, 50)}`);
    }
  }
  console.log(`共 ${list.length} 条${res.limit ? `（队列上限 ${res.limit}）` : ''}`);
}

async function cmdMsgRm(args) {
  const raw = args._[0];
  if (!raw) die('用法：feed-cli msgrm <id>');
  let id = raw;
  if (!/^[0-9a-fA-F-]{36}$/.test(raw)) {
    const res = await api('GET', '/api/messages?limit=1000');
    const hits = (res.messages || []).filter((it) => String(it.id).startsWith(raw));
    if (hits.length !== 1) die(`短 id "${raw}" 在消息里匹配到 ${hits.length} 条，用 inbox 确认 id`);
    id = hits[0].id;
  }
  await api('DELETE', '/api/messages/' + encodeURIComponent(id));
  console.log(`✓ 已删除消息 ${id.slice(0, 8)}`);
}

async function cmdSearch(args) {
  const q = (args._[0] || args.q || '').trim();
  if (!q) die('用法：feed-cli search <关键字>');
  const m = await api('GET', '/api/memos?q=' + encodeURIComponent(q));
  const t = await api('GET', '/api/todos?q=' + encodeURIComponent(q));
  const memos = m.memos || [];
  const todos = t.todos || [];
  if (memos.length) { console.log('— memo —'); printItems(memos, 'memo', args.full); }
  if (todos.length) { console.log('— todo —'); printItems(todos, 'todo', args.full); }
  if (!memos.length && !todos.length) console.log('（无结果）');
}

async function cmdHealth() {
  const res = await api('GET', '/api/health');
  console.log(JSON.stringify(res));
}

const HELP = `feed-cli —— WorkBuddy Feed / ToDo 命令行客户端

  add <文本>              新建 memo（--todo 建 todo，--status 指定状态）
  list                    列出（--todo / --tag / --status / --q / --fav / --limit / --full）
  get <id>                查看单条
  update <id>             修改（--content / --status / --fav / --unfav / --pin / --unpin）
  delete <id>             删除
  search <关键字>         搜索 memo + todo
  send <文本>             发消息给其他 agent（--to 收件人，默认 all；--from 覆盖发送者）
                          正文 ≤8000 字符、收件人/发送者名 ≤24 字符（本地先校验，超了不发）
  inbox                   收消息（--to 我 / --since 30m / --limit / --q / --full）
  msgrm <id>              删消息

  应急文件柜（默认关闭，必须人为授权；不进数据库，10MB 总量 / 单文件 2MB）
  vault                   看状态（是否开启、占用多少）
  vault open [30m]        人为授权，开一个限时窗口（到期自动关）
  vault off               立刻关
  vault ls                列出窗口内的文件
  vault put <文件> [--to 收件人] [--name 显示名]
  vault get <id> [--out 本地路径]
  vault rm <id>
  health                  服务与存储状态

配置：FEED_BASE / FEED_TOKEN / FEED_SHARECODE（或 FEED_PASSWORD），也可写在项目 .env
输出默认精简（省 token），加 --full 看全文。`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._.shift();

  if (!cmd || args.help || args.h) { console.log(HELP); return; }
  if (!BASE) die('缺少服务地址：设置 FEED_BASE 环境变量或项目 .env');

  switch (cmd) {
    case 'add': return cmdAdd(args);
    case 'list': case 'ls': return cmdList(args);
    case 'get': case 'show': return cmdGet(args);
    case 'update': case 'edit': return cmdUpdate(args);
    case 'delete': case 'rm': return cmdDelete(args);
    case 'search': case 'find': return cmdSearch(args);
    case 'send': case 'msg': return cmdSend(args);
    case 'inbox': return cmdInbox(args);
    case 'msgrm': return cmdMsgRm(args);
    case 'vault': return cmdVault(args);
    case 'health': return cmdHealth();
    default: die(`未知命令：${cmd}\n\n${HELP}`);
  }
}

main().catch((e) => die(e && e.message ? e.message : String(e)));
