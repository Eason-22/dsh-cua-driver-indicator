# 更新日志

本文件记录 `dsh-cua-driver-indicator` 每个版本**真实发生过的改动**。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。

> **日期与发布状态的来由**
>
> - `npm view dsh-cua-driver-indicator versions` 当前返回
>   `['0.0.0-stage', '0.4.0', '0.6.4', '0.6.5']`。`0.0.0-stage` 是 npm 暂存发布的占位版本；
>   **0.5.0 – 0.6.3 与 0.7.0 只存在于本仓库，没有发布到 npm**。
> - 0.4.0 的日期来自 npm 的发布记录；0.6.4 / 0.6.5 的日期取自本仓库的提交时间
>   （`5995c6b` / `cbe29bc`，均为 2026-10-27）。0.5.0 – 0.6.3 与它们在同一天内完成，
>   因此也记为 2026-10-27。

## [0.7.1] — 2026-11-05（未发布到 npm：等真机复验后再发）

### 变更

- **界面文案双语，缺省中文。** 面板的可见文案不再写死中文：先读宿主的语言服务
  （`ctx.locale`），其次读浏览器语言，两者都拿不到时**回退中文**（不能因为宿主旧了就让
  中文用户看到英文卡片）。中文文案一个字没改，英文是新增的一套；新增 `locale/zh.json`
  与 `locale/en.json`（与内置字典逐字一致，测试会比对键集合），并在 `package.json` 的
  `exports` / `files` 里声明，写法照抄 profile 里真实可用的官方客户端插件。
- **README 默认英文，中文整份保留。** `README.md` 现在是英文（原 `README.en.md` 的内容），
  中文全文移到 `README.zh.md`，两边顶部互链；`README.en.md` 变成一页「正文已迁到
  README.md」的说明页，旧链接不会 404。打包清单与 `check-package` 的必带列表都加了
  `README.zh.md`。npm 页面正文取包里的 `README.md`，所以要等这一版发布后才会变英文。

## [0.7.0] — 2026-11-05（未发布到 npm：先落代码与文案，真机验证与发布待办）

### 新增

- **前置依赖闸：官方电脑控制通道不在，就问你要不要装。**
  本插件只给 **DSH 官方的电脑控制通道**（工具名 `cua_driver_native__*`）画接管提示条，
  而那两行官方插件在默认的 composition 里**不存在**。现在插件在启动时检查它，缺了就
  在网页里弹窗问：
  - **五态检测**：`available`（通道在，**完全不渲染**）/ `installed-disabled`（装了没启用）/
    `installed-inactive`（装了但官方工具没出现）/ `missing`（没装）/ `unknown`（宿主没回答，
    不弹、不猜）。状态**实时复检**（不是启动时缓存）：工具中途出现时弹窗自动关闭。
  - **`missing` 弹窗**（用户确认后的文案）：标题「本插件需要官方的「电脑控制」插件才能工作」，
    正文三句（说明缺的是什么、本插件只是它的「显示器」、装完要重启一次 DSH 才生效），
    按钮「安装官方电脑控制插件」/「暂不安装」；选「暂不安装」→ 「已跳过。本插件当前不可用，
    下次启动会再提醒一次。」
  - **一键安装**：走**宿主自己的插件管线**，现拉官方当前发布的版本——代码里**不写死任何
    官方包的精确版本号**。
  - **装完真验**：重读宿主的插件清单，**两行都在、且都是启用状态**才算装好；只装上一行不算。
  - **`installed-disabled`**：按钮「去设置页启用」并说明；**`installed-inactive`**：展示
    **已装官方包版本**与**宿主版本**两个真实读数（读不到写 `unknown`，官方包不由 bundle
    提供时也是 `unknown`，不猜），宿主上装了 dsh-autorestart 时给「立即重启」。
- **四种说法分开讲**（不再含糊成一句"装好了"）：装好了 / **半装**（只装上一行 →
  「装上了一部分，通道还不可用：两行官方插件还没都到位，重启后再看」）/ **被另一层配置
  覆盖**（→ 「改动已保留，但被另一层配置覆盖了，可能不会生效」）/ **安装失败**（连不上软件源、
  这里装不上、被取消，各有自己的说法）。
- **重启交给用户**：插件只提示需要重启一次 DSH 才生效；一键重启只在宿主装了
  dsh-autorestart 时以按钮形式出现。
- **`lib/provider.mjs`**（新）：纯逻辑、无副作用。导出五态检测（`detectProviderStatus`）、
  安装目标（`buildInstallTarget`，只接受「包名 + 版本范围」，固定版本会被拒）、
  安装结果与重启结果的错误码映射（`mapInstallOutcome`、`installProvider`、
  `restartProvider`、`describeInstallResult`）。宿主调用由调用方注入，所以不依赖 DSH 就能单测。
- **`client.js`**（新）：浏览器半边，注册到 `shell.overlay` 槽。安装 / 暂不安装 /
  去设置页启用 / 立即重启四个动作都走宿主自己的 `/api/__dsh_cua_indicator/provider` 路由。
- **`tests/provider.test.mjs`**（新）：覆盖五态检测、拿不到工具服务时不崩、安装与重启的
  错误码、半装与"只差重启"的说法差异、源码里没有官方包精确版本号、provider bundle 不随包发布。
- **`provider-bundle/`**（新，源码）：独立发布的 provider bundle 源码，插进那两行官方插件。
  **不随本插件发布**（`package.json` 的 `files` 里没有它，`scripts/check-package.mjs`
  会断言）。

### 变更

- `package.json`：**版本号 0.6.5 → 0.7.0**；新增 `dsh.client`（`platform: web`）、
  `exports` 里的 `"./client"`，`files` 里新增 `client.js` 并显式排除 `provider-bundle`；
  `description` / `keywords` 补上「缺官方通道时弹窗询问 + 一键安装」这条能力。
- `scripts/check-package.mjs`：新增断言——产物里**不含** `provider-bundle/`、本包
  **不依赖**任何官方电脑控制包、源码里**没有**官方包的精确版本号、
  **provider bundle 的每个 insert 行都显式写了 `disabled: false`**（漏了这行，装完插出来
  的行是停用状态，用户会落到「点了安装还是不能用」）；
  同时修好了 npm 新版本把 `pack --dry-run --json` 写成对象时的解析（原来会解析失败）。
- **README 默认改成英文**：GitHub 仓库首页与 npm 页面正文显示的都是 `README.md`，所以
  `README.md` 现在是英文（原 `README.en.md` 的内容），**中文整份保留在 `README.zh.md`**，
  两份文件顶部互相链接。`README.en.md` 留了一个指向新位置的说明页，免得旧链接失效。
  `package.json` 的 `files` 与 `scripts/check-package.mjs` 的必带清单都加上了 `README.zh.md`。

### 修复

- **弹窗在真机上一直不出现（这一版的新功能等于完全失效）。**
  0.7.0 装进 desktop profile 后，「没装官方电脑控制插件」时的弹窗怎么等都不出现。查下来是两个原因：
  - **路由没挂在宿主放行的地方**：宿主只把 **`/api/` 下**的路径交给插件，而插件把状态路由注册在
    `/__dsh_cua_indicator/provider`（少了 `/api` 前缀）→ 客户端的请求拿到 401 → 面板按「状态不明」
    处理，于是什么都不画。真机对照读数：`/api/definitely-not-a-route-xyz` 同样返回 401 —— **401 不代表
    路由存在**，只看 401 会误判成「路由没注册」。
  - **注册时机早于 webServer 就绪**：插件挂载那一刻 webServer 常常还没起来；早期版本在 `apply` 里
    同步取服务、取不到就放弃，路由**从未注册**过。
  现在改成 `/api/__dsh_cua_indicator/provider`，并且**等 webServer 就绪后再注册**（与 `dsh-goal-board`
  的做法一致）。**真机已验证**：`GET /api/__dsh_cua_indicator/provider` → **200**，body 里
  `status: "installed-disabled"`，屏幕弹出「官方电脑控制插件装了，但没有启用」卡片。

### 说明

- **安装包独立发布**：要装的是 `dsh-cua-driver-indicator-provider`，本插件只按
  「包名 + 版本范围」引用它（默认 `>=1`），它自己独立升级。
- **代码里没有官方包的精确版本号**：官方包跟着宿主走，写死版本号必然过时；
  provider bundle 对两个官方包的依赖写的是发布通道。
- **只支持 Windows**：官方通道的原生实现是 Windows 上的 Cua Driver，
  WSL 托管实例 / macOS / Linux 不支持，本仓库也不在那些平台上实测。
- **卸载本插件不会移除已装的官方两行**：那两行属于 provider bundle。

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
