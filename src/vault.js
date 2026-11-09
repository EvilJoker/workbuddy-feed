'use strict';
/**
 * 应急文件柜（Vault）—— 极简文件中转站，**不是网盘**
 *
 * 定位与铁律：
 *  - **默认关闭**：没有 VAULT_KEY 就整体禁用，接口一律 501；
 *  - **必须人为授权**：即使配了 KEY，也要显式 open 一个**限时窗口**才能上传/下载/删除，
 *    窗口到期自动失效，进程重启也自动失效（状态只在内存里）；
 *  - **不进数据库**：元数据是内容旁边的旁挂 JSON，删文件就是删两个文件；
 *  - **限额死板**：单文件 ≤2MB、总量 ≤10MB，写满就拒，不做自动扩容。
 *
 * 磁盘布局（与 feed.db 同级，重新部署不会覆盖）：
 *   <vault>/<id>.bin   内容
 *   <vault>/<id>.json  元数据 { id, name, size, sha256, from, to, ts }
 */

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

// 位置：沙箱里跟库放一起（项目目录之外，重传项目目录不会覆盖）
function defaultDir() {
  if (process.env.VAULT_DIR) return process.env.VAULT_DIR;
  if (fs.existsSync('/workspace')) return '/workspace/.feed-data/vault';
  return path.join(__dirname, '..', 'data', 'vault');
}

const DIR = defaultDir();
const MAX_FILE = Number(process.env.VAULT_MAX_FILE || 2 * 1024 * 1024); // 2MB
const QUOTA = Number(process.env.VAULT_QUOTA || 10 * 1024 * 1024); // 10MB
const TTL_HOURS = Number(process.env.VAULT_TTL_HOURS ?? 24); // 0 = 不自动清理
const MAX_WINDOW_MIN = 120;
const KEY = process.env.VAULT_KEY || '';

const ID_RE = /^[0-9a-f]{16}$/;

// 授权窗口：只存在内存里。重启 = 自动关闭，不留下"忘记关"的状态。
let until = 0;

const enabled = () => !!KEY;
const remainMs = () => Math.max(0, until - Date.now());
const isOpen = () => enabled() && remainMs() > 0;

function safeEqual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a), 'utf8');
  const y = Buffer.from(String(b == null ? '' : b), 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** 人为授权：开一个限时窗口（最长 120 分钟） */
function openWindow(minutes, key) {
  if (!enabled()) return { ok: false, error: 'disabled' };
  if (!safeEqual(key, KEY)) return { ok: false, error: 'bad_key' };
  const m = Math.min(Math.max(Number(minutes) || 15, 1), MAX_WINDOW_MIN);
  until = Date.now() + m * 60000;
  return { ok: true, minutes: m, until };
}

function closeWindow() {
  until = 0;
}

// ---------------------------------------------------------------- 磁盘

const binPath = (id) => path.join(DIR, id + '.bin');
const metaPath = (id) => path.join(DIR, id + '.json');

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

async function loadAll() {
  ensureDir();
  let names = [];
  try {
    names = await fsp.readdir(DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const m = JSON.parse(await fsp.readFile(path.join(DIR, n), 'utf8'));
      if (m && ID_RE.test(m.id)) out.push(m);
    } catch {
      /* 损坏的旁挂文件直接忽略，不影响其它文件 */
    }
  }
  return out;
}

const sumSize = (list) => list.reduce((s, m) => s + (Number(m.size) || 0), 0);

async function usage() {
  return sumSize(await loadAll());
}

/** 文件名只用于下载时提示，存储一律用 id，所以这里只做展示安全化 */
function cleanName(n) {
  let s = String(n || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim();
  if (!s || s === '.' || s === '..') s = 'file.bin';
  if (s.length > 120) {
    const ext = path.extname(s).slice(0, 12);
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s;
}

/** 过期清理（默认 24 小时），返回删掉的条数 */
async function sweep() {
  if (!TTL_HOURS) return 0;
  const line = Date.now() - TTL_HOURS * 3600 * 1000;
  let n = 0;
  for (const m of await loadAll()) {
    if ((Number(m.ts) || 0) < line && (await remove(m.id))) n++;
  }
  return n;
}

async function save(buf, { name, to, from } = {}) {
  ensureDir();
  if (!buf || !buf.length) return { error: 'empty' };
  if (buf.length > MAX_FILE) return { error: 'too_large', size: buf.length };

  await sweep();
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const all = await loadAll();

  // 同一份内容只存一次：10MB 的空间里重复上传很致命
  const dup = all.find((m) => m.sha256 === sha256 && fs.existsSync(binPath(m.id)));
  if (dup) return { dup: true, meta: dup };

  const used = sumSize(all);
  if (used + buf.length > QUOTA) {
    const oldest = all
      .slice()
      .sort((a, b) => a.ts - b.ts)
      .slice(0, 3)
      .map((m) => ({ id: m.id, name: m.name, size: m.size, ts: m.ts }));
    return { error: 'quota', used, files: oldest };
  }

  const id = crypto.randomBytes(8).toString('hex');
  const meta = {
    id,
    name: cleanName(name),
    size: buf.length,
    sha256,
    from: String(from || '').slice(0, 24),
    to: String(to || 'all').slice(0, 24),
    ts: Date.now(),
  };
  // 先写 bin 再写 json：中途崩溃最多留下一个没有元数据的孤儿 bin，不会被列出
  await fsp.writeFile(binPath(id), buf);
  await fsp.writeFile(metaPath(id), JSON.stringify(meta));
  return { meta };
}

async function get(id) {
  if (!ID_RE.test(String(id))) return null;
  try {
    const meta = JSON.parse(await fsp.readFile(metaPath(id), 'utf8'));
    if (!fs.existsSync(binPath(id))) return null;
    return meta;
  } catch {
    return null;
  }
}

function stream(id) {
  return fs.createReadStream(binPath(id));
}

async function remove(id) {
  if (!ID_RE.test(String(id))) return false;
  let ok = false;
  try {
    await fsp.unlink(binPath(id));
    ok = true;
  } catch {}
  try {
    await fsp.unlink(metaPath(id));
    ok = true;
  } catch {}
  return ok;
}

async function list() {
  const all = await loadAll();
  return all.sort((a, b) => b.ts - a.ts);
}

async function status() {
  const all = await loadAll();
  return {
    enabled: enabled(),
    open: isOpen(),
    remainingSec: Math.ceil(remainMs() / 1000),
    used: sumSize(all),
    quota: QUOTA,
    maxFile: MAX_FILE,
    count: all.length,
    ttlHours: TTL_HOURS,
  };
}

module.exports = {
  DIR,
  MAX_FILE,
  QUOTA,
  enabled,
  isOpen,
  remainMs,
  openWindow,
  closeWindow,
  save,
  get,
  stream,
  remove,
  list,
  status,
  usage,
  sweep,
};
