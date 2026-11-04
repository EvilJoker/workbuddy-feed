'use strict';
/**
 * COS 异地备份 —— 服务端内置定时任务（零依赖）。
 *
 * 设计：
 *  - server.js 启动时若检测到 COS_* 配置，开启本任务
 *  - 每周（COS_BACKUP_DAY 星期几 / COS_BACKUP_HOUR 点）做一次
 *    `VACUUM INTO` 一致性快照 -> 直接 PUT 上传腾讯云 COS -> 清理超量旧备份
 *  - 状态记在数据库同目录的 .cos-backup-state（跟随沙箱持久目录）
 *  - 首次启动（无状态文件）立即备份一次，之后按周调度
 *
 * 密钥安全：
 *  - COS_SECRET_ID / COS_SECRET_KEY 只从 .env / 环境变量读取
 *  - .env 已在 .gitignore，绝不进代码库
 *
 * 配置（.env）：
 *  COS_BUCKET / COS_REGION          桶名与地域（必填才启用）
 *  COS_SECRET_ID / COS_SECRET_KEY   CAM 密钥
 *  COS_PREFIX                       桶内目录前缀，默认 feed/
 *  COS_BACKUP_DAY                   0=周日 ... 6=周六，默认 1（周一）
 *  COS_BACKUP_HOUR                  触发小时（0-23），默认 9
 *  COS_KEEP                         桶内保留份数，默认 12
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');

function createCosTask({ DB_PATH, db, log = console.log }) {
  const conn = db.db && typeof db.db.exec === 'function' ? db.db : db; // 兼容模块导出/裸连接
  const BUCKET = process.env.COS_BUCKET || '';
  const REGION = process.env.COS_REGION || 'ap-shanghai';
  const SID = process.env.COS_SECRET_ID || '';
  const SKEY = process.env.COS_SECRET_KEY || '';
  const PREFIX = (process.env.COS_PREFIX || 'feed/').replace(/\/?$/, '/');
  const DAY = Number(process.env.COS_BACKUP_DAY ?? 1);
  const HOUR = Number(process.env.COS_BACKUP_HOUR ?? 9);
  const KEEP = Number(process.env.COS_KEEP ?? 12);
  const STATE = path.join(path.dirname(DB_PATH), '.cos-backup-state');

  const enabled = () => !!(BUCKET && SID && SKEY);

  // ------------------------------------------------------------ COS 签名
  // StringToSign 必须是 `sha1\nKeyTime\nSHA1(HttpString)\n` —— 结尾换行不能漏！
  const sha1hex = (s) => crypto.createHash('sha1').update(s).digest('hex');
  const hmac = (key, msg) => crypto.createHmac('sha1', key).update(msg).digest('hex');

  function sign(method, pathname, params = {}) {
    const now = Math.floor(Date.now() / 1000);
    const keytime = `${now};${now + 600}`;
    const signKey = hmac(SKEY, keytime);
    const keys = Object.keys(params).sort();
    const urlParamList = keys.join(';');
    const httpParams = keys
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`)
      .join('&');
    const httpString = `${method.toLowerCase()}\n${pathname}\n${httpParams}\n\n`;
    const stringToSign = `sha1\n${keytime}\n${sha1hex(httpString)}\n`;
    const signature = hmac(signKey, stringToSign);
    return (
      `q-sign-algorithm=sha1&q-ak=${SID}&q-sign-time=${keytime}&q-key-time=${keytime}` +
      `&q-header-list=&q-url-param-list=${urlParamList}&q-signature=${signature}`
    );
  }

  function request(method, pathname, { params = {}, body = null, timeout = 120000 } = {}) {
    return new Promise((resolve, reject) => {
      let query = '';
      if (Object.keys(params).length) {
        query =
          '?' +
          Object.entries(params)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join('&');
      }
      const req = https.request(
        {
          method,
          host: `${BUCKET}.cos.${REGION}.myqcloud.com`,
          path: pathname + query,
          headers: { Authorization: sign(method, pathname, params) },
          timeout,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode, body: Buffer.concat(chunks) })
          );
        }
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('cos request timeout')));
      if (body) req.write(body);
      req.end();
    });
  }

  // ------------------------------------------------------------ 备份动作
  async function listObjects() {
    const { status, body } = await request('GET', '/', { params: { prefix: PREFIX } });
    if (status !== 200) throw new Error(`COS list -> HTTP ${status}`);
    const xml = body.toString();
    const out = [];
    const re = /<Contents>[\s\S]*?<\/Contents>/g;
    for (const block of xml.match(re) || []) {
      const key = (block.match(/<Key>([^<]+)<\/Key>/) || [])[1];
      if (key) out.push(key);
    }
    return out.sort();
  }

  async function runBackupNow(reason = 'scheduled') {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace('T', '-')
      .slice(0, 15);
    const key = `${PREFIX}feed-${stamp}.db`;
    const tmp = `${DB_PATH}.cos-snap-${stamp}`;

    // 1. 一致性快照（WAL 模式下唯一安全的备份方式）
    conn.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const body = fs.readFileSync(tmp);
    const counts = await new Promise((resolve) => {
      const s = new (require('node:sqlite').DatabaseSync)(tmp);
      const r = {
        memos: s.prepare('SELECT COUNT(*) n FROM memos').get().n,
        todos: s.prepare('SELECT COUNT(*) n FROM todos').get().n,
        users: s.prepare('SELECT COUNT(*) n FROM users').get().n,
      };
      s.close();
      resolve(r);
    });
    fs.unlinkSync(tmp);

    // 2. 上传
    const put = await request('PUT', `/${key}`, { body });
    if (put.status !== 200) throw new Error(`COS put -> HTTP ${put.status}`);

    // 3. 清理超量旧备份
    const objs = await listObjects();
    const removed = [];
    for (const k of objs.slice(0, Math.max(0, objs.length - KEEP))) {
      const del = await request('DELETE', `/${k}`);
      if (del.status === 200 || del.status === 204) removed.push(k);
    }

    fs.writeFileSync(STATE, new Date().toISOString());
    log(
      `[cos-backup] (${reason}) ${key} ${(body.length / 1024).toFixed(0)}KB · ` +
        `${counts.memos} memos / ${counts.todos} todos / ${counts.users} users` +
        (removed.length ? ` · 清理 ${removed.length} 份旧备份` : '')
    );
    return key;
  }

  // ------------------------------------------------------------ 周调度
  // 每 10 分钟检查一次：到了 COS_BACKUP_DAY 的 COS_BACKUP_HOUR 且本周未备份则执行；
  // 状态文件不存在（首次启动 / 沙箱重建）时立即补一次，保证"新环境必有一份备份"。
  function schedule() {
    const tick = async () => {
      try {
        const last = fs.existsSync(STATE) ? fs.readFileSync(STATE, 'utf8').slice(0, 10) : '';
        const now = new Date();
        const today = now.toISOString().slice(0, 10);
        const due = now.getDay() === DAY && now.getHours() === HOUR;
        if (!fs.existsSync(STATE)) {
          await runBackupNow('first-boot');
        } else if (due && last !== today) {
          await runBackupNow('weekly');
        }
      } catch (err) {
        log(`[cos-backup] 失败: ${err.message}（下个检查周期重试）`);
      }
    };
    setTimeout(tick, 20 * 1000); // 启动 20s 后先查一次（含首次备份）
    setInterval(tick, 10 * 60 * 1000);
    log(
      `[cos-backup] 已启用 -> cos://${BUCKET}/${PREFIX} ` +
        `每周${'日一二三四五六'[DAY]} ${String(HOUR).padStart(2, '0')}:00 保留 ${KEEP} 份`
    );
  }

  return { enabled, schedule, runBackupNow };
}

module.exports = { createCosTask };
