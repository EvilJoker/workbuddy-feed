#!/usr/bin/env bash
# 用 Nde 桌面的 nde-globalkeysd 注册 WorkBuddy Feed 侧边条全局热键（幂等）
#
# 本机是 Nde 桌面（NewStartOS/统信）：KGlobalAccel 是 stub，XGrabKey 被 KWin
# grab-all 独占，唯一可用的是 org.nde.global_key_shortcuts 的 addCommandAction。
#
# 用法: feed-hotkey-nde.sh [快捷键]     默认 Alt+M
#   已注册但键不同 → 调 changeShortcut 改键（不需要 remove + add）
set -uo pipefail

SHORTCUT="${1:-Alt+M}"
SCRIPT="$HOME/.local/bin/feed-strip.sh"
DESC="Feed 侧边条 展开/隐藏"
D="org.nde.global_key_shortcuts"

export DISPLAY="${DISPLAY:-:0}"
export XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
[ -S "$XDG_RUNTIME_DIR/bus" ] && export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

call() {
    dbus-send --session --print-reply --dest="$D" /daemon "$@"
}

# 找出描述匹配的动作 id（getAllActions 里每条动作以 `uint64 <id>` 开头）
find_id() {
    call "$D.daemon.getAllActions" 2>/dev/null \
        | awk '/uint64 /{split($0,a," "); id=a[2]} /Feed 侧边条/{print id}' | head -1
}

cur_key() {
    call "$D.daemon.getActionById" uint64:"$1" 2>/dev/null \
        | grep -o 'string "[^"]*"' | head -1 | sed 's/string "//; s/"$//'
}

ID=$(find_id)

if [ -n "$ID" ]; then
    # 已注册：同键则跳过，不同键则改键
    if [ "$(cur_key "$ID")" = "$SHORTCUT" ]; then
        echo "feed-hotkey-nde: 已注册 $SHORTCUT (id=$ID)，跳过"
        exit 0
    fi
    out=$(call "$D.daemon.changeShortcut" uint64:"$ID" string:"$SHORTCUT" 2>&1)
    used=$(echo "$out" | grep -o 'string "[^"]*"' | head -1 | sed 's/string "//; s/"$//')
    if [ -n "$used" ]; then
        echo "feed-hotkey-nde: 改键 $SHORTCUT (id=$ID)"
        exit 0
    fi
    echo "feed-hotkey-nde: 改键失败 $SHORTCUT（可能被占用）" >&2
    exit 1
fi

out=$(call "$D.daemon.addCommandAction" \
    string:"$SHORTCUT" \
    string:"$SCRIPT" \
    array:string:"toggle" \
    string:"$DESC" 2>&1)

used=$(echo "$out" | grep -o 'string "[^"]*"' | head -1 | sed 's/string "//; s/"$//')
id=$(echo "$out" | grep -o 'uint64 [0-9]*' | awk '{print $2}')

if [ -n "$used" ] && [ "${id:-0}" != "0" ]; then
    echo "feed-hotkey-nde: 注册成功 $used (id=$id)"
else
    echo "feed-hotkey-nde: 注册失败（$SHORTCUT 被占用或格式不支持）" >&2
    exit 1
fi
