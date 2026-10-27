# 第三方代码出处 / Third-party attribution

本插件（`dsh-cua-driver-indicator`）**自有的部分**是 `lib/`（提示逻辑与 Esc 停止逻辑）与插件清单。

`scripts/windows-takeover.ps1` 与 `scripts/windows-takeover.cs` **取自**下面这个上游包的
v0.5.0（取源时逐字节一致）。`windows-takeover.cs` **带一处本地补丁**：新增
`allowInjectedStop` 开关，使"被标记为注入式"的物理按键也能作为停止键——远程控制软件与
输入法钩子会把用户的真实按键标记成注入式，上游一律忽略，于是真实 Esc 永远停不下来。
插件以 `allowInjectedStop: true` 打开它，并对自己发起的按键注入做时间窗屏蔽。其余与上游一致。

| 项 | 值 |
| --- | --- |
| 包名 | `dsh-computer-use-win` |
| 版本 | 0.5.0 |
| 作者 | Yu-tao-Li |
| 仓库 | https://github.com/Yu-tao-Li/dsh-computer-use-win |
| 许可 | MIT（原文见同目录 `LICENSE-THIRD-PARTY`） |

这两个文件负责 Windows 侧的那一层画面：无边框、不抢焦点、鼠标可穿透的屏幕边缘
渐变 + 提示条 + 指针光环，以及一个低级键盘钩子（用于捕获物理 Esc）。

## 我们没有复制的部分

上游包还包含一整套完全独立的桌面自动化后端（`mcp/server.mjs`、`scripts/windows-uia.ps1`、
它的 24 个 MCP 工具、设置界面、对话操作记录等）。本插件**一概不用**：桌面操作全部交给
DSH 内置的 CUA Driver 通道（`cua_driver_native__*`）。

因此上游升级不会带来需要跟随的改动：这两个文件是稳定的画面层，只有在我们要新的视觉效果
时才需要重新取一份。

## MIT 许可要求

MIT 许可要求保留版权声明与许可原文。本目录的 `LICENSE-THIRD-PARTY` 即为原文，
本文件即为署名说明。再分发本插件时请一并保留这两个文件。
