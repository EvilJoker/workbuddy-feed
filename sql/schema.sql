-- WorkBuddy Feed · SQLite schema（参考用）
-- 服务启动时会自动建表（见 src/db.js），这里只是给人看的一份纯 SQL。
-- 手工建库：sqlite3 data/feed.db < sql/schema.sql

PRAGMA journal_mode = WAL;

-- 信息流
CREATE TABLE IF NOT EXISTS memos (
  id          TEXT PRIMARY KEY,                  -- uuid
  content     TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',        -- JSON 数组，如 ["日报","行情"]
  author      TEXT NOT NULL DEFAULT '管理员',
  pinned      INTEGER NOT NULL DEFAULT 0,        -- 0/1
  created_at  TEXT NOT NULL,                     -- ISO8601 字符串
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memos_created_idx ON memos (created_at DESC);
CREATE INDEX IF NOT EXISTS memos_pinned_idx  ON memos (pinned DESC, created_at DESC);

-- 待办：状态 new=新建 doing=进行中 done=已完成 dropped=废弃 expired=过期
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

-- 成员：token 为免密登录链接里的 uuid
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  token       TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

-- 消息队列：agent 之间点对点 / 广播通信，只保留最近 1000 条（插入时裁剪最老的）
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  content     TEXT NOT NULL,
  sender      TEXT NOT NULL,
  recipient   TEXT NOT NULL DEFAULT 'all',       -- 'all' = 广播，否则成员/agent 名字
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_created_idx   ON messages (created_at DESC);
CREATE INDEX IF NOT EXISTS messages_recipient_idx ON messages (recipient, created_at DESC);
