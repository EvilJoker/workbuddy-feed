#!/usr/bin/env python3
"""本地冒烟测试：不依赖 curl，直接打 HTTP 接口，覆盖 memos / todos / users 全链路。
用法: python3 scripts/smoke.py [base_url] [password]
"""
import json
import sys
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8097'
PWD = sys.argv[2] if len(sys.argv) > 2 else 'test123'
COOKIE = {'v': ''}
ok = fail = 0


def call(method, path, body=None, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data:
        req.add_header('Content-Type', 'application/json')
    if COOKIE['v']:
        req.add_header('Cookie', COOKIE['v'])
    # 本机直连，绕开系统代理
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=10) as r:
            sc = r.headers.get('Set-Cookie')
            if sc:
                COOKIE['v'] = sc.split(';')[0]
            raw_body = r.read().decode()
            return r.status, (raw_body if raw else json.loads(raw_body or '{}'))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or '{}')


def check(name, cond, extra=''):
    global ok, fail
    if cond:
        ok += 1
        print(f'  [OK]   {name}')
    else:
        fail += 1
        print(f'  [FAIL] {name} {extra}')


print('1) 登录')
st, r = call('POST', '/api/login', {'password': PWD})
check('密码登录', st == 200 and r.get('ok'), f'{st} {r}')

print('2) memo 全链路')
st, r = call('POST', '/api/memos', {'content': '冒烟测试 #测试 #随手记\n正文第二行'})
memo = r.get('memo', {})
mid = memo.get('id', '')
check('新建 memo', st == 201 and mid and memo.get('author') == '管理员', f'{st} {r}')
check('自动解析标签', memo.get('tags') == ['测试', '随手记'], memo.get('tags'))

st, r = call('PATCH', f'/api/memos/{mid}', {'tags': ['测试', '收藏']})
check('标星（写 收藏 标签）', st == 200 and '收藏' in r.get('memo', {}).get('tags', []), r)

st, r = call('PATCH', f'/api/memos/{mid}', {'content': '改过的正文 #新标签'})
tags = r.get('memo', {}).get('tags', [])
check('改正文后星标不丢', st == 200 and '收藏' in tags and '新标签' in tags, tags)

st, r = call('PATCH', f'/api/memos/{mid}', {'pinned': True})
check('置顶', st == 200 and r.get('memo', {}).get('pinned') is True, r)

st, r = call('GET', '/api/memos')
check('列表带 1 条', st == 200 and len(r.get('memos', [])) == 1, r)

st, r = call('GET', '/api/memos/export', raw=True)
check('导出 JSON', st == 200 and '"count": 1' in r, r[:80])

print('3) todo 全链路')
st, r = call('POST', '/api/todos', {'content': '写周报 #工作', 'status': 'doing'})
todo = r.get('todo', {})
tid = todo.get('id', '')
check('新建 todo(doing)', st == 201 and todo.get('status') == 'doing', r)

st, r = call('PATCH', f'/api/todos/{tid}', {'status': 'done'})
check('改状态 done', st == 200 and r.get('todo', {}).get('status') == 'done', r)

st, r = call('PATCH', f'/api/todos/{tid}', {'tags': ['工作', '收藏']})
st, r = call('PATCH', f'/api/todos/{tid}', {'content': '改了内容 #另一个'})
tags = r.get('todo', {}).get('tags', [])
check('todo 改正文星标不丢 + 状态不丢', '收藏' in tags and r.get('todo', {}).get('status') == 'done', r)

st, r = call('GET', '/api/todos')
check('todo 列表带 1 条', st == 200 and len(r.get('todos', [])) == 1, r)

print('4) 成员管理')
st, r = call('POST', '/api/users', {'name': '冒烟测试成员'})
user = r.get('user', {})
check('创建成员', st == 201 and user.get('token'), r)

anon = urllib.request.build_opener(urllib.request.ProxyHandler({}))
st_a, r_a = 0, {}
try:
    with anon.open(BASE + f"/api/auth?token={user.get('token')}", timeout=10) as resp:
        st_a, r_a = resp.status, json.loads(resp.read().decode())
except urllib.error.HTTPError as e:
    st_a, r_a = e.code, json.loads(e.read().decode() or '{}')
check('token 免密登录', st_a == 200 and r_a.get('name') == '冒烟测试成员', f'{st_a} {r_a}')

st, r = call('POST', '/api/users', {'name': '冒烟测试成员'})
check('重名被拒 409', st == 409, f'{st} {r}')

st, r = call('GET', '/api/users')
names = [u.get('name') for u in r.get('users', [])]
check('成员列表含管理员与新成员', st == 200 and '管理员' in names and '冒烟测试成员' in names, names)

st, r = call('DELETE', f"/api/users/{user.get('id')}")
check('删除成员', st == 200 and r.get('ok'), r)

print('5) 删除 + 鉴权')
st, r = call('DELETE', f'/api/memos/{mid}')
check('删除 memo', st == 200, r)
st, r = call('DELETE', f'/api/todos/{tid}')
check('删除 todo', st == 200, r)
COOKIE['v'] = ''
st, r = call('GET', '/api/memos')
check('未登录访问被拒 401', st == 401, f'{st} {r}')

st, r = call('GET', '/api/health')
check('健康检查统计', st == 200 and r.get('memos') == 0 and r.get('todos') == 0, r)
print(f'\n结果: {ok} 通过 / {fail} 失败')
sys.exit(1 if fail else 0)
