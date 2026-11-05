# 发版自检清单

> 这份清单是**给任何人照着跑**的：每次发版前跑一遍，每条都有可复制的命令和期望结果。
> 清单只覆盖本仓库能自己证明的事；收录方（awesome 列表、插件目录）另有自己的门槛，
> 那部分由提交方自己核对。
>
> 当前仓库版本：**0.7.0**（下面的命令在仓库根目录执行）。

## 0. 环境

| 项 | 要求 |
| --- | --- |
| Node | **>= 22**（`package.json` 的 `engines.node`） |
| 平台 | 打包与发版在 **Windows** 上做（`"os": ["win32"]`）；**测试在任何平台都能跑** |

## 1. 仓库名 / 包名合规

包名与仓库名必须一致，且匹配 `^[a-z0-9]+(-[a-z0-9]+)*$`：

```powershell
node -e "const p=require('./package.json');console.log(p.name)"
```

期望：`dsh-cua-driver-indicator`（与 GitHub 仓库名 `dsh-cua-driver-indicator` 一致）。

## 2. `package.json` 必填项

```powershell
node -e "const p=require('./package.json');console.log(JSON.stringify({version:p.version,license:p.license,os:p.os,private:p.private??false,patch:p.dsh?.bundle?.patch,files:p.files},null,2))"
```

逐项核对：

| 项 | 期望 |
| --- | --- |
| `dsh.bundle.patch` | `./cordis.patch.yml`，**非空且文件真实存在**（`node -e "require('fs').accessSync('cordis.patch.yml')"`） |
| `license` | `MIT`，且仓库根目录有 `LICENSE` 文件 |
| `os` | `["win32"]` |
| `private` | **未设置**（设了 npm 会拒绝发布） |
| `version` | 语义化版本，且**与 `README.md` 顶部第一个版本标题一致**（这一条由测试断言，见第 4 节） |
| `files` | 显式列出要发出去的内容：`lib/`、`client.js`、`scripts/`、`docs/`、`cordis.patch.yml`、`README.md`、`THIRD_PARTY.md`、`LICENSE`、`LICENSE-THIRD-PARTY`。**`provider-bundle/` 不在里面**（它独立发布） |
| `dsh.client` | `platform: web`，`exports` 里有 `"./client": "./client.js"` |
| 依赖 | **不得**依赖 `@deepseek-ai/dsh-computer-use` 或 `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native`（那两行属于 provider bundle） |

## 2b. 官方电脑控制插件这条依赖

本插件给 **DSH 官方的电脑控制通道**（`cua_driver_native__*`）画接管提示条，所以那条通道
是它的前置依赖。发版前逐条核对：

| 项 | 期望 |
| --- | --- |
| 平台 | **Windows only**。macOS / Linux / WSL 托管实例**不支持**，本仓库也**不在那些平台上实测**（`docs/self-check.md` 与两份 README 都写明这一点） |
| 安装包 | 独立发布的 `dsh-cua-driver-indicator-provider`（源码在 `provider-bundle/`）。**不随本插件发布** |
| 引用方式 | 只按「**包名 + 版本范围**」引用（默认 `dsh-cua-driver-indicator-provider@>=1`），范围在配置里 |
| 版本号 | **源码里不得出现任何官方包的精确版本号**（`@deepseek-ai/dsh-computer-use@x.y.z` 这类字面量）；provider bundle 对两个官方包的依赖写**发布通道** |
| 卸载 | **卸载本插件不会移除已装的官方两行** —— 那两行属于 provider bundle |
| 五态 | `available` / `missing` / `installed-disabled` / `installed-inactive` / `unknown` 五种文案与按钮都不同；`installed-inactive` 要展示「已装官方包版本」与「宿主版本」两个真实读数（读不到写 `unknown`） |
| 重启 | 只有**检测到 dsh-autorestart** 且**用户点了按钮**才调 `/__dsh_autorestart/park`；失败如实报 `autorestart-call-failed` |

## 3. README 必含安装命令

```powershell
Select-String -Path README.md -Pattern "dsh plugin --profile <profile> add dsh-cua-driver-indicator"
```

期望：命中。英文版 [README.en.md](../README.en.md) 里也应有同一条命令。

## 4. 语法与测试

```powershell
node --check lib/index.js
node --check lib/goal.mjs
node --check lib/series.mjs
node --check lib/provider.mjs
node --test tests/goal.test.mjs
node --test tests/series.test.mjs
node --test tests/provider.test.mjs
```

期望：七条命令全部 `exit 0`，三套用例**全绿**（一条都不能红）。
不需要 `npm install`：插件没有运行时依赖，测试只 import 纯逻辑模块。

## 5. 打包产物

```powershell
node scripts/check-package.mjs
npm pack --dry-run --json
```

期望：

- 脚本 `exit 0`，并打印产物清单与总体积；
- 产物里**没有** `node_modules/`、**没有** `*.tgz`、**没有** `*.bak-*`；
- 产物里**没有** `provider-bundle/`（它独立发布，见第 2b 节）；
- 本插件的 `package.json` **不依赖**任何官方电脑控制包；
- 源码里**没有**官方包的精确版本号；
- 产物里**必须有** `lib/goal.mjs`、`lib/index.js`、`lib/provider.mjs`、`lib/series.mjs`、
  `client.js`、`cordis.patch.yml`、`LICENSE`、`README.md`。

确认无误后再 `npm pack` 真正打包。

## 6. 提交数门槛

收录方会卡仓库的提交数与仓库年龄：

```powershell
git rev-list --count HEAD
```

期望：**>= 10**（本仓库当前 **10**）。仓库还需要**创建满 1 天** —— 这一条只能自己核对。

## 7. 描述真实性自查

目录方会**逐字核对**描述与代码是否对得上，对不上直接打回。逐句确认 `package.json` 的
`description` 与 README 里的说法：

| 描述里的说法 | 代码里的对应物 |
| --- | --- |
| screen-edge banner | 画面层的顶部横幅（`scripts/windows-takeover.*`） |
| pointer halo | 指针光环（`cursorIndicatorEnabled`） |
| session | 横幅第二段：宿主 `sessionTitle` 服务读到的会话标题 |
| goal | 横幅第四段：`computer_control_goal` 工具 + 用户指令摘要 |
| Esc | 物理 Esc 中断在途调用并封禁本回合剩余调用（`allowInjectedStop`） |
| Windows only | `"os": ["win32"]`，画面层是 WinForms |

## 8. 平台限制的表述

描述里凡是提"能用"的地方，都要和真实限制对得上：

- 画面层是 **Windows only**；
- **浏览器打开的 web 界面指向 Windows 宿主时可用**（`dsh web` 在 Windows 上跑）；
- **WSL 里的实例控制不到 Windows 桌面，也画不出横幅**（它的宿主是 Linux）。
- **官方电脑控制通道那条依赖同样是 Windows only**：官方通道的原生实现是 Windows 上的
  Cua Driver。**macOS / Linux / WSL 托管实例不支持这条依赖，本仓库也不在那些平台上实测**
  （第 2b 节）。在非 Windows 平台上，插件照常加载，只在日志里留一条 Windows-only 的说明。

## 9. 干净环境安装实测

```powershell
npm view dsh-cua-driver-indicator versions --prefer-online
```

在一个全新目录里装：

```powershell
npm install dsh-cua-driver-indicator@<version> --prefer-online
```

核对安装产物：版本号对、`os` 是 `win32`、`LICENSE` 在、`cordis.patch.yml` 在、`scripts/`
两个文件在、`node --check lib/index.js` → `exit 0`。

> 注：测试文件**不进 npm 包**（`files` 不含 `tests/`），测试在仓库里。
> 发布后本机 npm 可能因元数据缓存报 `ETARGET`，加 `--prefer-online` 即可恢复。

## 10. 装进 profile 实机验收

```powershell
dsh plugin --profile <profile> add dsh-cua-driver-indicator@<version>
```

**重启 DSH**（插件与配置在启动时加载），然后逐条确认：

- [ ] 横幅出现，四段文字分别是：首段、会话身份、正在做什么、目标；
- [ ] 会话没有声明目标时，第一次桌面调用被**退回一次**，模型调用 `computer_control_goal`
      声明后重试同一个调用就放行；
- [ ] 同一轮里不声明就重试**不会被卡死**（放行 + 日志一条 warn）；
- [ ] 按**物理 Esc** 能停住本回合的在途调用，并挡下本回合后续调用；
- [ ] 非 Windows 平台只留一条日志（`takeover indicator is Windows-only; disabled on linux`），
      不报错、不崩溃。
- [ ] **官方电脑控制通道那条依赖**（第 2b 节）：网页打开时
      - 官方通道**在** → **什么弹窗都不出现**；
      - 官方通道**不在** → 居中弹窗出现，标题是「本插件需要官方的「电脑控制」插件才能工作」，
        有「安装官方电脑控制插件」与「暂不安装」两个按钮，并写明「它不在，本插件就完全用不了」；
      - 点「安装官方电脑控制插件」→ 真的装了（看 profile 里多出来的 provider bundle 与两行官方插件），
        弹窗转成「需要重启」；**装完必须重读宿主清单确认那两行存在且启用**；
      - 点「暂不安装」→ 左下角留一行「已跳过。本插件当前不可用，下次启动会再提醒一次。」；
      - 重启之后官方工具（`cua_driver_native__*`）**真的出现**，横幅随之工作；
      - 装了但工具没出现 → 弹窗写「已安装但没生效」，并给出「已装官方包版本」与
        「宿主版本」两个真实读数。

## 11. 发布

```powershell
npm publish
```

> **发布是不可逆的对外动作**：发之前必须拿到确认。
> 发完核对 `npm view dsh-cua-driver-indicator versions --prefer-online` 里出现了新版本，
> 并把这一版写进 `CHANGELOG.md`、打 `v<version>` tag。
