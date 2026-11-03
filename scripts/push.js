#!/usr/bin/env node
'use strict';
/**
 * Agent 推送脚本：把一段文字推进 WorkBuddy Feed / ToDo
 *
 * 零依赖，node >= 18 直接跑。
 *
 * 用法：
 *   node scripts/push.js --content "📊 今日日报 #日报
 *   - 完成：xxx
 *   - 风险：xxx"
 *
 *   node scripts/push.js --type todo --status doing --content "跟进 PR #社区"
 *
 *   cat report.md | node scripts/push.js --stdin
 *   node scripts/push.js --file report.md --type memo
 *
 * 环境变量（推荐，避免密钥出现在命令历史里）：
 *   FEED_BASE        https://your-app.example.com
 *   FEED_TOKEN       成员免密 token
 *   FEED_SHARECODE   分享码（网关要求时必填，如 WorkBuddy 应用托管）
 *
 * 参数优先级：命令行 > 环境变量。
 */

const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');

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

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'stdin' || key === 'help') { out[key] = true; continue; }
    out[key] = argv[++i];
  }
  return out;
}

function die(msg) {
  console.error('✗ ' + msg);
  console.error('\n用法: node scripts/push.js --content "文本" [--type memo|todo] [--status new] [--base URL] [--token TOKEN] [--sharecode CODE]');
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
    return;
  }

  const base = (args.base || process.env.FEED_BASE || '').replace(/\/+$/, '');
  // 部分托管网关要求每个请求都带分享码
  const withShare = (path) => base + path + (sharecode ? (path.includes('?') ? '&' : '?') + 'sharecode=' + encodeURIComponent(sharecode) : '');
  const token = args.token || process.env.FEED_TOKEN;
  const sharecode = args.sharecode || process.env.FEED_SHARECODE || '';
  const type = args.type || 'memo';

  if (!base) die('缺少服务地址：--base 或 FEED_BASE');
  if (!token) die('缺少成员 token：--token 或 FEED_TOKEN');
  if (type !== 'memo' && type !== 'todo') die('--type 只能是 memo 或 todo');

  let content = args.content || '';
  if (args.file) content = fs.readFileSync(args.file, 'utf8');
  if (args.stdin) content = fs.readFileSync(0, 'utf8');
  content = content.trim();
  if (!content) die('内容为空：用 --content / --file / --stdin 提供');

  // 1) token 换会话 cookie（服务端下发 wbmemos=...）
  const authRes = await request(withShare('/api/auth?token=' + encodeURIComponent(token)));
  if (authRes.status < 200 || authRes.status >= 400) die('token 验证失败：HTTP ' + authRes.status);
  const rawCookie = authRes.headers['set-cookie'] || [];
  const cookie = rawCookie.map((c) => String(c).split(';')[0]).join('; ');
  if (!cookie) die('未拿到会话 cookie（服务端版本过旧？）');

  // 2) 写入
  const path = type === 'todo' ? '/api/todos' : '/api/memos';
  const body = JSON.stringify({ content, ...(type === 'todo' ? { status: args.status || 'new' } : {}) });

  const res = await request(withShare(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Cookie: cookie },
    body,
  });

  let data = {};
  try { data = JSON.parse(res.text); } catch { /* 非 JSON（如网关错误页）保持空 */ }
  if (res.status !== 200 && res.status !== 201) die('写入失败：HTTP ' + res.status + ' ' + res.text.slice(0, 120));

  const item = data.memo || data.todo || {};
  const tags = (item.tags || []).map((t) => '#' + t).join(' ');
  console.log(`✓ 已推送${type === 'todo' ? '待办' : ' memo'} ${item.id || ''} ${tags}`.trim());
}

main().catch((e) => die(e.message));
