#!/usr/bin/env bash
# WorkBuddy Feed 侧边条：贴屏幕右边缘的窄窗（Chrome App 模式，无地址栏，始终置顶）
# 唤醒的是线上服务 WorkBuddy Feed（memos-cloud），不是本地 memos。
# 用法: feed-strip.sh [toggle|show|hide|kill|status]
set -uo pipefail

# nde 全局热键触发时不保证 HOME/XAUTHORITY 已设置，兜一层
export HOME="${HOME:-/home/10312862@zte.intra}"
export DISPLAY="${DISPLAY:-:0}"
export XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
[ -S "$XDG_RUNTIME_DIR/bus" ] && export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

# 默认 = 管理员的 token 免密链接（点开直接进，不用输密码）
URL="${FEED_URL:-https://memos-cloud.app.workbuddy.host/?sharecode=O4BRMSCKL3&token=fafb2f2f-03dd-4ceb-8acd-1437e60087a0}"
STATE="$HOME/.feed-strip"
PROFILE="$STATE/chrome"
WIDFILE="$STATE/wid"
LOG="$STATE/chrome.log"
WIDTH="${FEED_STRIP_WIDTH:-420}"
HEIGHT="${FEED_STRIP_HEIGHT:-1040}"
CLASS="FeedStrip"
ACTION="${1:-toggle}"

mkdir -p "$STATE" "$PROFILE"

SW=$(xdpyinfo 2>/dev/null | awk '/dimensions:/{print $2}' | cut -dx -f1)
SW="${SW:-1920}"
X=$(( SW - WIDTH ))
[ "$X" -lt 0 ] && X=0

# ---------- 找窗口：class=FeedStrip 且宽度>=300（排除 200x200 的辅助窗）----------
wid_ok() {
    local w="$1" ww
    [ -n "$w" ] || return 1
    xwininfo -id "$w" >/dev/null 2>&1 || return 1
    ww=$(xwininfo -id "$w" 2>/dev/null | awk '/Width:/{print $2}')
    [ "${ww:-0}" -ge 300 ]
}

find_wid() {
    local w
    # 优先找正在显示的
    for w in $(xdotool search --class "$CLASS" --onlyvisible 2>/dev/null); do
        wid_ok "$w" && { echo "$w"; return 0; }
    done
    # 再找隐藏的（被我们 unmap 掉的）
    for w in $(xdotool search --class "$CLASS" 2>/dev/null); do
        wid_ok "$w" && { echo "$w"; return 0; }
    done
    return 1
}

onscreen() { xwininfo -id "$1" 2>/dev/null | grep -q 'Map State: IsViewable'; }

pin() {  # 贴边 + 尺寸
    # 置顶/无边框/不进任务栏交给 KWin 规则（kwinrulesrc）。
    # 不要在这里 xprop -set _NET_WM_STATE：会清掉 KWin 已经设好的状态，
    # 实测 show 之后 _NET_WM_STATE 变空、置顶失效。
    xdotool windowsize "$1" "$WIDTH" "$HEIGHT" 2>/dev/null
    xdotool windowmove "$1" "$X" 0 2>/dev/null
    xdotool windowraise "$1" 2>/dev/null
}

WID="$(find_wid || true)"
if [ -z "${WID:-}" ] && [ -f "$WIDFILE" ]; then
    cand="$(cat "$WIDFILE" 2>/dev/null)"
    wid_ok "$cand" && WID="$cand"
fi

case "$ACTION" in
    status)
        if [ -n "${WID:-}" ]; then
            if onscreen "$WID"; then echo "feed-strip: 显示中 (wid=$WID)"; else echo "feed-strip: 已隐藏 (wid=$WID)"; fi
        else
            echo "feed-strip: 未启动"
        fi
        exit 0 ;;
    kill)
        pkill -f -- "--user-data-dir=$PROFILE" 2>/dev/null
        rm -f "$WIDFILE"; echo "feed-strip: 已关闭"; exit 0 ;;
    hide)
        if [ -n "${WID:-}" ] && onscreen "$WID"; then xdotool windowunmap "$WID"; echo "feed-strip: 已隐藏"; fi
        exit 0 ;;
esac

# show / toggle 共通：窗口存在就直接操作
if [ -n "${WID:-}" ]; then
    if onscreen "$WID"; then
        if [ "$ACTION" = "toggle" ]; then
            xdotool windowunmap "$WID"; echo "feed-strip: 已隐藏"; exit 0
        fi
    fi
    xdotool windowmap "$WID" 2>/dev/null; sleep 0.2
    pin "$WID"; sleep 0.1
    xdotool windowactivate "$WID" 2>/dev/null
    echo "feed-strip: 已显示"; exit 0
fi

# ---------- 首次启动 ----------
echo "[$(date '+%F %T')] 启动 ${WIDTH}x${HEIGHT} @ ${X},0 url=${URL%%\?*}" >> "$LOG"
setsid nohup google-chrome \
    --app="$URL" \
    --class="$CLASS" \
    --user-data-dir="$PROFILE" \
    --window-size="$WIDTH,$HEIGHT" \
    --window-position="$X,0" \
    --no-first-run --no-default-browser-check \
    --disable-session-crashed-bubble \
    >> "$LOG" 2>&1 < /dev/null &

for _ in $(seq 1 60); do
    sleep 0.3
    WID="$(find_wid || true)"
    [ -n "${WID:-}" ] && break
done

if [ -n "${WID:-}" ]; then
    echo "$WID" > "$WIDFILE"
    sleep 0.6
    pin "$WID"
    xdotool windowactivate "$WID" 2>/dev/null
    echo "feed-strip: 已启动 (wid=$WID)"
else
    echo "feed-strip: 窗口未出现，查看 $LOG" >&2
    exit 1
fi
