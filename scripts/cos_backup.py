#!/usr/bin/env python3
"""
WorkBuddy Feed → 腾讯云 COS 备份管线（零第三方依赖）。

流程：
  1. 用管理员密码登录线上 Feed，GET /api/backup 拉取 VACUUM INTO 一致性快照
  2. COS XML API 签名 PUT 上传到备份桶
  3. 清理桶内超出保留数的旧备份

子命令：
  backup            拉快照 + 上传 + 清理旧备份（默认动作）
  list [prefix]     列出桶内备份对象
  restore <key>     下载备份到本机 ./restored/，并用 sqlite 校验可读
  check             只验证 COS 凭据与桶连通性

环境变量：
  COS_SECRET_ID / COS_SECRET_KEY   从 getkey 取（~/.agents/skills/data/sample-kv）
  COS_BUCKET                       桶名，如 feed-backup-125xxxxxxx
  COS_REGION                       地域，如 ap-shanghai
  FEED_BASE / FEED_PASSWORD        线上地址与管理员密码
  KEEP                             保留份数，默认 12
"""

import hashlib
import hmac
import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request

# ---------------------------------------------------------------- 配置

WORKDIR = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(WORKDIR)


def getkey(name):
    v = subprocess.run(["getkey", name], capture_output=True, text=True)
    return v.stdout.strip()


def dotenv(name, default=""):
    """从项目 .env 读配置（不覆盖已有环境变量）。"""
    v = os.environ.get(name)
    if v:
        return v
    try:
        for line in open(os.path.join(PROJECT, ".env")):
            line = line.strip()
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip()
    except FileNotFoundError:
        pass
    return default


SID = getkey("COS_SECRET_ID")
SKEY = getkey("COS_SECRET_KEY")
BUCKET = dotenv("COS_BUCKET")
REGION = dotenv("COS_REGION", "ap-shanghai")
FEED_BASE = dotenv("FEED_BASE", "https://memos-cloud.app.workbuddy.host")
SHARECODE = dotenv("FEED_SHARECODE")
KEEP = int(os.environ.get("KEEP", "12"))


def feed_password():
    env = os.environ.get("FEED_PASSWORD")
    if env:
        return env
    for line in open(os.path.join(PROJECT, ".env")):
        if line.startswith("ACCESS_PASSWORD"):
            return line.split("=", 1)[1].strip()
    raise SystemExit("[cos] 找不到 FEED_PASSWORD，也未在 .env 里找到 ACCESS_PASSWORD")


# ---------------------------------------------------------------- COS 签名（XML API）


def cos_sign(method, path, params=None, expires=600):
    """COS 请求签名。path 形如 '/' 或 '/key/name.db'（须 URL 编码后传入）。

    params: 查询参数 dict（如 {'prefix': 'feed/'}），需参与签名。
    """
    now = int(time.time())
    keytime = f"{now};{now + expires}"

    def h(key, msg):
        return hmac.new(key.encode(), msg.encode(), hashlib.sha1).hexdigest()

    if params:
        keys = sorted(k.lower() for k in params)
        url_param_list = ";".join(keys)
        http_params = "&".join(
            f"{urllib.parse.quote(k.lower(), safe='')}={urllib.parse.quote(params[k], safe='-_.~')}"
            for k in keys
        )
    else:
        url_param_list = ""
        http_params = ""
    signkey = h(SKEY, keytime)
    format_string = f"{method.lower()}\n{path}\n{http_params}\n\n"
    # StringToSign 格式：sha1\nKeyTime\nSHA1(HttpString)\n —— 结尾的换行符不能少
    string_to_sign = f"sha1\n{keytime}\n{hashlib.sha1(format_string.encode()).hexdigest()}\n"
    signature = h(signkey, string_to_sign)
    return (
        "q-sign-algorithm=sha1"
        f"&q-ak={SID}&q-sign-time={keytime}&q-key-time={keytime}"
        f"&q-header-list=&q-url-param-list={url_param_list}"
        f"&q-signature={signature}"
    )


def cos_url(path):
    return f"https://{BUCKET}.cos.{REGION}.myqcloud.com{path}"


def cos_request(method, path, data=None, headers=None, params=None, timeout=120):
    h = {"Authorization": cos_sign(method, path, params)}
    if headers:
        h.update(headers)
    query = ""
    if params:
        query = "?" + "&".join(f"{k}={urllib.parse.quote(v, safe='')}" for k, v in params.items())
    req = urllib.request.Request(cos_url(path) + query, data=data, method=method, headers=h)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def cos_list(prefix=""):
    params = {"prefix": prefix} if prefix else None
    st, body = cos_request("GET", "/", params=params)
    if st != 200:
        print(f"[cos] 列表失败 HTTP {st}: {body[:200]}", file=sys.stderr)
        sys.exit(1)
    import xml.etree.ElementTree as ET

    root = ET.fromstring(body)
    local = lambda tag: tag.rsplit("}", 1)[-1]  # 兼容带/不带 xmlns 两种返回
    out = []
    for c in (e for e in root.iter() if local(e.tag) == "Contents"):
        def text(name):
            n = next((x for x in c if local(x.tag) == name), None)
            return n.text if n is not None else ""
        out.append({"key": text("Key"), "size": int(text("Size") or 0), "modified": text("LastModified")})
    return out


# ---------------------------------------------------------------- Feed 快照


def http(method, url, data=None, headers=None, timeout=120):
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=timeout) as r:
        cookies = [c.split(";")[0] for c in (r.headers.get_all("Set-Cookie") or [])]
        return r.status, "; ".join(cookies), r.read()


def pull_snapshot(dest):
    """登录 Feed 并下载 /api/backup 快照到 dest。"""
    q = f"?sharecode={SHARECODE}" if SHARECODE else ""
    st, ck, _ = http("POST", f"{FEED_BASE}/api/login{q}", json.dumps({"password": feed_password()}).encode())
    if st != 200:
        raise SystemExit(f"[cos] Feed 登录失败 HTTP {st}")
    st, _, body = http("GET", f"{FEED_BASE}/api/backup{q}", headers={"Cookie": ck})
    if st != 200:
        raise SystemExit(f"[cos] 拉取快照失败 HTTP {st}: {body[:200]}")
    with open(dest, "wb") as f:
        f.write(body)
    return len(body)


# ---------------------------------------------------------------- 子命令


def cmd_check():
    st, body = cos_request("GET", "/")
    if st == 200:
        print(f"[cos] OK 桶 {BUCKET} 可访问（{REGION}）")
    else:
        print(f"[cos] 失败 HTTP {st}: {body[:300]}", file=sys.stderr)
        sys.exit(1)


def cmd_backup():
    import datetime

    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M")
    key = f"feed/feed-{ts}.db"
    tmp = os.path.join("/tmp" if os.path.isdir("/tmp") else "/var/tmp", f"feed-{ts}.db")

    size = pull_snapshot(tmp)
    # 下载完先验证是合法 SQLite 再上传
    con = sqlite3.connect(tmp)
    counts = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("memos", "todos", "users")}
    con.close()

    st, body = cos_request("PUT", f"/{key}", data=open(tmp, "rb").read())
    os.unlink(tmp)
    if st != 200:
        print(f"[cos] 上传失败 HTTP {st}: {body[:200]}", file=sys.stderr)
        sys.exit(1)
    print(f"[cos] 已上传 {key} ({size // 1024} KB · {counts})")

    objs = cos_list("feed/")
    for o in sorted(objs, key=lambda x: x["key"])[:-KEEP]:
        st, _ = cos_request("DELETE", f"/{o['key']}")
        if st == 204 or st == 200:
            print(f"[cos] 清理旧备份 {o['key']}")
        else:
            print(f"[cos] 清理失败 {o['key']} HTTP {st}", file=sys.stderr)


def cmd_list(prefix="feed/"):
    objs = cos_list(prefix)
    if not objs:
        print("(空)")
        return
    for o in sorted(objs, key=lambda x: x["key"]):
        print(f"{o['key']}  {o['size'] / 1024:8.0f} KB  {o['modified']}")


def cmd_restore(key):
    import urllib.parse

    path = "/" + urllib.parse.quote(key)
    st, body = cos_request("GET", path)
    if st != 200:
        print(f"[cos] 下载失败 HTTP {st}: {body[:200]}", file=sys.stderr)
        sys.exit(1)
    outdir = os.path.join(PROJECT, "restored")
    os.makedirs(outdir, exist_ok=True)
    out = os.path.join(outdir, os.path.basename(key))
    with open(out, "wb") as f:
        f.write(body)
    con = sqlite3.connect(out)
    counts = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("memos", "todos", "users")}
    integrity = con.execute("PRAGMA integrity_check").fetchone()[0]
    con.close()
    print(f"[cos] 已恢复 -> {out}")
    print(f"[cos] 校验: integrity={integrity} · {counts}")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "backup"
    if not SID or not SKEY:
        raise SystemExit("[cos] 缺少 COS_SECRET_ID / COS_SECRET_KEY（getkey 取不到）")
    if not BUCKET:
        raise SystemExit("[cos] 缺少 COS_BUCKET 环境变量")
    if cmd == "check":
        cmd_check()
    elif cmd == "backup":
        cmd_backup()
    elif cmd == "list":
        cmd_list(sys.argv[2] if len(sys.argv) > 2 else "feed/")
    elif cmd == "restore":
        if len(sys.argv) < 3:
            raise SystemExit("用法: cos_backup.py restore <对象key>")
        cmd_restore(sys.argv[2])
    else:
        raise SystemExit(f"未知子命令: {cmd}")


if __name__ == "__main__":
    main()
