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

// ---------------------------------------------------------------- HTTP

// 为什么不用 fetch：部分精简运行时的 undici 会因 WASM 内存限制失败，node:https 更稳
function request(url, { method = 'GET', headers = {}, body } = {}) {
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
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
      }
    );
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

/** 用 token 换会话 cookie；没有 token 就用密码登录。 */
async function login() {
  if (COOKIE) return COOKIE;
  let res;
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
  // 注意：托管网关会下发多个 Set-Cookie（自己的 + 我们的），必须全部带上，
  // 只取第一条会 401
  const raw = res.headers['set-cookie'] || [];
  COOKIE = raw.map((c) => String(c).split(';')[0]).join('; ');
  if (!COOKIE) die('未拿到会话 cookie（服务端版本过旧？）');
  return COOKIE;
}

async function api(method, pathname, body) {
  const cookie = await login();
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const res = await request(withShare(pathname), {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: payload,
  });
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
async function resolveId(id, isTodo) {
  if (/^[0-9a-fA-F-]{36}$/.test(id)) return id;
  const kind = isTodo ? 'todo' : 'memo';
  const listKey = isTodo ? 'todos' : 'memos';
  const res = await api('GET', (isTodo ? '/api/todos' : '/api/memos'));
  const hits = (res[listKey] || []).filter((it) => String(it.id).startsWith(id));
  if (hits.length === 1) return hits[0].id;
  if (!hits.length) die(`没找到 id 以 ${id} 开头的${kind}（用 list 确认 id）`);
  die(`短 id "${id}" 不唯一，匹配到 ${hits.length} 条，请补全 id`);
  return '';
}

async function cmdGet(args) {
  const raw = args._[0];
  if (!raw) die('用法：feed-cli get <id>');
  const isTodo = args.todo === true;
  const id = await resolveId(raw, isTodo);
  const res = await api('GET', (isTodo ? '/api/todos/' : '/api/memos/') + encodeURIComponent(id));
  const it = res.memo || res.todo || {};
  console.log(JSON.stringify(it, null, 2));
}

async function cmdUpdate(args) {
  const raw = args._[0];
  if (!raw) die('用法：feed-cli update <id> [--content "文本"] [--status doing] [--fav|--unfav] [--pin|--unpin]');
  const isTodo = args.todo === true;
  const id = await resolveId(raw, isTodo);
  const patch = {};
  const content = readContent(args);
  if (content) patch.content = content;

  if (args.status) {
    if (!isTodo) die('--status 只适用于 todo（加 --todo）');
    patch.status = args.status;
  }
  if (args.fav || args.unfav) {
    // 收藏是 tags 里的固定标签，需要先读当前 tags 再整体覆盖
    const cur = await api('GET', (isTodo ? '/api/todos/' : '/api/memos/') + encodeURIComponent(id));
    const it = cur.memo || cur.todo || {};
    const tags = new Set(it.tags || []);
    if (args.fav) tags.add('收藏'); else tags.delete('收藏');
    patch.tags = [...tags];
  }
  if (args.pin !== undefined || args.unpin !== undefined) {
    if (isTodo) die('--pin/--unpin 只适用于 memo');
    patch.pinned = args.pin === true;
  }
  if (!Object.keys(patch).length) die('没有要改的内容：加 --content / --status / --fav / --unfav');

  const res = await api('PATCH', (isTodo ? '/api/todos/' : '/api/memos/') + encodeURIComponent(id), patch);
  const it = res.memo || res.todo || {};
  console.log(`✓ 已更新 ${id.slice(0, 8)} ${(it.tags || []).map((t) => '#' + t).join(' ')}`.trim());
  if (args.full && it.content) console.log(it.content);
}

async function cmdDelete(args) {
  const raw = args._[0];
  if (!raw) die('用法：feed-cli delete <id> [--todo]');
  const isTodo = args.todo === true;
  const id = await resolveId(raw, isTodo);
  await api('DELETE', (isTodo ? '/api/todos/' : '/api/memos/') + encodeURIComponent(id));
  console.log(`✓ 已删除 ${id.slice(0, 8)}`);
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
    case 'health': return cmdHealth();
    default: die(`未知命令：${cmd}\n\n${HELP}`);
  }
}

main().catch((e) => die(e && e.message ? e.message : String(e)));
