'use strict';
/**
 * SQLite 一致性备份。
 *
 * 直接 cp 数据库文件在 WAL 模式下可能拷到"半个事务"，正确做法是用
 * `VACUUM INTO`：它在一个读事务里导出完整快照，服务运行中也能安全执行。
 *
 * 用法:
 *   node scripts/backup.js                # 备份到 data/backups/
 *   node scripts/backup.js /path/out.db   # 指定输出文件
 *   KEEP=30 node scripts/backup.js        # 只保留最近 30 份（默认 14）
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'feed.db');

if (!fs.existsSync(DB_PATH)) {
  console.error(`[backup] 数据库不存在: ${DB_PATH}`);
  process.exit(1);
}

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace('T', '-')
  .slice(0, 15); // 20261103-1930

const outPath = process.argv[2] || path.join(path.dirname(DB_PATH), 'backups', `feed-${stamp}.db`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });

if (fs.existsSync(outPath)) {
  console.error(`[backup] 目标已存在，换个名字: ${outPath}`);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
const counts = {
  memos: db.prepare('SELECT COUNT(*) AS n FROM memos').get().n,
  todos: db.prepare('SELECT COUNT(*) AS n FROM todos').get().n,
  users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
};
db.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
db.close();

const size = (fs.statSync(outPath).size / 1024).toFixed(0);
console.log(`[backup] 已备份 -> ${outPath}`);
console.log(`[backup] ${size} KB · ${counts.memos} memos / ${counts.todos} todos / ${counts.users} users`);

// 只保留最近 KEEP 份（默认 14），按文件名时间戳排序
const keep = Number(process.env.KEEP || 14);
const dir = path.dirname(outPath);
const prefix = path.basename(outPath).replace(/-?\d{8}-\d{4,6}\.db$/, '');
const olds = fs
  .readdirSync(dir)
  .filter((f) => f.startsWith(prefix) && f.endsWith('.db'))
  .sort()
  .slice(0, Math.max(0, -keep));
for (const f of olds) {
  fs.unlinkSync(path.join(dir, f));
  console.log(`[backup] 清理旧备份 ${f}`);
}
