# dsh-cua-driver-indicator-provider

**这个包是独立发布的**，不是 `dsh-cua-driver-indicator` 的一部分。

`dsh-cua-driver-indicator` 只画接管提示条；它画的那条通道是 **DSH 官方的电脑控制通道**
（工具名 `cua_driver_native__*`）。官方通道在默认的 composition 里**不存在**，所以本插件
在启动时会检查它，缺了就问你要不要装。

要装的东西就是这个包：一个 **provider bundle**，它只做两件事——

| 行 id | 由哪个官方包提供 |
| --- | --- |
| `computer-use-registry` | `@deepseek-ai/dsh-computer-use` |
| `computer-use-cua-driver-native` | `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native` |

装上之后这两行进你的 profile，官方工具就注册进来了，接管提示条才有东西可画。

## 为什么不跟 `dsh-cua-driver-indicator` 一起发

- **更新节奏不同**：官方包跟着宿主走，本插件跟着自己的功能走。合成一个包，官方包一升级
  就得把本插件也发一版。
- **版本不能写死**：本插件只按「包名 + 版本范围」引用本包（默认 `>=1`），所以本包发新版时，
  本插件不用动，也不用重新发。
- **它不进本插件的 npm 包**：`dsh-cua-driver-indicator` 的 `package.json` 的 `files` 里
  **没有** `provider-bundle/`，`scripts/check-package.mjs` 会断言这一点。源码放在同一个仓库里
  只是为了让人看得见、审得动。

## 依赖为什么不写死版本号

```json
"dependencies": {
  "@deepseek-ai/dsh-computer-use": "next",
  "@deepseek-ai/dsh-experimental-computer-use-cua-driver-native": "next"
}
```

两个官方包的发布通道是 **dist-tag**：`next` 指向的就是**当前宿主那一版**（宿主是
`0.2.2-rc.1` 时，`next` 就是 `0.2.2-rc.1`）。

为什么不用普通的 semver 范围：官方包发布的是**预发布版**（带 `-rc` / `-alpha`），而 npm 的
semver 规则里，一个预发布版本只能满足**带同样 major.minor.patch 的预发布比较符**的范围。
也就是说 `>=0.1`、`>=0.2.0` 这类范围**装不上** `0.2.2-rc.1`；唯一能一直跟着宿主走的写法，
就是指向同一个发布通道的 dist-tag。

因此：**本仓库的代码里不出现任何官方包的精确版本号**，本包里的依赖也只写通道名。
通道变了（宿主换发布线）时，改的是本包自己的 `package.json`，改完发一版本包即可。

## 怎么装

由 `dsh-cua-driver-indicator` 在弹窗里点「安装」自动装（Windows only），或者手动：

```powershell
dsh plugin --profile <profile> add dsh-cua-driver-indicator-provider
```

装完**重启 DSH** 才会生效：插件行与配置是在启动时加载的。

## 为什么两行 insert 必须带 `disabled: false`

```yaml
- insert:
    - id: computer-use-registry
      name: '@deepseek-ai/dsh-computer-use'
      disabled: false
```

**漏了它会怎样**：宿主把没有写 `disabled` 的 insert 行**按停用状态插进去**。于是安装是成功的、
两行官方插件确实在机器上，但官方工具（`cua_driver_native__*`）永远不注册 —— 用户点完「安装」
发现还是不能用，而 `dsh-cua-driver-indicator` 那边只能如实报告「装了但没启用」
（installed-disabled），面板给的是「去设置页启用」，用户得自己再去设置里翻。

**为什么开关必须写在 insert 项自身**：这两行是**官方的 opt-in 行**（opt-in = 默认不启用），
`disabled` 就是那个 opt-in 开关。宿主方言里，`insert` 插进去的行只能靠**它自己身上的**
`disabled` 字段来定状态；在同一个文件里另起一段 `- id: computer-use-registry` 去"覆盖"
insert 出来的行**不生效** —— 匹配不到任何行的非 insert patch 会被跳过，
`plugin_manager` 的 `set_plugin` 也会回 `overridden`。所以开关没有别的位置可写，
只能写在 insert 项里。

**这一条有断言守着**：`dsh-cua-driver-indicator` 的 `scripts/check-package.mjs` 会读这个
yml，逐行检查每个 insert 行有没有显式写 `disabled: false`，缺了就 exit 1 并打印
「insert 行「<id>」缺少 disabled: false」。所以这个坑不会再无声地溜过去。

（这台机器上真正跑通的 profile patch —— `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`
第 190-196 行 —— 两行也都带着 `disabled: false`，是同一个写法。）

## 平台

**Windows only**（`"os": ["win32"]`）。官方通道的原生实现是 Windows 上的 Cua Driver，
macOS / Linux / WSL 托管实例都不支持，本包也不在那些平台上测。

## 许可证

MIT。
