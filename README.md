# dsh-cua-driver-indicator

给 **DSH 官方内置的 Cua Driver 通道**（`cua_driver_native__*`）补上"看得见 + 能喊停"这一层。

官方 CUA Driver 通道本身没有任何屏幕提示（只有一个默认关闭的指针浮层），所以你无从
知道控制从什么时候开始、到什么时候结束。这个插件只补这一层，**不参与任何控制动作**：
不点鼠标、不选窗口，也不注册任何能动手的工具。

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
```

> `goalTemplate` 在 0.3.0 里描述的是整条横幅（`DSH 基于「{goal}」正在控制电脑`），
> 0.4.0 起只描述**目标那一段**（默认 `目标：{goal}`）。如果你的 profile 里显式写过
> 旧的 `goalTemplate`，删掉它即可回到默认值。

## 结构

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 监听 `tools/execute`、维护提示显隐、组装横幅（会话 + 动作 + 目标）、**软强制门**（未声明目标先退回一次）、从宿主取会话标题、拉起并驱动 Windows 画面层、把 Esc 事件接到停止逻辑、注册 `computer_control_goal` 工具、跑"官方工具名"自检 |
| `lib/goal.mjs` | 纯逻辑：目标摘要、人话判定（机器话不进目标）、问句/抱怨判定、动作词映射表、横幅拼装、会话身份回落、按会话存放的目标状态（含"有没有模型声明的目标"）、**强制门判定**（放行/退回、按轮次的拦截状态、目标存储键）与**闸门接线**（`evaluateGoalGate` 评估 + `runGoalGate` 记住本轮 + `execTurn` 取轮次 + `gateStateKey` 统一键）、消息来源判定。可脱离 DSH 单测 |
| `lib/series.mjs` | 纯状态机：接管租约、在途调用登记、Esc 停止与封禁范围。可脱离 DSH 单测 |
| `scripts/windows-takeover.*` | Windows 画面层（复制自上游，见 `THIRD_PARTY.md`） |
| `tests/series.test.mjs` | `node --test` 可跑的单元测试（租约与停止语义） |
| `tests/goal.test.mjs` | `node --test` 可跑的单元测试（目标摘要、人话判定、动作词、横幅拼装、来源过滤、跨轮保留、模型目标标志、**强制门五条语义**、**闸门接线用例**、**记住本轮/缺轮次用例**） |

## 验证

```powershell
node --check lib/index.js
node --check lib/goal.mjs
node --check lib/series.mjs
node --test tests/series.test.mjs
node --test tests/goal.test.mjs
```

## 许可证

MIT，见 [LICENSE](LICENSE)。画面层来自上游，见 `THIRD_PARTY.md` 与
`LICENSE-THIRD-PARTY`。
