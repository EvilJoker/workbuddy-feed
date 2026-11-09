'use strict';
/**
 * My Memos — 本地 SQLite 数据层（零第三方依赖，node:sqlite 内置模块）
 *
 * 为什么用本地文件：
 *  - 数据 100% 在自己磁盘上，不依赖任何云服务，不存在"资源点耗尽被停机"
 *  - 单文件 + WAL，备份就是复制一个文件
 *  - node >= 22.5 自带 node:sqlite，不需要 npm install
 *
 * 数据库位置（优先级）：
 *   1. DB_PATH 环境变量
 *   2. 云托管沙箱（存在 /workspace）→ /workspace/.feed-data/feed.db
 *      —— 故意放在项目目录之外：重新部署会重传项目目录，放里面会被覆盖
 *   3. 本机 → <项目根>/data/feed.db
 *
 * 表结构与原 PostgreSQL 版一一对应，字段语义见注释。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// 库文件位置：
//  - 显式 DB_PATH 优先
//  - 云托管沙箱（根目录是 /workspace）默认落到项目目录**之外**的 .feed-data/，
//    否则每次重新部署上传的 data/ 目录会把线上库覆盖掉
//  - 本机跑就是项目下的 data/feed.db
function defaultDbPath() {
  if (fs.existsSync('/workspace')) return '/workspace/.feed-data/feed.db';
  return path.join(__dirname, '..', 'data', 'feed.db');
}
const DB_PATH = process.env.DB_PATH || defaultDbPath();
const TODO_STATUS = ['new', 'doing', 'done', 'dropped', 'expired'];

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

// WAL：读写互不阻塞，进程被杀也不会损坏库
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS memos (
    id          TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '[]',   -- JSON 数组
    author      TEXT NOT NULL DEFAULT '管理员',
    pinned      INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memos_created_idx ON memos (created_at DESC);
  CREATE INDEX IF NOT EXISTS memos_pinned_idx  ON memos (pinned DESC, created_at DESC);

  CREATE TABLE IF NOT EXISTS todos (
    id          TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '[]',
    author      TEXT NOT NULL DEFAULT '管理员',
    status      TEXT NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','doing','done','dropped','expired')),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS todos_created_idx ON todos (created_at DESC);
  CREATE INDEX IF NOT EXISTS todos_status_idx  ON todos (status);

  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
    token       TEXT NOT NULL UNIQUE,          -- 免密登录用的专属 token
    created_at  TEXT NOT NULL
  );

  -- 消息队列：agent 之间点对点 / 广播通信。
  -- 只保留最近 MESSAGE_LIMIT 条（插入后裁剪，环形缓冲），不做历史归档。
  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    sender      TEXT NOT NULL,
    recipient   TEXT NOT NULL DEFAULT 'all',   -- 'all' 或成员名
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_created_idx   ON messages (created_at DESC);
  CREATE INDEX IF NOT EXISTS messages_recipient_idx ON messages (recipient, created_at DESC);
`);

const nowIso = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

// tags 在库里是 JSON 文本，出库统一转数组，避免调用方到处 JSON.parse
function rowOut(row) {
  if (!row) return null;
  return { ...row, tags: safeTags(row.tags), pinned: !!row.pinned };
}
function safeTags(v) {
  if (Array.isArray(v)) return v;
  try {
    const a = JSON.parse(v || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ memos
const stmtMemos = db.prepare(
  `SELECT id, content, tags, author, pinned, created_at, updated_at
     FROM memos ORDER BY pinned DESC, created_at DESC`
);
const stmtMemoById = db.prepare(`SELECT * FROM memos WHERE id = ?`);
const stmtMemoInsert = db.prepare(
  `INSERT INTO memos (id, content, tags, author, pinned, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);

function listMemos() {
  return stmtMemos.all().map(rowOut);
}

function createMemo({ content, tags, author, pinned = false }) {
  const id = uuid();
  const ts = nowIso();
  stmtMemoInsert.run(id, content, JSON.stringify(tags || []), author || '管理员', pinned ? 1 : 0, ts, ts);
  return rowOut(stmtMemoById.get(id));
}

function getMemo(id) {
  return rowOut(stmtMemoById.get(id));
}

function updateMemo(id, patch) {
  const cur = stmtMemoById.get(id);
  if (!cur) return null;
  const next = {
    content: patch.content !== undefined ? patch.content : cur.content,
    tags: patch.tags !== undefined ? JSON.stringify(patch.tags) : cur.tags,
    pinned: patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : cur.pinned,
    updated_at: patch.updated_at || nowIso(),
  };
  db.prepare(
    `UPDATE memos SET content = ?, tags = ?, pinned = ?, updated_at = ? WHERE id = ?`
  ).run(next.content, next.tags, next.pinned, next.updated_at, id);
  return getMemo(id);
}

function deleteMemo(id) {
  return db.prepare(`DELETE FROM memos WHERE id = ?`).run(id).changes > 0;
}

// ------------------------------------------------------------------ todos
const stmtTodos = db.prepare(
  `SELECT id, content, tags, author, status, created_at, updated_at
     FROM todos ORDER BY created_at DESC`
);
const stmtTodoById = db.prepare(`SELECT * FROM todos WHERE id = ?`);
const stmtTodoInsert = db.prepare(
  `INSERT INTO todos (id, content, tags, author, status, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);

function listTodos() {
  return stmtTodos.all().map(rowOut);
}

function createTodo({ content, tags, author, status = 'new' }) {
  const id = uuid();
  const ts = nowIso();
  const st = TODO_STATUS.includes(status) ? status : 'new';
  stmtTodoInsert.run(id, content, JSON.stringify(tags || []), author || '管理员', st, ts, ts);
  return rowOut(stmtTodoById.get(id));
}

function getTodo(id) {
  return rowOut(stmtTodoById.get(id));
}

function updateTodo(id, patch) {
  const cur = stmtTodoById.get(id);
  if (!cur) return null;
  const next = {
    content: patch.content !== undefined ? patch.content : cur.content,
    tags: patch.tags !== undefined ? JSON.stringify(patch.tags) : cur.tags,
    status: TODO_STATUS.includes(patch.status) ? patch.status : cur.status,
    updated_at: patch.updated_at || nowIso(),
  };
  db.prepare(
    `UPDATE todos SET content = ?, tags = ?, status = ?, updated_at = ? WHERE id = ?`
  ).run(next.content, next.tags, next.status, next.updated_at, id);
  return getTodo(id);
}

function deleteTodo(id) {
  return db.prepare(`DELETE FROM todos WHERE id = ?`).run(id).changes > 0;
}

// ------------------------------------------------------------------ messages
// 极简消息队列：只存最近 1000 条，超了从最老的开始丢（环形缓冲语义）。
const MESSAGE_LIMIT = 1000;

const stmtMessages = db.prepare(
  `SELECT id, content, sender, recipient, created_at
     FROM messages ORDER BY created_at DESC, rowid DESC`
);
const stmtMessageById = db.prepare(`SELECT * FROM messages WHERE id = ?`);
const stmtMessageInsert = db.prepare(
  `INSERT INTO messages (id, content, sender, recipient, created_at) VALUES (?, ?, ?, ?, ?)`
);

function trimMessages() {
  const n = db.prepare(`SELECT COUNT(*) AS n FROM messages`).get().n;
  const over = n - MESSAGE_LIMIT;
  if (over <= 0) return 0;
  // rowid 顺序 = 写入顺序（id 是 uuid，不能拿来排序）
  db.prepare(`DELETE FROM messages WHERE rowid IN (SELECT rowid FROM messages ORDER BY rowid ASC LIMIT ?)`).run(over);
  return over;
}

function listMessages() {
  return stmtMessages.all();
}

function createMessage({ content, sender, recipient = 'all' }) {
  const id = uuid();
  stmtMessageInsert.run(id, content, sender, recipient, nowIso());
  trimMessages();
  return stmtMessageById.get(id);
}

function getMessage(id) {
  return stmtMessageById.get(id) || null;
}

function deleteMessage(id) {
  return db.prepare(`DELETE FROM messages WHERE id = ?`).run(id).changes > 0;
}

// ------------------------------------------------------------------ users
const stmtUserByToken = db.prepare(`SELECT id, name, role, token, created_at FROM users WHERE token = ?`);
const stmtUserByName = db.prepare(`SELECT id, name, role, token, created_at FROM users WHERE name = ?`);
const stmtUserById = db.prepare(`SELECT id, name, role FROM users WHERE id = ?`);
const stmtUsersAll = db.prepare(
  `SELECT id, name, role, token, created_at FROM users ORDER BY role DESC, created_at ASC`
);

function findUserByToken(token) {
  return stmtUserByToken.get(token) || null;
}

function findUserByName(name) {
  return stmtUserByName.get(name) || null;
}

function findUserById(id) {
  return stmtUserById.get(id) || null;
}

function listUsers() {
  return stmtUsersAll.all();
}

function createUser({ name, role = 'member' }) {
  const id = uuid();
  const token = uuid();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO users (id, name, role, token, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, name, role, token, ts);
  return stmtUserById.get(id) ? findUserByToken(token) : null;
}

function deleteUser(id) {
  return db.prepare(`DELETE FROM users WHERE id = ?`).run(id).changes > 0;
}

// 保证库里有一个管理员记录：管理员专属免密链接靠它（密码登录不落此表）
function ensureAdmin(name = '管理员') {
  const has = db.prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).get();
  if (has) return db.prepare(`SELECT id, name, role, token, created_at FROM users WHERE id = ?`).get(has.id);
  const id = uuid();
  const token = uuid();
  db.prepare(`INSERT INTO users (id, name, role, token, created_at) VALUES (?, ?, 'admin', ?, ?)`).run(
    id,
    name,
    token,
    nowIso()
  );
  return stmtUserByToken.get(token);
}

function stats() {
  return {
    memos: db.prepare(`SELECT COUNT(*) AS n FROM memos`).get().n,
    todos: db.prepare(`SELECT COUNT(*) AS n FROM todos`).get().n,
    messages: db.prepare(`SELECT COUNT(*) AS n FROM messages`).get().n,
    users: db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n,
  };
}

module.exports = {
  DB_PATH,
  db,
  MESSAGE_LIMIT,
  listMemos,
  createMemo,
  getMemo,
  updateMemo,
  deleteMemo,
  listTodos,
  createTodo,
  getTodo,
  updateTodo,
  deleteTodo,
  listMessages,
  createMessage,
  getMessage,
  deleteMessage,
  findUserByToken,
  findUserByName,
  findUserById,
  listUsers,
  createUser,
  deleteUser,
  ensureAdmin,
  stats,
};
