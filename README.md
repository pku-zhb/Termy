<div align="center">

# Termy

<img src="assets/termy-tg-avatar-transparent.svg" width="120" alt="Termy logo" />

*为 AI CLI 工作流深度定制的 Obsidian 终端*

基于 [ZyphrZero/Termy](https://github.com/ZyphrZero/Termy) 的个人 fork。

[![Version](https://img.shields.io/badge/version-1.5.2-7c3aed?style=for-the-badge)](./manifest.json)
[![Obsidian](https://img.shields.io/badge/Obsidian-Desktop%20Only-8b5cf6?style=for-the-badge)](https://obsidian.md/)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue?style=for-the-badge)](./LICENSE)
[![PTY](https://img.shields.io/badge/backend-Rust%20PTY-f97316?style=for-the-badge)](./rust-servers)
[![Upstream](https://img.shields.io/badge/upstream-ZyphrZero%2FTermy-22c55e?style=for-the-badge)](https://github.com/ZyphrZero/Termy)

<p align="center">
  <img src="assets/termy-poster.png" width="840" alt="Termy 宣传海报" />
</p>

</div>

---

## 这是什么

在 Obsidian 里长期跑 Claude Code / Codex 这类 AI CLI，原版 Termy 已经很好用，但日常重度使用还差几口气：终端多了标签乱、快捷键和 Obsidian/CLI 打架、agent 输出的文件路径点不了。这个 fork 把这些都补上了。

## 与上游的差异

### 🗂 单标签内多终端

一个 Obsidian 标签页内管理多个终端 tab，不再把工作区标签栏撑爆。

| 快捷键 | 动作 |
|---|---|
| `Opt+T` | 新建终端 tab |
| `Opt+W` | 关闭当前 tab（关最后一个自动重开新终端，不关 view） |
| `Opt+Tab` / `Opt+Shift+Tab` | 下一个 / 上一个 tab |
| `Opt+1…9` / `Opt+0` | 跳到第 N / 第 10 个 tab |

tab 栏自带状态图标：自动识别前台运行的 **tmux / Claude Code / Codex / SSH** 并显示对应标志。

### ⌨️ 键盘三分法路由

解决「一个键盘三方抢」的问题，规则可在设置里用 JSON 调整：

- **Opt+\*** → Termy（tab 管理）
- **Cmd+\*** → Obsidian（全局快捷键不被终端吞掉）
- **Ctrl+\*** → 终端内程序（Claude Code / Codex / vim 的键位原样到达，支持黑名单例外）

### 🔗 终端 file:// 链接

AI agent 在输出里引用的 `file://` 路径直接可点：

- vault 内文件在 **Obsidian 里打开**，支持 `#L12` 行号锚点；vault 外走系统默认程序
- 原样空格、`%20` 编码、中文/全角文件名都支持
- **TUI 硬换行完整支持**：Claude Code/Codex/tmux 把长链接折成多行后自动拼回；按词折行吃掉的空格点击时自动找回；相邻链接不粘连；悬停任意一行整条链接同亮、下划线逐行精确

### 🍺 后端 Homebrew 化

Rust PTY 后端 `termy-server` 改为 Homebrew 分发（不再进 vault 同步目录），设置页新增后端卡片显示运行状态和安装指引。

### 🀄 输入法修复

拼音等输入法的合成预览（preedit）在终端内正常显示，不再隐形。

## 安装

**1. 安装插件**（手动）：

从 [Releases](https://github.com/pku-zhb/Termy/releases) 下载最新 `termy-x.y.z.zip`，解压到 vault 的 `.obsidian/plugins/termy/`，在 Obsidian 设置中启用 **Termy**。

**2. 安装后端**：

```bash
brew tap pku-zhb/tap
brew install termy-server
```

升级后端时注意：先 disable 插件、等约 30 秒让旧 server 自动退出，再 enable，否则会重连到内存里的旧进程。

## 致谢

本项目 fork 自 [ZyphrZero/Termy](https://github.com/ZyphrZero/Termy)——原版的架构（Rust PTY 后端 + xterm.js 前端、workflow 系统、拖拽交互、AI 上下文接力）都是上游的工作，请去给原作者 star。上游完整文档见 [原版 README](https://github.com/ZyphrZero/Termy#readme)。

## License

[GPL-3.0](./LICENSE)，与上游一致。
