'use strict';
/**
 * 把旧服务导出的 memos JSON 导入 CloudBase PostgreSQL
 *
 * 用法：
 *   node scripts/import.js ./memos-2026-11-01.json
 *   node scripts/import.js ./old.json --dry-run
 *
 * 支持两种输入：
 *   1) { "memos": [ {content, tags?, pinned?, createdTs?, updatedTs?} ] }
 *   2) [ {content, ...} ]
 * 时间戳（createdTs/updatedTs，毫秒）会被保留，避免导入后顺序全乱。
 */

const fs = require('node:fs');
const path = require('node:path');

// 复用 server.js 的 .env 加载与环境变量约定
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

const ENV_ID = process.env.CLOUDBASE_ENV_ID || 'sqyworkbuddybase-d6exnh2af5c8aef';
const REST_BASE =
  process.env.CLOUDBASE_REST_BASE ||
  `https://${ENV_ID}.api.tcloudbasegateway.com/v1/rdb/rest`;
const API_KEY = process.env.CLOUDBASE_API_KEY;
const TABLE = process.env.MEMOS_TABLE || 'memos';

if (!API_KEY) {
  console.error('缺少 CLOUDBASE_API_KEY（写在 .env 里）');
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const file = args.find((a) => !a.startsWith('--'));

if (!file) {
  console.error('用法: node scripts/import.js <export.json> [--dry-run]');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const list = Array.isArray(raw) ? raw : raw.memos || [];

if (!list.length) {
  console.log('文件里没有 memos，什么都不做');
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
const rows = list
  .filter((m) => m && typeof m.content === 'string' && m.content.trim())
  .map((m) => ({
    content: m.content,
    tags: Array.isArray(m.tags) && m.tags.length ? m.tags : parseTags(m.content),
    pinned: !!m.pinned,
    created_at: pickTs(m.createdTs ?? m.created_at, now),
    updated_at: pickTs(m.updatedTs ?? m.updated_at, now),
  }));

console.log(`准备导入 ${rows.length} 条到 ${REST_BASE}/${TABLE}`);
if (dryRun) {
  console.log(JSON.stringify(rows.slice(0, 3), null, 2));
  console.log('--dry-run：未写入');
  process.exit(0);
}

(async () => {
  let ok = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    const res = await fetch(`${REST_BASE}/${TABLE}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) {
      console.error(`第 ${i}-${i + chunk.length} 条失败:`, res.status, await res.text());
      process.exit(1);
    }
    ok += chunk.length;
    console.log(`已导入 ${ok}/${rows.length}`);
  }
  console.log('完成');
})();
