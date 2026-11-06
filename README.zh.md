# dsh-cua-driver-indicator

[English](README.md) | 中文

> **0.8.0：桌面上多了四件精度工具**
>
> - **`cua_snap_click`**：点之前先看落点有没有被别的窗口挡住（挡住就返回 `POINT_COVERED`，
>   不点）；点完按三档判定界面变化（`changed` / `changed_elsewhere` / `unchanged`），
>   只有「没变化」而且这一步是幂等的（`expect_change=idempotent`）时，才按不超过 4 像素的偏移重试一次。
> - **`cua_snap_click_named`**：按控件的可访问名字定位并点击。名字比对前会去掉表情、符号和括号里的
>   内容，然后分三级比较（完全相等 > 一个包含另一个 > 只共享开头）；同名命中多个时**不猜**，
>   返回 `AMBIGUOUS_TARGET` 和候选清单；命中的控件都在屏幕外时返回 `NOT_VISIBLE`（先滚动到它）；
>   窗口本身找不到（`WINDOW_NOT_FOUND`）和控件找不到（`TARGET_NOT_FOUND`）分开报。
> - **`cua_snap_sequence`**：最多 5 步连点，每一步都按名字找、都做同样的判定；任何一步失败就立刻停住，
>   后面的步骤不会执行。
> - **`cua_snap_wait_for`**：等某个名字的控件出现在屏幕上（`timeout_ms`，默认 5000 毫秒），
>   控件出现就算成功，等到超时如实报 `WAIT_TIMEOUT`。
>
> **控件还可以按元素 ID 精确定位**：读一次界面，每个候选都带一个唯一的 `elementId`，所以同名的控件
> 能分得清。ID 只活到下一次重读界面 —— 再用旧 ID 会得到 `ELEMENT_ID_EXPIRED`，不会静默改成
> 按名字猜。控件支持 InvokePattern 时会在后台运行（`manner: invoke`，鼠标不动、窗口不抢前台），
> 否则按坐标点（`manner: point`）。
>
> **只在 Windows 上可用**，和这个插件的其余部分一样。飞书这种自己画界面的 Chromium 应用不支持
> InvokePattern，在那里只能按坐标点击。
>
> 下面仍是 0.7.x 那套能力，行为没有变化。

给 **DSH 官方内置的 Cua Driver 通道**（`cua_driver_native__*`）补上"看得见 + 能喊停"这一层。

官方 CUA Driver 通道本身没有任何屏幕提示（只有一个默认关闭的指针浮层），所以你无从
知道控制从什么时候开始、到什么时候结束。这个插件只补这一层，**不参与任何控制动作**：
不点鼠标、不选窗口，也不注册任何能动手的工具。

## 第三方代码与致谢

这个插件**不是从零写的**：Windows 侧的画面层来自一个第三方开源包。本节一次说清：哪些代码是我们自己的、哪些来自上游、我们动了什么，以及哪些上游代码我们没有拿。

| 归属 | 内容 |
| --- | --- |
| **本插件自有** | `lib/` 全部——横幅组装（会话 + 动作 + 目标）、目标强制门（`computer_control_goal`）、Esc 停止逻辑与接管租约——以及插件自身的清单文件 |
| **取自上游** | `scripts/windows-takeover.cs`、`scripts/windows-takeover.ps1`——Windows 侧画面层：屏幕边缘渐变 + 提示条 + 指针光环 + 一个低级键盘钩子（用来抓物理 Esc） |

上游包是 **[`dsh-computer-use-win`](https://github.com/Yu-tao-Li/dsh-computer-use-win) v0.5.0**，作者 **Yu-tao-Li**，**MIT** 许可。上游的版权声明与许可原文逐字保留在 [LICENSE-THIRD-PARTY](LICENSE-THIRD-PARTY)，完整的署名说明在 [THIRD_PARTY.md](THIRD_PARTY.md)。

**我们只改了一处**：新增 `allowInjectedStop` 开关（上游没有这个开关，默认关；本插件以 `true` 打开），让"被标记为注入式"的物理按键也能当停止键。原因是远程控制软件与输入法钩子会把用户的真实按键标记成注入式，而上游一律忽略注入事件——于是用户真按了 Esc 也停不下来。除此之外，两个文件就是上游 v0.5.0 的原文（取源时逐字节一致）：我们没有往文件头里塞任何注释或署名，署名统一放在本节与 [THIRD_PARTY.md](THIRD_PARTY.md) 两处。

**上游那套桌面自动化后端我们一概没拿**：`mcp/server.mjs`、`scripts/windows-uia.ps1`、它的 24 个 MCP 工具、设置界面、对话操作记录等都没有复制。桌面操作全部交给 DSH 内置的 CUA Driver 通道（`cua_driver_native__*`）——本插件只画横幅、只提供停止信号，不碰任何桌面动作。

---

> **0.7.0：缺官方电脑控制插件时，弹窗问你要不要装**
>
> 用户实机反馈："装了这个插件，横幅没出来。"——查下去是**官方那两行插件根本没装**，
> 而本插件只画那条通道的提示条：通道不在，就没有东西可画。
>
> - **五态检测**（`lib/provider.mjs`，纯逻辑可单测）：`available` / `installed-disabled` /
>   `installed-inactive` / `missing` / `unknown`。状态**实时复检**，不是启动时缓存的。
> - **`missing` 时弹窗问你**（用户确认后的文案）：标题「本插件需要官方的「电脑控制」插件
>   才能工作」，正文三句，按钮「安装官方电脑控制插件」/「暂不安装」；选了「暂不安装」
>   → 「已跳过。本插件当前不可用，下次启动会再提醒一次。」
> - **一键安装**：走**宿主自己的插件管线**，现拉官方当前发布的版本（代码里不写死任何
>   官方包的精确版本号）。
> - **装完真验**：重读宿主的插件清单——**两行都在、且都是启用状态**才算装好；只装上一行
>   不算。
> - **四种说法分开讲**：装好了 / 只装上一行（半装）/ 改动被另一层配置覆盖 / 安装失败，
>   各有自己的提示，不含糊成一句"装好了"。
> - **重启交给用户**：装完提示需要重启一次 DSH 才生效；宿主上装了自动重启插件时，
>   `installed-inactive` 卡片会给「立即重启」按钮。
> - **仅 Windows**：官方通道的原生实现是 Windows 上的 Cua Driver；
>   **WSL 托管实例 / macOS / Linux 不支持，本插件也不在那些平台上实测**。

> **0.6.5：说明「横幅画在哪台机器上」**
>
> 用户问："WSL 不是 Windows 的子系统吗？要控制也只能控制 Windows 桌面吧？"
>
> - 横幅由**宿主在 Windows 侧**绘制（`powershell.exe` + WinForms），所以它出现在
>   **运行 DSH 的那台机器**上；它不是"画在远端"，也不是网页里的元素。
> - **浏览器打开的 web 界面**（Windows 上跑 `dsh web`）→ 连的是同一个 Windows 宿主
>   → 横幅照常显示，功能与桌面应用完全一致。
> - **WSL 里的 DSH** → 宿主是 Linux：官方 Cua Driver 在那里驱动的是 **WSLg 的虚拟
>   显示**（跑在 WSL 里的 Linux 图形程序），**碰不到真正的 Windows 窗口**；而横幅要
>   画给你看，同样得由 Windows 侧的进程来画。结论：WSL 里的实例既控制不了你的 Windows
>   电脑，也画不出横幅。
> - 因此本包标注 `"os": ["win32"]`：在 Linux 上 pnpm 直接拒装（EBADPLATFORM），
>   而不是"装了没反应"。

> **0.6.4：团队/子代理会话的横幅身份 + 机器话标题不进横幅**
>
> 用户实机反馈：横幅显示成
> `DSH 正在控制电脑 · 会话《AgentTeams automatic task ass...》· 正在操作桌面 · 目标：…`
> 并问"这个应该是子智能体吧？怎么样没有子智能体的提示啊？"。
>
> - **根因不是"认不出团队会话"，而是"标题永远压过身份"**。`sessionLabel()` 原来
>   一拿到标题就直接返回，「子代理」那条回落分支根本走不到。团队成员会话的标题
>   是它的第一条 user 消息（AgentTeams 派发文本）自动生成的，于是机器话原样上屏。
> - **`isDerivedSession(session)`**（`lib/goal.mjs`，零 import）：按宿主 `SessionHeader`
>   里真实存在的三个信号判断"这是子会话"——`origin === 'subagent'`、
>   `delegationDepth > 0`、`parentSession` 非空。**实测**：AgentTeams 成员会话的
>   持久化头是 `origin:"subagent", delegationDepth:1, parentSession:<队长会话>`；
>   普通顶层会话是 `delegationDepth:0` 且无 `parentSession`。三个信号都收，
>   宿主只标一个也认得出。
> - **`isMachineTitle(title)`**：机器话判定**复用**本文件已有的词表
>   （`MACHINE_TEXT_PREFIXES` / `MACHINE_TEXT_FRAGMENTS`，也就是
>   `isHumanInstructionText` 背后的那份），**没有第二份词表**。宿主会把标题截断，
>   所以"以已知开头开头"的半截也算机器话。
> - **回落文案**：团队/子代理会话 → 「子代理任务」；普通会话 → 「主会话」；
>   人类标题照常显示（子代理会话标题是人话时仍然显示标题）。
> - 判定全在 `lib/goal.mjs`，`lib/index.js` **一行没改**（横幅本来就调
>   `sessionLabel()`）。闸门三条语义、Esc、租约、动作词、问句排除全部不变。

> **0.6.3：强制门的"接线"整体搬进被测单元**
>
> 0.6.1 把**判定规则**抽成了纯函数，但评审指出一个缝隙：判定规则测试全绿，并不代表
> **接线**是对的。接线（读声明目标、读本轮拦截记录、决定放行还是退回、**记住本轮**、
> **取轮次**）当时还在 `lib/index.js` 里，那里没有宿主就跑不了测试——于是把
> `alreadyBlocked` 写成常量 `false`、或把 `turn` 传丢，**整套测试仍然全绿**，闸门却
> 退化成"永久拦"（死锁）。0.6.2 把判定收进纯函数，但"记住本轮"还留在 `index.js`，
> 评审仍然判 needs_revision。这一版把它彻底搬进去。
>
> - **`evaluateGoalGate(store, states, context)`**（`lib/goal.mjs`，零 import）：
>   读声明目标 + 读本轮拦截记录 → `{ decision, declared, alreadyBlocked, nextState,
>   stateKey, missingTurn }`。它**只读**状态容器，不写。
> - **`runGoalGate(store, states, context)`**：评估之后，**被拦时由它自己**
>   `states.set(stateKey, nextState)`——"记住本轮"这一步从此在被测单元里，
>   `lib/index.js` 再也没有任何 `states.set(...)`。放行时容器不动。返回
>   `{ decision, declared, alreadyBlocked, stateKey, recorded, missingTurn, state }`。
> - **`lib/index.js` 只剩三件事**：调 `runGoalGate` → 按 `decision` 抛错或放行 →
>   必要时打一条 warn。它不再拼 `alreadyBlocked`、不再判断 `decision`、不再写状态。
> - **轮次缺失显式处理（fail-open）**：`turn` 为 `undefined`/`null` 时闸门**放行**并
>   带上 `missingTurn: true`，`index.js` 见到这个标记就打一条 warn。理由：拿不到轮次
>   就永久拦 = 死锁，这是用户明确不能接受的；宁可这一次闸门不生效，也不能把桌面锁死。
>   同时 `execTurn(exec)` 把"轮次怎么从宿主对象里读"这条规则也搬进了 `lib/goal.mjs`，
>   插件与闸门不会再各算各的。
> - **键统一**：`gateStateKey(sessionId, agentId)` 是闸门状态键的**唯一入口**，
>   写入（`runGoalGate`）与清理（`clearGate`）走同一个函数，两边不会再指向不同的桶。
> - **用例钉住接线**（`tests/goal.test.mjs`）：被拦时容器里真的出现这一轮
>   （`states.get('s1').blockedTurns` = `['1']`）、同轮重试放行、换轮再拦、缺轮次放行
>   且 `missingTurn` 为真、`turn=0` 也算一轮、状态容器不存在时放行……
>   外加 `GATE_ALLOW`/`GATE_BLOCK` 两个字面值断言。
> - 只保留三条**极简源码断言**（它们只是补充防线，行为由上面的用例保证）：
>   `index.js` 必须调用 `runGoalGate(` 且不得出现 `evaluateGoalGate(` /
>   `decideGoalGate(` / `gateStateBlocks(` / `nextGateState(` / 任何 `states.set(`；
>   调用点的实参对象里必须带 `turn`；`clearGate` 必须用 `gateStateKey(`。
>
> 闸门的**行为语义一点没变**（有声明放行 / 无声明首次拦 / 同轮重试放行 / 换轮重拦 /
> 摘要不算声明），工具名 `computer_control_goal` 不变。唯一的差别在退化宿主上：
> 轮次不可用时闸门选择**放行**而不是把桌面锁死。

> **0.6.1：给强制门补上常驻回归测试，目标存储键统一**
>
> 0.6.0 的强制门当时**没有任何常驻测试**——唯一证据在一个临时 harness 里，删了就没
> 了。这一版把它钉死在仓库里：
>
> - **闸门判定抽成纯函数**：判定规则搬到 `lib/goal.mjs`（零 import 的纯逻辑文件），
>   `lib/index.js` 只调用它，**不再内联第二份判定**——将来改一处不会漏另一处。
>   纯函数有两个：`decideGoalGate(hasDeclaredGoal, alreadyBlocked)` → `'allow'` /
>   `'block'`；`nextGateState(state, turn)` → 下一份拦截状态（不累积、不突变）。
> - **五条语义各有常驻用例**（`tests/goal.test.mjs`）：
>
>   | 场景 | 期望 |
>   | --- | --- |
>   | 有模型声明的目标 | 放行 |
>   | 无声明 + 本轮首次 | 退回一次 |
>   | 无声明 + 本轮已退回过一次 | **放行**（不死锁的保险） |
>   | 换一轮（turn 变了） | 重新退回一次，拦截不累积 |
>   | 目标只是**自动摘要** | **仍然退回**（摘要不能绕过闸门） |
>
> - **目标存储键统一成 `session.id`**：以前模型声明的目标按 `exec.agent.id` 存，横幅
>   却按 `session.id` 读——今天宿主强制两者相等所以没出事，但将来宿主放宽这条不变量时，
>   横幅会**静默退回自动摘要**。现在存与读都用 `session.id`，`agent/disposed` 两种
>   id 都清（防御）。
>
> 工具名 **`computer_control_goal` 不变**，行为不变（强制门仍然只拦一次、拦截不占
> 租约、按轮次重置）。
>
> **0.6.0：加一道软强制门——动桌面前先说清目的**
>
> 用户的要求原话：「不能让调用电脑控制的模型自己先说清楚目的才给调用吗？就是拦住
> 一轮问目的，回答了才给用」。
>
> - **第一次动桌面会被退回一次**：会话还没声明目标时，它第一次调官方桌面工具会被
>   拦下，模型收到一条可执行的错误：
>
>   ```
>   先调用 computer_control_goal 声明本轮目标（不超过 24 字，说清要做什么），用户屏幕上会显示它；声明之后重试这个桌面操作。
>   ```
>
>   模型声明完目标重试同一个调用就放行——**只拦一次，绝不死锁**。模型要是压根不
>   声明就重试，同一轮里的第二次调用也会放行，同时在日志里留一条 warn（带
>   sessionId 与工具名），方便事后排查。
> - **拦截不占租约**：拦截发生在取得桌面租约**之前**，被拦的调用不碰租约、不影响
>   Esc 停止与空闲收起。拦截计数**按轮次重置**（`turn/end` 清空），下一轮重新算一次。
> - **动作词不再留过期值**：一轮结束或序列结束（空闲 30 秒收起）时，「正在做什么」
>   回到「正在操作桌面」，横幅的会话名与目标段照常显示。
> - **动作词补齐**：`move` / `move_cursor` → 正在移动鼠标，`bring_to_front` →
>   正在切换窗口，`start_recording` / `stop_recording` → 正在录制屏幕，剪贴板类 →
>   正在操作剪贴板，浏览器类 → 正在操作浏览器；未知名仍兜底「正在操作桌面」。
>
> 工具名 **`computer_control_goal` 不变**。
>
> **0.5.0：横幅多一段「正在做什么」，目标不再乱跳**
>
> 横幅是：
>
> ```
> DSH 正在控制电脑 · 会话《<会话标题>》· 正在点击 · 目标：<目标>
> ```
>
> - **多开了几个会话也认得出来**：会话标题取自宿主的 session-title 服务；取不到时
>   普通会话显示「主会话」、子代理会话显示「子代理」。标题超过 30 字自动截断。
> - **多了一段永远是真的「正在做什么」**：宿主知道当前在调哪个官方桌面工具，所以
>   这一段是事实，不是猜的——`正在看屏幕` / `正在点击` / `正在输入` / `正在按键` /
>   `正在滚动` / `正在拖拽` / `正在启动程序` / `正在查看窗口`；认不出来的工具一律
>   兜底成「正在操作桌面」，**不会**露出英文工具名，也**不会**空着。
> - **模型声明的目标跨轮保留**：以前每轮结束就清掉，后续轮次只能退回引用用户原话，
>   于是横幅上出现了用户的抱怨原话。现在声明的目标一直留着，只在**会话关闭**或
>   **用户下了新的真人指令**时才换掉。
> - **问句和抱怨不再是目标**：真人消息里**命中下面任一关键词就判为非指令**
>   （关键词**出现在任意位置**都算，不是只看开头）：
>
>   ```
>   似乎   好像   为什么   怎么   怎么回事   没看懂   看不懂
>   是不是   能不能   可不可以   啊这
>   ```
>
>   另外：文本带中文或英文问号（`？` / `?`）→ 非指令；文本少于 4 个字符 → 非指令。
>   非指令的消息**不作为目标**，也不会把已经有的目标顶掉。
>
> 工具名 **`computer_control_goal` 不变**。
>
> **0.4.0：横幅改成三段式（会话身份 + 目标）**
>
> 横幅当时是：
>
> ```
> DSH 正在控制电脑 · 会话《<会话标题>》· 目标：<目标>
> ```
>
> - **目标里不再有机器话**：自动摘要只接受人写的指令。系统注入的上下文（AgentTeams
>   派发文本、`<system-reminder>`、runtime context、`continuum_resume`、模型切换、
>   计划模式切换、审批策略变更、后台子代理通知等）一律**不作为目标**，横幅里那一段
>   干脆不出现，不会留一个空的"目标："。
>
> 工具名 **`computer_control_goal` 不变**。

> **0.3.0 是改名版本（破坏性变更）**
>
> 包名从 `dsh-computer-control-indicator` 改为 **`dsh-cua-driver-indicator`**，
> 让人一眼看出它补的是官方内置 **Cua Driver** 那条通道（官方包名
> `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native`）。
> 插件在配置树里的 **行 id** 也随之从 `computer-control-indicator` 改为
> `cua-driver-indicator`：你自己在 profile 的 `cordis.patch.yml` 里写过
> `- id: computer-control-indicator` 的覆盖行，需要改成新 id，否则不再生效。
> 模型可见的工具名 **`computer_control_goal` 不变**。

## 安装

插件是 Windows 专用（画面层是 WinForms 浮层）。在 DSH 里装：

```powershell
dsh plugin --profile <profile> add dsh-cua-driver-indicator
```

把 `<profile>` 换成你正在用的 profile 名（例如 `default`）。装完**重启 DSH** 生效。

非 Windows 平台不会启动画面层：插件照常加载，只在日志里留一条

```
cua-driver-indicator: takeover indicator is Windows-only; disabled on linux
```

其余功能全部退场，不报错、不崩溃。

## 它依赖什么：DSH 官方的电脑控制插件

本插件只画接管提示条。它画的那条通道是 **DSH 官方的电脑控制通道**
（工具名 `cua_driver_native__*`），而官方通道在默认的 composition 里**不存在**。

所以本插件在启动时会检查它，缺了就**在网页里弹窗问你**：

| 状态 | 弹窗里说什么 | 你能做什么 |
| --- | --- | --- |
| `available` | **什么都不显示** | —— 官方通道在，横幅照常工作 |
| `missing` | 「本插件需要官方的「电脑控制」插件才能工作」 | 「安装官方电脑控制插件」/「暂不安装」 |
| `installed-disabled` | 「官方电脑控制插件装了，但没有启用」 | 「去设置页启用」 |
| `installed-inactive` | 「官方电脑控制插件装了，但工具没有出现」 | 「立即重启」（装了自动重启插件时才有） |
| `unknown` | 不弹 | 宿主没回答，插件不乱猜 |

- **不安装的话本插件将不可用**：没有官方通道，就没有东西可画，官方桌面工具也用不了。
  选了「暂不安装」之后，左下角留一行字说明这件事，不会再弹第二次（下次启动还会问）。
- **每次启动都问**：网页打开时弹窗会出现一次；官方通道在接下来的任何时刻出现
  （比如你手动装了），弹窗会自己关掉——因为状态是**实时复检**的，不是启动时缓存的。
- **只支持 Windows**：官方通道的原生实现是 Windows 上的 Cua Driver。
  **macOS / Linux / WSL 托管实例不支持，本插件也不在那些平台上实测**。
- **装了但没生效**时，弹窗会给出两个真实读数：**已装官方包版本**与**宿主版本**，
  方便你看出版本漂移；读不到就写 `unknown`，不猜。
  官方包**不由某个 bundle 提供**时，「已装官方包版本」就是 `unknown`：宿主没有按包名
  暴露这个版本，插件不去猜一个数字出来。

### 缺官方电脑控制插件时的弹窗与一键安装

没有官方通道时，网页里会弹出这张卡片（`missing` 状态）：

- **标题**：「本插件需要官方的「电脑控制」插件才能工作」
- **正文**：
  1. 检测到你还没安装（或没有启用）DSH 官方的电脑控制插件。
  2. 本插件只是它的「显示器」——屏幕上的横幅、按 Esc 中断，全靠它来驱动电脑。它不在，
     本插件就完全用不了：不是功能少一点，而是没有任何东西可显示。
  3. 装好之后要重启一次 DSH 才会生效。
- **按钮**：「安装官方电脑控制插件」/「暂不安装」。选「暂不安装」之后，左下角留一行
  「已跳过。本插件当前不可用，下次启动会再提醒一次。」

点「安装官方电脑控制插件」之后：

- 安装**走宿主自己的插件管线**，现拉官方当前发布的版本——**本仓库的代码里不出现任何官方包
  的精确版本号**（官方包跟着宿主走，写死版本号必然过时）。
- 装完**重读宿主的插件清单做真验**：**两行都在、且都是启用状态**才算装好；只装上一行
  不算，那种情况会单独告诉你「装上了一部分，通道还不可用」，不会含糊成一句"装好了"。
- **重启由你决定**：插件只提示需要重启一次 DSH 才生效；宿主上装了自动重启插件时，
  `installed-inactive` 卡片会额外给一个「立即重启」按钮。

**仅 Windows**：官方通道的原生实现是 Windows 上的 Cua Driver。
**WSL 托管实例 / macOS / Linux 不支持，本插件也不在那些平台上实测。**

### 安装包是独立发布的

要装的东西是一个**独立的 npm 包**：`dsh-cua-driver-indicator-provider`（provider bundle）。

- 它的源码在本仓库的 [`provider-bundle/`](provider-bundle) 目录里，**但不随本插件发布**
  （本插件 `package.json` 的 `files` 里没有它，`scripts/check-package.mjs` 会断言这一点）。
- 本插件只按「**包名 + 版本范围**」引用它（默认 `dsh-cua-driver-indicator-provider@>=1`），
  版本范围写在配置里，可以改。
- **本仓库的代码里不出现任何官方包的精确版本号**：官方包跟着宿主走，写死版本号必然过时。
  provider bundle 对两个官方包的依赖写的是**发布通道**（`next`），理由见
  [provider-bundle/README.md](provider-bundle/README.md)。
- **卸载本插件不会移除已装的官方两行**：那两行属于 provider bundle，不属于本插件。

### 版本漂移怎么办

- 官方包升级 → provider bundle 的依赖是通道名，不用改；必要时重启 DSH 即可。
- provider bundle 升级 → 本插件不用改，也不用重发。
- 本插件升级 → 与官方包无关。

## 它做什么

1. **亮条**：官方通道第一次真正操作桌面时，在屏幕顶部（或底部）出现一条不抢焦点、
   鼠标可穿透的提示条；指针旁出现光环与 DSH 徽标。
2. **四段式横幅**：提示条上的文字是
   **DSH 正在控制电脑 · 会话《<会话标题>》· 正在点击 · 目标：<目标>**。
   - **谁在控制**：会话标题来自宿主，取不到时回落成「主会话」/「子代理」；
   - **正在做什么**：由当前正在跑的官方桌面工具推出来，是事实不是猜测；
   - **目标**：两个来源：
     - **打底**：自动摘要你最近一条真人指令（注入的环境上下文不算）；
     - **覆盖**：模型可以调用 `computer_control_goal` 工具上报更准确的目标，它在本会话内
       优先于自动摘要，**跨轮保留**，直到你换目标或用户下了新的真人指令。
   暂时没有目标时，整段「· 目标：…」**不出现**，不会留一个空的"目标："；
   「正在做什么」那一段**永远在**。
3. **收条**：本轮结束、或最后一次桌面调用之后空闲 30 秒，提示自动收起。
4. **Esc 真停**：物理 Esc 会**中断正在执行的官方桌面调用**，并封禁本回合剩余的桌面
   调用（下一轮可以正常使用）。这是本插件相对"只有提示"的关键增量。
5. **先说目的再动手（软强制门）**：会话还没声明目标时，它第一次调官方桌面工具会被
   **退回一次**，模型收到一条可执行的错误（叫它先调 `computer_control_goal`
   声明本轮目标，声明后重试同一个调用即可）。
   - **只拦一次，绝不死锁**：同一轮里的第二次调用一定放行，模型不听话也不会被卡住；
     这种情况下日志里会留一条 warn（带 sessionId 与工具名）。
   - **拦截不占租约**：拦在取得租约之前，被拦的调用什么都不碰。
   - **按轮次重置**：`turn/end` 清掉计数，下一轮重新算一次。
   - **已声明目标的会话不受影响**：目标跨轮保留，下一轮的第一次调用直接放行。

### 关于 Esc 的边界（必须知道）

- Esc 只能中断**正在飞行中**的那一次调用，以及阻止**后续**调用。
  **已经交给应用的输入撤不回来**——点击已经落下、字符已经打进输入框，物理上无法回收。
- 只有物理按键有效；程序模拟的按键（例如 agent 自己发 `press_key`）不会被当作停止信号，
  否则 agent 一次按键就能把自己停掉。

### cua_snap_click：点完要确认真的点到了

内置的 Cua Driver 是「模型指哪就点哪」。实际用起来有两件事会出错：那个点**被别的窗口挡住**
（弹窗、通知、叠放窗口的上半张），或者那个点**偏了几个像素**，落在小目标旁边。

`cua_snap_click` 是另一种点法，它把这两件事都查一遍：

| 参数 | 含义 |
| --- | --- |
| `x`、`y` | 屏幕上的点（物理像素），必填 |
| `window_id` | 你要点的窗口：窗口句柄（十进制或 `0x` 十六进制）或窗口标题的一段；不填就用落点下面那扇窗。想要遮挡保护（判断落点是不是被别的窗口挡住）就必须点名窗口 |
| `element_token` | 可选：快照里的元素标记；工具会核对落点上的元素是不是它，不一致会在结果里说明 |
| `expect_change` | `idempotent`（界面应该变，且重复点安全）、`non_idempotent`（界面应该变，但重复点不安全）、`none`（本来就不该变）。默认 `non_idempotent` |

它按这个顺序做三件事：

1. **先问系统这个点上最上层是哪个窗口。** 给了 `window_id` 时，被点名的那扇窗就是这次
   **唯一**允许点的窗。真的被别的窗盖住时它**不点**：返回 `verification: covered`、
   `code: POINT_COVERED`，以及挡住它那个窗口的标题。`window_id` 根本不存在时是另一个错
   （`WINDOW_NOT_FOUND`），**绝不会**退化成「点最上层那个窗」。不给 `window_id` 时，落点下面
   那个窗就是目标——所以「可见但未激活」的窗是合法目标（结果里会说明）。
2. **点了再看。** 三档答案，每一档都是关于屏幕的事实，不是猜测：
   - `changed`：**落点附近**的像素、或落点元素的 UIA 状态变了：点击打在了该打的地方。
   - `changed_elsewhere`：上面两样都没变，但**整窗变了**：这可能是这次点击的效果落在了别处
     （状态栏、按钮旁边的标签）。这算成功——**绝不会**再点一次。
   - `unchanged`：哪儿都没变：这次点击没有效果。
   光标会**先**移到落点再读第一遍，所以「只是 hover 引起的重绘」也不算变化。
3. **最多偏移 4 像素重试一次。** 只在答案是 `unchanged`（哪儿都没变）**并且**调用方声明了
   `expect_change=idempotent` 时才重试。`changed` 与 `changed_elsewhere` 永远不会被点第二次。偏移必须落在落点那个元素里；重试点会**再核对一次**
   元素，元素不对就不点第二次。不是幂等的目标（「发送」「付款」这类按钮）
   **永远不会被点第二次**。
4. **点下去之前再确认一次**落点仍属于目标窗口：中间冒出来的窗不会收到这次点击；
   结果里会如实标注这次确认有没有发生。
5. **element_token 对不上就拒点**（`ELEMENT_MISMATCH`）：照点会点到别的控件上。UIA 状态读不到时
   **不算**「元素不符」——那只是不知道。

返回是一个对象：`verification`（`changed` / `unchanged` / `covered`）、被挡时的 `POINT_COVERED`、
挡住它的窗口，以及每次尝试的落点与「界面有没有变」。

**它是什么、不是什么**：它不属于官方通道。横幅与目标闸仍然只跟官方工具走；
`cua_snap_click` 就是「点一下，外面包了一层检查」。

## 自检：官方工具名变了要看得见

本插件与官方通道的耦合点只有**一个**：官方工具名的前缀 `cua_driver_native__`。
官方哪天改了前缀，横幅会**无声消失**——没有任何报错，用户只会觉得"插件坏了"。

为此插件挂了一个 60 秒一跳的自检：

- 每次看到官方通道的工具调用，就记下时间；
- **从未看到过**，或者**距上次看到已超过 10 分钟**，就写一条日志；
- 最多每 30 分钟写一条，避免刷屏。

日志长这样（`cua-driver-indicator:` 是日志前缀）：

```
cua-driver-indicator: no official CUA tool call seen for 12 minutes — if the takeover
banner does not appear, the official tool names may have changed (currently matching:
cua_driver_native__*)
```

看到这条，就去确认官方工具名是不是改了，然后同步更新 `lib/index.js` 里的
`OFFICIAL_TOOL_PREFIX` 与 `lib/series.mjs` 里的 `NATIVE_TOOL`。
这条自检**只读两个时间戳、只写一行日志**，不影响横幅、Esc 停止与租约。

## 配置项

在 profile 的 `cordis.patch.yml` 里改，改完重启 DSH 生效：

```yaml
- id: cua-driver-indicator
  config:
    indicatorEnabled: true            # 屏幕边缘 + 提示条
    cursorIndicatorEnabled: true      # 指针光环 + DSH 徽标
    remoteIndicatorVisible: true      # 远程桌面 / 录屏 / 屏幕共享里可见
    indicatorText: 'DSH 正在控制电脑'  # 横幅首段文字
    goalTemplate: '目标：{goal}'       # 目标段模板，{goal} 会被替换
    goalMaxChars: 24                  # 目标摘要最大字数，超出自动截断
    indicatorPosition: top            # top / bottom
    indicatorIdleMs: 1200             # 收起前的淡出延时（200–3000 毫秒）
    idleMs: 30000                     # 空闲多久视为控制结束（毫秒）
    stopOnEscape: true                # 物理 Esc 停止
    providerCheckEnabled: true        # 检测官方电脑控制插件，缺失时弹窗询问
    providerBundle: dsh-cua-driver-indicator-provider   # 独立安装包名
    providerBundleRange: '>=1'        # 安装包版本范围（不写死版本号）
```

> `goalTemplate` 在 0.3.0 里描述的是整条横幅（`DSH 基于「{goal}」正在控制电脑`），
> 0.4.0 起只描述**目标那一段**（默认 `目标：{goal}`）。如果你的 profile 里显式写过
> 旧的 `goalTemplate`，删掉它即可回到默认值。

### cua_snap_click_named：按名字点控件

`cua_snap_click_named` 按控件上显示的文字找到它并点击。名字必须只命中**一个**控件：

| 发生了什么 | 回答 |
| --- | --- |
| 只有一个控件叫这个名字 | 点它的中心；回答里有 `name`、`rect`、`unique: true` 和三档判定（`changed` / `changed_elsewhere` / `unchanged`） |
| 好几个控件叫这个名字 | **不点**：返回 `code: AMBIGUOUS_TARGET` 和候选清单（名字、位置、相似度、层级）。绝不猜 |
| 一个都没有 | **不点**：返回 `code: TARGET_NOT_FOUND` |
| 点名的窗口本身不存在 | **不点**：返回 `code: WINDOW_NOT_FOUND` |
| 同名的控件全都在屏幕外 | **不点**：返回 `code: NOT_VISIBLE` —— 先滚动到那个控件 |

名字比对时会去掉装饰：表情、符号、括号里的内容都丢掉，大小写不敏感，所以
`下载花名册` 能命中 `📥 下载花名册（全部人员）`。匹配分三级——去掉装饰后完全
相等 > 一个包含另一个 > 只共享开头——只取最好的那一级。屏幕外（`IsOffscreen`）
的控件不算候选：它点不到。

点击本身和 `cua_snap_click` 一样：同样的遮挡检查（被挡就返回 `POINT_COVERED`、不点）、
同样的三档判定、同样的重试规则（只有 `expect_change=idempotent` 且答案是 `unchanged` 时才重试）。

### cua_snap_sequence：最多 5 步，按顺序走

`cua_snap_sequence` 按顺序走一串名字。**最多 5 步**：更长的一律返回 `TOO_MANY_STEPS`、一步都不执行。
每一步都按名字找到、点下去，并用同样的三档判定校验：`changed` 与 `changed_elsewhere` 都算成功、继续下一步；
其他任何情况（找不到、同名多个、被挡、没变化）立刻停住。回答里说明停在第几步、**后面的步骤没有执行**。
回答里的 `verification` 是整串的档位（每一步都是 changed_elsewhere 就还是 changed_elsewhere），每一步的判定都会逐条列出来。
`expect_change` 不是 `idempotent` 的步骤永远不会被点第二次。

这两个工具想要遮挡保护都得点名窗口：不填 `window_id` 就没有「你指定的窗口」可保护。

### cua_snap_click_named：按元素 ID 操作，以及 cua_snap_wait_for：等控件出现

> **只在 Windows 上可用**。飞书这种自己画界面的 Chromium 应用不支持 InvokePattern，在那里只能按坐标点击。

`cua_snap_click_named` 除了名字还可以填 `element_id`。ID 是读界面时发给的
（每个候选都有一个），所以同名的两个控件能分得开。**ID 只活到下一次重读界面**：
之后再用就返回 `code: ELEMENT_ID_EXPIRED`，不会静默改成按名字猜。控件支持
InvokePattern 时它在后台运行（`manner: invoke`，鼠标不移动）；不支持时按坐标点
（`manner: point`），遮挡检查与三档判定和平时一样。

`cua_snap_wait_for` 等某个名字的控件出现（`timeout_ms`，默认 5000）：出现了
就回答 `found: true`，等到超时还没出现就如实报 `code: WAIT_TIMEOUT`。

## 结构

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 监听 `tools/execute`、维护提示显隐、组装横幅（会话 + 动作 + 目标）、**软强制门**（未声明目标先退回一次）、从宿主取会话标题、拉起并驱动 Windows 画面层、把 Esc 事件接到停止逻辑、注册 `computer_control_goal` 工具、跑"官方工具名"自检 |
| `lib/goal.mjs` | 纯逻辑：目标摘要、人话判定（机器话不进目标）、问句/抱怨判定、动作词映射表、横幅拼装、会话身份回落、按会话存放的目标状态（含"有没有模型声明的目标"）、**强制门判定**（放行/退回、按轮次的拦截状态、目标存储键）与**闸门接线**（`evaluateGoalGate` 评估 + `runGoalGate` 记住本轮 + `execTurn` 取轮次 + `gateStateKey` 统一键）、消息来源判定。可脱离 DSH 单测 |
| `lib/series.mjs` | 纯状态机：接管租约、在途调用登记、Esc 停止与封禁范围。可脱离 DSH 单测 |
| `lib/snap-click.mjs` | 纯逻辑：**cua_snap_click** 工具——参数归一、重试偏移（最多 4 像素）、「界面到底变了没有」的判定、工具定义，以及与 Windows 助手对话的后端。可脱离 DSH 单测 |
| `lib/provider.mjs` | 纯逻辑：**官方电脑控制通道的五态检测**（available / installed-disabled / installed-inactive / missing / unknown）、安装目标（包名 + 版本范围）、安装结果与重启结果的错误码映射。可脱离 DSH 单测 |
| `client.js` | 浏览器半边：官方通道缺失时的**居中弹窗**（安装 / 暂不安装 / 去设置页启用 / 立即重启）、状态实时复检；通道在时**完全不渲染** |
| `provider-bundle/` | **独立发布**的 provider bundle 源码（不进本插件的 npm 包），见 [provider-bundle/README.md](provider-bundle/README.md) |
| `scripts/windows-takeover.*` | Windows 画面层（复制自上游，见 `THIRD_PARTY.md`） |
| `scripts/manual-snap-click-scenario.ps1` | 真机场景：两个 WinForms 窗口（目标窗 + 盖住它的窗）、打印出来的坐标，以及运行脚本要读的几何文件 |
| `scripts/manual-snap-click-run.mjs` | 用真的原生助手驱动那个场景，逐点打印工具的回答 |
| `scripts/windows-snap-click.*` | **cua_snap_click** 的原生半边：窗口探测（这个点上最上层是谁）、窗口像素哈希与落点元素的 UIA 状态，以及真正的点击 |
| `tests/snap-click.test.mjs` | `node --test` 可跑的单元测试（被挡就不点、点了有变化、没变化且非幂等时不重试、幂等时偏移 4 像素内只重试一次、工具定义） |
| `tests/series.test.mjs` | `node --test` 可跑的单元测试（租约与停止语义） |
| `tests/goal.test.mjs` | `node --test` 可跑的单元测试（目标摘要、人话判定、动作词、横幅拼装、来源过滤、跨轮保留、模型目标标志、**强制门五条语义**、**闸门接线用例**、**记住本轮/缺轮次用例**） |
| `tests/provider.test.mjs` | `node --test` 可跑的单元测试（**五态检测**、安装/重启错误码、**源码里没有官方包精确版本号**、provider bundle 不随包发布） |

## 验证

```powershell
node --check lib/index.js
node --check lib/goal.mjs
node --check lib/series.mjs
node --check lib/provider.mjs
node --check lib/snap-click.mjs
node --test tests/series.test.mjs
node --test tests/goal.test.mjs
node --test tests/provider.test.mjs
node --test tests/snap-click.test.mjs
node --test tests/
node scripts/check-package.mjs
```

### 真机场景（仅 Windows）

`cua_snap_click` 的行为要对着**两个真实窗口**验，不只是对着假后端。场景脚本把窗口开起来、
把坐标打印出来，并写进 `%TEMP%\\snap-click-geometry.json`；运行脚本用真的原生助手点这些点：

```powershell
powershell -NoProfile -STA -ExecutionPolicy Bypass -File scripts/manual-snap-click-scenario.ps1
# 另一个 shell 里，等两个窗口都出来之后：
node scripts/manual-snap-click-run.mjs
```

运行脚本对每个点都打印：`verification`（`changed` / `changed_elsewhere` / `unchanged` /
`covered`）、`code`、有没有点、有没有重试、挡住它的是哪个窗口、以及点下去之前有没有再确认
一次。点分别是：落点附近像素会变的按钮（`changed`）、效果落在旁边标签上的按钮
（`changed_elsewhere`）、静态文字（点了什么也不会发生 -> `unchanged` 并且重试一次）、悬停变色但
点击无效的面板，以及被遮挡窗口盖住的点（`covered`）。

## 许可证

MIT，见 [LICENSE](LICENSE)。画面层来自上游，见 `THIRD_PARTY.md` 与
`LICENSE-THIRD-PARTY`。
