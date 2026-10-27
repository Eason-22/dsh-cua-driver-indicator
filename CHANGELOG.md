# 更新日志

本文件记录 `dsh-cua-driver-indicator` 每个版本**真实发生过的改动**。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

> **日期与发布状态的来由**
>
> - `npm view dsh-cua-driver-indicator versions` 当前返回
>   `['0.0.0-stage', '0.4.0', '0.6.4', '0.6.5']`。`0.0.0-stage` 是 npm 暂存发布的占位版本；
>   **0.5.0 – 0.6.3 只存在于本仓库，没有发布到 npm**。
> - 0.4.0 的日期来自 npm 的发布记录；0.6.4 / 0.6.5 的日期取自本仓库的提交时间
>   （`5995c6b` / `cbe29bc`，均为 2026-10-27）。0.5.0 – 0.6.3 与它们在同一天内完成，
>   因此也记为 2026-10-27。

## [0.6.5] — 2026-10-27（已发布到 npm）

### 文档

- README 澄清「横幅画在哪台机器上」：横幅由 **Windows 侧的宿主进程**（`powershell.exe` +
  WinForms）绘制，所以它出现在**运行 DSH 的那台机器**上；它不是网页里的元素。
- 平台限制写进 README：
  - **浏览器打开的 web 界面**（Windows 上跑 `dsh web`）连的是同一个 Windows 宿主 →
    横幅照常显示，功能与桌面应用完全一致；
  - **WSL 里的 DSH** 宿主是 Linux：官方通道在那边驱动的是 WSLg 的虚拟显示，碰不到
    真正的 Windows 窗口；横幅也要 Windows 侧的进程来画 —— 结论是 WSL 里的实例
    **既控制不了 Windows 桌面，也画不出横幅**。
- 包标注 `"os": ["win32"]`：在 Linux 上 pnpm 直接拒装（EBADPLATFORM），而不是
  「装了没反应」。

## [0.6.4] — 2026-10-27（已发布到 npm）

### 修复

- **横幅不再把机器话当成会话身份**。团队/子代理会话的标题来自 AgentTeams 的派发文本
  （机器话），原先原样上屏，用户看到的是 `会话《AgentTeams automatic task ass...》`。
  - 根因不是「认不出团队会话」，而是**标题永远压过身份**：`sessionLabel()` 原来一拿到
    标题就直接返回，「子代理」那条回落分支根本走不到。
  - 新增 `isDerivedSession(session)`（`lib/goal.mjs`，零 import）：按宿主 `SessionHeader`
    里真实存在的三个信号判断子会话 —— `origin === 'subagent'`、`delegationDepth > 0`、
    `parentSession` 非空；三个信号都收，宿主只标一个也认得出。
  - 新增 `isMachineTitle(title)`：复用本仓库已有的机器话词表
    （`MACHINE_TEXT_PREFIXES` / `MACHINE_TEXT_FRAGMENTS`，也就是 `isHumanInstructionText`
    背后的那份），**没有第二份词表**；宿主会截断标题，所以「以已知开头开头」的半截也算。
  - 回落文案：团队/子代理会话 → 「子代理任务」；普通会话 → 「主会话」；人话标题照常显示。
- `lib/index.js` **一行没改**（横幅本来就调 `sessionLabel()`）：闸门三条语义、Esc 停止、
  租约、动作词、问句排除全部不变。

## [0.6.3] — 2026-10-27（仓库内版本，未发布到 npm）

### 修复

- **强制门的「接线」整体搬进被测单元**。0.6.1 把判定规则抽成了纯函数，但接线
  （读声明目标、读本轮拦截记录、决定放行还是退回、**记住本轮**、**取轮次**）当时还在
  `lib/index.js` 里 —— 那里没有宿主就跑不了测试，于是把 `alreadyBlocked` 写成常量
  `false`、或把 `turn` 传丢，**整套测试仍然全绿**，闸门却退化成「永久拦」（死锁）。
- `evaluateGoalGate(store, states, context)`（`lib/goal.mjs`，零 import）：读声明目标 +
  读本轮拦截记录 → `{ decision, declared, alreadyBlocked, nextState, stateKey, missingTurn }`。
  它**只读**状态容器，不写。
- `runGoalGate(store, states, context)`：评估之后，**被拦时由它自己**
  `states.set(stateKey, nextState)` —— 「记住本轮」这一步从此在被测单元里，`lib/index.js`
  再也没有任何 `states.set(...)`；放行时容器不动。
- `lib/index.js` 只剩三件事：调 `runGoalGate` → 按 `decision` 抛错或放行 → 必要时打一条 warn。
- **轮次缺失显式处理（fail-open）**：`turn` 为 `undefined`/`null` 时闸门**放行**并带上
  `missingTurn: true`，`index.js` 见到这个标记就打一条 warn。理由：拿不到轮次就永久拦 =
  死锁；宁可这一次闸门不生效，也不能把桌面锁死。
- `execTurn(exec)`（读轮次的那条规则）也搬进了 `lib/goal.mjs`，插件与闸门不会再各算各的。
- **键统一**：`gateStateKey(sessionId, agentId)` 是闸门状态键的唯一入口，写入与清理走同
  一个函数。
- **用例钉住接线**（`tests/goal.test.mjs`）：被拦时容器里真的出现这一轮、同轮重试放行、
  换轮再拦、缺轮次放行且 `missingTurn` 为真、`turn=0` 也算一轮、状态容器不存在时放行，
  外加 `GATE_ALLOW` / `GATE_BLOCK` 两个字面值断言。
- 闸门的**行为语义一点没变**（有声明放行 / 无声明首次拦 / 同轮重试放行 / 换轮重拦 /
  摘要不算声明），工具名 `computer_control_goal` 不变；唯一的差别是退化宿主上轮次不可用时
  选择放行而不是把桌面锁死。

## [0.6.2] — 2026-10-27（仓库内版本，未发布到 npm）

### 内部

- 把闸门判定收进纯函数，但「记住本轮」还留在 `lib/index.js`：评审判 needs_revision，
  直接促成 0.6.3 把接线整体搬进被测单元。

## [0.6.1] — 2026-10-27（仓库内版本，未发布到 npm）

### 修复

- **给强制门补上常驻回归测试**。0.6.0 的强制门当时没有任何常驻测试 —— 唯一证据在一个临时
  harness 里，删了就没了。
  - 闸门判定抽成纯函数：搬到 `lib/goal.mjs`（零 import 的纯逻辑文件），`lib/index.js` 只
    调用它，**不再内联第二份判定**。纯函数有两个：`decideGoalGate(hasDeclaredGoal, alreadyBlocked)`
    → `'allow'` / `'block'`；`nextGateState(state, turn)` → 下一份拦截状态（不累积、不突变）。
  - 五条语义各有常驻用例（`tests/goal.test.mjs`）：有模型声明的目标 → 放行；无声明 + 本轮首次
    → 退回一次；无声明 + 本轮已退回过一次 → **放行**（不死锁的保险）；换一轮 → 重新退回一次，
    拦截不累积；目标只是**自动摘要** → **仍然退回**（摘要不能绕过闸门）。
- **目标存储键统一成 `session.id`**：以前模型声明的目标按 `exec.agent.id` 存，横幅却按
  `session.id` 读 —— 今天宿主强制两者相等所以没出事，但将来宿主放宽这条不变量时，横幅会
  **静默退回自动摘要**。现在存与读都用 `session.id`，`agent/disposed` 两种 id 都清。
- 工具名 `computer_control_goal` 不变，行为不变。

## [0.6.0] — 2026-10-27（仓库内版本，未发布到 npm）

### 新增

- **加一道软强制门 —— 动桌面前先说清目的**。会话还没声明目标时，它第一次调官方桌面工具会被
  **退回一次**，模型收到一条可执行的错误：
  先调用 `computer_control_goal` 声明本轮目标（不超过 24 字，说清要做什么），用户屏幕上会显示它；
  声明之后重试这个桌面操作。
- 模型声明完目标重试同一个调用就放行 —— **只拦一次，绝不死锁**。模型要是压根不声明就重试，
  同一轮里的第二次调用也会放行，同时在日志里留一条 warn（带 sessionId 与工具名）。
- **拦截不占租约**：拦截发生在取得桌面租约**之前**，被拦的调用不碰租约、不影响 Esc 停止与
  空闲收起。拦截计数**按轮次重置**（`turn/end` 清空），下一轮重新算一次。
- **动作词补齐**：`move` / `move_cursor` → 正在移动鼠标，`bring_to_front` → 正在切换窗口，
  `start_recording` / `stop_recording` → 正在录制屏幕，剪贴板类 → 正在操作剪贴板，浏览器类 →
  正在操作浏览器；未知名仍兜底「正在操作桌面」。
- **动作词不再留过期值**：一轮结束或序列结束（空闲 30 秒收起）时，「正在做什么」回到
  「正在操作桌面」。
- 工具名 `computer_control_goal` 不变。

## [0.5.0] — 2026-10-27（仓库内版本，未发布到 npm）

### 新增

- **横幅多一段「正在做什么」**。宿主知道当前在调哪个官方桌面工具，所以这一段是事实，不是猜的
  —— `正在看屏幕` / `正在点击` / `正在输入` / `正在按键` / `正在滚动` / `正在拖拽` /
  `正在启动程序` / `正在查看窗口`；认不出来的工具一律兜底成「正在操作桌面」，不会露出英文工具名，
  也不会空着。
- **多开了几个会话也认得出来**：会话标题取自宿主的 session-title 服务；取不到时普通会话显示
  「主会话」、子代理会话显示「子代理」。标题超过 30 字自动截断。
- **模型声明的目标跨轮保留**：以前每轮结束就清掉，后续轮次只能退回引用用户原话，于是横幅上
  出现了用户的抱怨原话。现在声明的目标一直留着，只在会话关闭或用户下了新的真人指令时才换掉。
- **问句和抱怨不再是目标**：真人消息里命中任一关键词就判为非指令（关键词出现在任意位置都算）：
  似乎 / 好像 / 为什么 / 怎么 / 怎么回事 / 没看懂 / 看不懂 / 是不是 / 能不能 / 可不可以 / 啊这；
  另外文本带中文或英文问号（`？` / `?`）→ 非指令；文本少于 4 个字符 → 非指令。非指令的消息
  **不作为目标**，也不会把已经有的目标顶掉。
- 工具名 `computer_control_goal` 不变。

## [0.4.0] — 2026-10-27（首个公开版，已发布到 npm）

### 新增

- **横幅改成三段式（会话身份 + 目标）**：
  `DSH 正在控制电脑 · 会话《<会话标题>》· 目标：<目标>`
- **目标里不再有机器话**：自动摘要只接受人写的指令。系统注入的上下文（AgentTeams 派发文本、
  `<system-reminder>`、runtime context、`continuum_resume`、模型切换、计划模式切换、审批策略变更、
  后台子代理通知等）一律不作为目标，横幅里那一段干脆不出现，不会留一个空的「目标：」。
- 工具名 `computer_control_goal` 不变。

## [0.3.0] — 2026-10-27（仓库内版本，未发布到 npm；破坏性变更）

### 变更

- 包名从 `dsh-computer-control-indicator` 改为 **`dsh-cua-driver-indicator`**，让人一眼看出它补
  的是官方内置 **Cua Driver** 那条通道。
- 插件在配置树里的**行 id** 也随之从 `computer-control-indicator` 改为 `cua-driver-indicator`：
  自己在 profile 的 `cordis.patch.yml` 里写过 `- id: computer-control-indicator` 的覆盖行，
  需要改成新 id，否则不再生效。
- 模型可见的工具名 **`computer_control_goal` 不变**。

## [0.0.0-stage]

- npm 暂存发布用的占位版本，不是功能版本。
