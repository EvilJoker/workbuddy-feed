'use strict';
/**
 * 把导出的 memos JSON 导入本地 SQLite（data/feed.db）
 *
 * 用法：
 *   node scripts/import.js ./memos-2026-11-01.json
 *   node scripts/import.js ./old.json --dry-run
 *
 * 支持两种输入：
 *   1) { "memos": [ {content, tags?, pinned?, createdTs?, updatedTs?} ] }
 *   2) [ {content, ...} ]
 * 时间戳（createdTs/updatedTs，毫秒或 ISO 字符串）会保留，避免导入后顺序全乱。
 *
 * 直接写库而不是走 HTTP：这样能原样保留创建时间与置顶状态。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 0) continue;
    const k = s.slice(0, i).trim();
    const v = s.slice(i + 1).trim();
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
}

const db = require('../src/db'); // 会顺带建好表

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const asTodo = args.includes('--todo');
const file = args.find((a) => !a.startsWith('--'));

if (!file) {
  console.error('用法: node scripts/import.js <export.json> [--todo] [--dry-run]');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const list = Array.isArray(raw) ? raw : raw.memos || raw.todos || [];

if (!list.length) {
  console.log('文件里没有可导入的条目，什么都不做');
  process.exit(0);
}

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

function pickTs(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return fallback;
}

const now = new Date().toISOString();
const STATUS = ['new', 'doing', 'done', 'dropped', 'expired'];
const rows = list
  .filter((m) => m && typeof m.content === 'string' && m.content.trim())
  .map((m) => ({
    id: m.id || crypto.randomUUID(),
    content: m.content,
    tags: JSON.stringify(Array.isArray(m.tags) && m.tags.length ? m.tags : parseTags(m.content)),
    author: typeof m.author === 'string' && m.author ? m.author : '管理员',
    pinned: m.pinned ? 1 : 0,
    status: STATUS.includes(m.status) ? m.status : 'new',
    created_at: pickTs(m.createdTs ?? m.created_at, now),
    updated_at: pickTs(m.updatedTs ?? m.updated_at, now),
  }));

console.log(`准备导入 ${rows.length} 条${asTodo ? ' ToDo' : ' memo'} -> ${db.DB_PATH}`);
if (dryRun) {
  console.log(JSON.stringify(rows.slice(0, 3), null, 2));
  console.log('--dry-run：未写入');
  process.exit(0);
}

const cols = asTodo
  ? ['id', 'content', 'tags', 'author', 'status', 'created_at', 'updated_at']
  : ['id', 'content', 'tags', 'author', 'pinned', 'created_at', 'updated_at'];
const table = asTodo ? 'todos' : 'memos';
const stmt = db.db.prepare(
  `INSERT OR IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
);

let ok = 0;
db.db.exec('BEGIN');
try {
  for (const r of rows) {
    // 状态字段只有 todos 表有，memos 忽略
    const vals = cols.map((c) => (c === 'status' ? r.status : r[c]));
    ok += stmt.run(...vals).changes;
  }
  db.db.exec('COMMIT');
} catch (e) {
  db.db.exec('ROLLBACK');
  console.error('导入失败，已回滚:', e.message);
  process.exit(1);
}

console.log(`完成：写入 ${ok} 条（重复 id 自动跳过）`);
console.log(`当前库: ${JSON.stringify(db.stats())}`);
