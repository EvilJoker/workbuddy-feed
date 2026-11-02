# WorkBuddy Feed 桌面侧边条

贴屏幕右边缘的窄长条，`Alt+M` 展开/隐藏，唤醒的是**线上 WorkBuddy Feed**（https://memos-cloud.app.workbuddy.host/ ，memos-cloud 项目的线上服务）。用 Chrome App 模式窄窗 + KWin 规则 + nde 全局热键拼成。前身是本地 memos 的 `memos-strip`（2026-11-02 随本地 memos 下线，迁移改造为本目录）。

## 目录结构（本目录 = 源码真身）

```
desktop/
├── install.sh                    # 建/查/删软链接（幂等）
├── bin/
│   ├── feed-strip.sh             # 起窗口 / 显隐 / 状态
│   └── feed-hotkey-nde.sh        # 向 nde 守护注册 Alt+M（幂等，可改键）
├── autostart/
│   ├── feed-strip.desktop        # 登录后起窗口
│   └── feed-hotkey-nde.desktop   # 登录后注册热键
└── kwinrulesrc                   # KWin 窗口规则：置顶 + 去边框 + 不进任务栏
```

家目录里只有软链接，全部由 `install.sh` 维护：

| 家目录位置（软链接） | 真身 |
|---|---|
| `~/.local/bin/feed-strip.sh` | `bin/feed-strip.sh` |
| `~/.local/bin/feed-hotkey-nde.sh` | `bin/feed-hotkey-nde.sh` |
| `~/.config/autostart/feed-strip.desktop` | `autostart/feed-strip.desktop` |
| `~/.config/autostart/feed-hotkey-nde.desktop` | `autostart/feed-hotkey-nde.desktop` |
| `~/.config/kwinrulesrc` | `kwinrulesrc` |

运行时状态（不进本目录）：`~/.feed-strip/`（Chrome 独立 profile、窗口 id、日志）。

## 安装 / 检查 / 卸载

```bash
./install.sh install    # 建软链接 + 通知 KWin 重载；随后跑一次 feed-hotkey-nde.sh 注册热键
./install.sh status     # 逐条看是链接 / 错链 / 实体 / 缺失
./install.sh uninstall  # 只删软链接，源码留在本目录
```

`status` 报「实体」通常意味着 KDE 把软链接替换成了真实文件（KConfig 保存是写临时文件再 rename）。
重跑一次 `install` 即可修复。

## 日常使用

```bash
~/.local/bin/feed-strip.sh status   # 窗口在不在
~/.local/bin/feed-strip.sh toggle   # 切换（等同按 Alt+M）
~/.local/bin/feed-strip.sh show | hide | kill
~/.local/bin/feed-hotkey-nde.sh "Alt+Shift+M"   # 换热键（原地改，不重建）
```

可调参数（环境变量）：`FEED_URL`（默认管理员 token 免密链接）、`FEED_STRIP_WIDTH`（420）、`FEED_STRIP_HEIGHT`（1040）。

## 与旧 memos-strip 的差异

| | 旧 memos-strip | 新 feed-strip |
|---|---|---|
| 目标 | http://localhost:5230（本地 Docker） | 线上 WorkBuddy Feed（token 免密链接） |
| 窗口 class | MemosStrip | FeedStrip |
| 运行时目录 | ~/.memos-strip/ | ~/.feed-strip/ |
| 脚本/自启名 | memos-strip.sh / memos-hotkey-nde.sh | feed-strip.sh / feed-hotkey-nde.sh |

热键描述为「Feed 侧边条 展开/隐藏」，与旧的「Memos 侧边条」注册互不冲突。

## 实现要点（继承自旧版，实测过的坑）

- **窗口**：`google-chrome --app=URL --class=FeedStrip`，独立 `--user-data-dir` 避免和日常 Chrome 抢单例
- **隐藏/显示**：`xdotool windowunmap` / `windowmap`，不需要最小化，任务栏无痕
- **置顶**：只由 KWin 规则负责。脚本 `pin` 里**刻意不写** `xprop -set _NET_WM_STATE`——实测那行会把 KWin 设好的状态清空（`show` 之后变空、置顶失效）
- **热键**：本机 KGlobalAccel 是 stub、XGrabKey 被 KWin 独占，只能走 `org.nde.global_key_shortcuts` 的 `addCommandAction`
- **免密**：默认 URL 带管理员的 token（见 `自建服务/feed.md`），网关校验 sharecode、应用内 token 自动登录；token 泄露可在 CloudBase 里 `update users set token=gen_random_uuid()` 重置后改这里的默认值

## 排查

| 现象 | 处理 |
|---|---|
| 按 Alt+M 没反应 | `~/.local/bin/feed-hotkey-nde.sh` 看是否仍注册；`install.sh status` 看软链接是否被替换 |
| 窗口在但没有置顶/有边框 | `qdbus org.kde.KWin /KWin reconfigure`，再 toggle 一次（规则只在 map 时套用） |
| 窗口起不来 | 看 `~/.feed-strip/chrome.log`；`feed-strip.sh kill` 后重开 |
| 打开是 403/登录页 | sharecode 或 token 失效，更新 `bin/feed-strip.sh` 里的默认 URL |
| 位置/宽高不对 | 屏幕尺寸变了，`show` 会按当前屏宽重算并贴右 |

环境层面的坑（Nde 热键机制、KDE 原子写替换软链接）见 `~/.agents/experience/nde-desktop-hotkey.md`。
