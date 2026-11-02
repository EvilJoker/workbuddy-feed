#!/usr/bin/env bash
# WorkBuddy Feed 桌面侧边条：安装 / 卸载（把家目录里的位置做成指向本目录的软链接）
#
# 布局约定：本目录 = 源码与配置的唯一真身；家目录里只有软链接。
#   ~/.local/bin/feed-strip.sh        -> desktop/bin/feed-strip.sh
#   ~/.local/bin/feed-hotkey-nde.sh   -> desktop/bin/feed-hotkey-nde.sh
#   ~/.config/autostart/feed-strip.desktop      -> desktop/autostart/...
#   ~/.config/autostart/feed-hotkey-nde.desktop -> desktop/autostart/...
#   ~/.config/kwinrulesrc              -> desktop/kwinrulesrc
#
# 用法: install.sh [install|uninstall|status]   默认 install
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$HOME/.local/bin"
AUTOSTART="$HOME/.config/autostart"
KWINRC="$HOME/.config/kwinrulesrc"
ACTION="${1:-install}"

# 软链接清单：目标 -> 真身
links() {
    echo "$BIN/feed-strip.sh|$SRC/bin/feed-strip.sh"
    echo "$BIN/feed-hotkey-nde.sh|$SRC/bin/feed-hotkey-nde.sh"
    echo "$AUTOSTART/feed-strip.desktop|$SRC/autostart/feed-strip.desktop"
    echo "$AUTOSTART/feed-hotkey-nde.desktop|$SRC/autostart/feed-hotkey-nde.desktop"
    echo "$KWINRC|$SRC/kwinrulesrc"
}

do_install() {
    mkdir -p "$BIN" "$AUTOSTART"
    chmod +x "$SRC"/bin/*.sh

    links | while IFS='|' read -r dst src; do
        # 真身已就位？（防止软链接指向一个不存在的文件）
        [ -f "$src" ] || { echo "缺文件: $src" >&2; continue; }

        if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
            echo "✓ 已链接 $dst"
            continue
        fi
        # 已有真实文件（非软链接）→ 备份后替换
        if [ -e "$dst" ] && [ ! -L "$dst" ]; then
            bak="$dst.bak-$(date +%Y%m%d-%H%M%S)"
            mv "$dst" "$bak"
            echo "  已备份旧文件 → $bak"
        fi
        ln -sfn "$src" "$dst"
        echo "✓ 新建链接 $dst"
    done

    # KWin 需要重新套用规则（已有窗口要 unmap/map 才生效）。
    # 本机没有 qdbus，用 dbus-send；qdbus 留作其他桌面环境的兜底。
    XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
    if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "$XDG_RUNTIME_DIR/bus" ]; then
        export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
    fi
    if dbus-send --session --print-reply --dest=org.kde.KWin /KWin org.kde.KWin.reconfigure >/dev/null 2>&1; then
        echo "✓ 已通知 KWin 重载规则（记得对已有窗口 toggle 一次让规则套上）"
    elif command -v qdbus >/dev/null 2>&1; then
        qdbus org.kde.KWin /KWin reconfigure >/dev/null 2>&1 && echo "✓ 已通知 KWin 重载规则"
    else
        echo "（未能通知 KWin 重载，可手动执行: dbus-send --session --dest=org.kde.KWin /KWin org.kde.KWin.reconfigure）"
    fi
    echo "完成。热键注册：$BIN/feed-hotkey-nde.sh"
}

do_uninstall() {
    links | while IFS='|' read -r dst src; do
        if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
            rm -f "$dst"; echo "已移除链接 $dst"
        fi
    done
    echo "（源码仍在本目录，未删除）"
}

do_status() {
    links | while IFS='|' read -r dst src; do
        if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
            echo "链接   $dst"
        elif [ -L "$dst" ]; then
            echo "错链   $dst -> $(readlink "$dst")"
        elif [ -e "$dst" ]; then
            echo "实体   $dst （非软链接，可能被 KDE 原子写替换过，重跑 install 可修复）"
        else
            echo "缺失   $dst"
        fi
    done
}

case "$ACTION" in
    install)   do_install ;;
    uninstall) do_uninstall ;;
    status)    do_status ;;
    *) echo "用法: $0 [install|uninstall|status]" >&2; exit 2 ;;
esac
