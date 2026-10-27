# 贡献指南

感谢你愿意给 `dsh-cua-driver-indicator` 提 PR。这份文档讲三件事：**代码长什么样**、
**怎么跑测试**、**改动要守什么规矩**、**怎么发一个版本**。

> 中文为主；英文读者看 [README.en.md](README.en.md)。

## 目录结构

| 路径 | 职责 | 改动规矩 |
| --- | --- | --- |
| `lib/index.js` | 插件入口：监听 `tools/execute`、维护提示显隐、组装横幅、**软强制门**、从宿主取会话标题、拉起并驱动 Windows 画面层、把 Esc 事件接到停止逻辑、注册 `computer_control_goal` 工具、跑「官方工具名」自检 | 判定逻辑不要写在这里 |
| `lib/goal.mjs` | 纯逻辑：目标摘要、人话判定（机器话不进目标）、问句/抱怨判定、动作词映射、横幅拼装、会话身份回落、按会话存放的目标状态、**强制门判定与接线**、消息来源判定 | **零 import** |
| `lib/series.mjs` | 纯状态机：接管租约、在途调用登记、Esc 停止与封禁范围 | **零 import** |
| `scripts/windows-takeover.cs` / `.ps1` | Windows 画面层（复制自上游，见 `THIRD_PARTY.md`） | 不要改；要改先去上游 |
| `tests/goal.test.mjs` | `node --test` 可跑的单元测试（目标摘要、人话判定、动作词、横幅、来源过滤、强制门、闸门接线） | 跟着实现改 |
| `tests/series.test.mjs` | `node --test` 可跑的单元测试（租约与停止语义） | 跟着实现改 |
| `scripts/check-package.mjs` | 打包产物检查（`npm pack --dry-run --json` + 断言） | 可以 |
| `docs/self-check.md` | 发版前逐项自检清单 | 跟真实情况走 |
| `assets/icon-180.png` | 插件图标（180×180） | 随版本更新 |
| `cordis.patch.yml` | DSH 的 bundle 补丁声明 | 极少改 |

## 怎么跑测试

**不需要 `npm install`**：插件没有运行时依赖，测试只 import 纯逻辑模块，装依赖反而会因为
`"os": ["win32"]` 在非 Windows 上直接被拒。

```powershell
node --check lib/index.js
node --check lib/goal.mjs
node --check lib/series.mjs
node --test tests/goal.test.mjs
node --test tests/series.test.mjs
```

两条 `node --test` 都必须全绿。CI（`.github/workflows/tests.yml`）在 node 20 与 node 22 上
各跑一遍这两条命令。

打包产物顺手看一眼：

```powershell
node scripts/check-package.mjs
```

它跑 `npm pack --dry-run --json`，然后断言发出去的包里**没有** `node_modules/`、`*.tgz`、
`*.bak-*`，且**必须有** `lib/goal.mjs`、`lib/index.js`、`lib/series.mjs`、`cordis.patch.yml`、
`LICENSE`、`README.md`；有违例就 `exit 1`。

## 改动规矩

### 1. `lib/goal.mjs` 与 `lib/series.mjs` 零 import

这两个文件**不许 import 任何东西**（连 `node:fs` 都不行）。它们是纯逻辑：没有宿主、没有
定时器、没有子进程，所以普通 node 能直接 import，测试能直接驱动。

需要读宿主的那条规则，就把规则本身写成纯函数，**由 `lib/index.js` 把宿主的数据喂进来**。

### 2. 判定与接线分离，两样都得在被测单元里

强制门这件事上踩过坑，值得写清楚：

- **判定规则**（放行还是退回）是纯函数：`decideGoalGate(hasDeclaredGoal, alreadyBlocked)`
  → `'allow'` / `'block'`。
- **接线**（读声明目标、读本轮拦截记录、**记住本轮**、**取轮次**）也必须留在被测单元里：
  `evaluateGoalGate(store, states, context)` 只读不写，`runGoalGate(...)` 被拦时由它自己
  `states.set(...)`。
- 因此 `lib/index.js` 里**不允许**出现 `states.set(`，也不允许内联第二份判定 ——
  只调 `runGoalGate`、按 `decision` 抛错或放行、必要时打一条 warn。

这条不是洁癖：判定规则测试全绿，**不代表接线是对的**。0.6.1 → 0.6.3 这两版就是因为接线
留在 `lib/index.js`（那里没有宿主，跑不了测试）被评审打回 —— 把 `alreadyBlocked` 写成常量
`false`、或把 `turn` 传丢，整套测试仍然全绿，闸门却退化成「永久拦」（死锁）。

配套要求：

- 改**判定** → 同步改 `tests/goal.test.mjs` 里的用例；
- 改**接线** → 补一条「容器里真的出现这一轮」的用例（例如
  `states.get('s1').blockedTurns` 变成 `['1']`）。

### 3. 不要动的三样东西

- **模型可见的工具名 `computer_control_goal`**：改名会打断所有在用的会话。
- **配置树里的行 id `cua-driver-indicator`**：改名会让用户 profile 里的覆盖行失效。
- **`scripts/windows-takeover.*`**：这是上游拷贝，改动要回上游（见 `THIRD_PARTY.md`）。

### 4. 版本号与文档要同步

`package.json` 的 `version` 与 `README.md` 顶部第一个版本标题必须一致 ——
`tests/goal.test.mjs` 里有一条用例就断言这件事。**不要把版本号写死在测试里**：那条断言拿
`package.json` 跟自己比。

改版本时同步更新 `CHANGELOG.md`（只写真实发生过的改动）。

### 5. 提交信息

Conventional Commits，英文正文：

```
feat(assets): add the plugin icon (180x180)
ci: run the test suites on push and pull requests
docs: add the changelog
fix: keep the banner off the goal when the turn is missing
```

## 发布流程

1. **升版本号**：`package.json` 的 `version` 用语义化版本；同时更新 `README.md` 顶部第一个
   版本段落与 `CHANGELOG.md`。测试会断言 README 与 `package.json` 一致。
2. **跑测试**：上面那两条 `node --test` 加 `node scripts/check-package.mjs`，全绿再往下走。
3. **打包**：先用 `npm pack --dry-run --json` 看产物清单，确认没有 `node_modules/`、`*.tgz`、
   `*.bak-*`；再 `npm pack` 打出 tgz。
4. **装进 profile 试**：
   `dsh plugin --profile <profile> add <包名或打出来的 tgz 路径>`
   （确切写法以 `dsh plugin add --help` 为准）。装已发布的版本就是
   `dsh plugin --profile <profile> add dsh-cua-driver-indicator`。
5. **重启 DSH**：插件与配置都在启动时加载，不重启看不到变化。
6. **实机验收**：横幅出现、四段文字对得上、Esc 能真的停住本回合、强制门会退回一次、
   非 Windows 平台只留一条日志不报错。
7. **发布到 npm**：`npm publish`。**发布是不可逆的对外动作，先拿到确认再发。**
8. **收尾**：把这一版写进 `CHANGELOG.md`，打 `v<version>` tag，推 tag。

## 提问与讨论

有想法先开 issue 描述清楚「现在的行为是什么、你期望是什么」；改动前最好先问一句，
避免做出来的东西和你想的不是一个东西。

许可证是 MIT，见 [LICENSE](LICENSE)。
