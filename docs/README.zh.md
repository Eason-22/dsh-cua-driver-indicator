# dsh-cua-driver-indicator · 维护者说明（中文）

> 这份文档给**维护者与排障的人**看。用户向的完整说明在仓库根目录的
> [README.md](../README.md)（**英文**，默认正文）与 [README.zh.md](../README.zh.md)（**中文**）；
> [README.en.md](../README.en.md) 现在只是一页「正文已迁到 README.md」的说明页；
> 发版自检清单在 [self-check.md](self-check.md)；版本历史在 [CHANGELOG.md](../CHANGELOG.md)。

- **当前版本**：**0.8.0**（与 `package.json` 的 `version` 一致）

## 桌面精度工具（0.8.0 新增）

宿主自带的官方通道（`cua_driver_native__*`）负责「把鼠标搬到某点」；0.8.0 给它补了四件
更准的工具，解决「点歪」「点不到小目标」「同名按钮分不清」：

- **`cua_snap_click`**：点之前查落点有没有被别的窗口挡住（挡住就返回 `POINT_COVERED`，不点）；
  点完按三档判定界面变化（`changed` / `changed_elsewhere` / `unchanged`），没变化时按偏移重试一次
  （只有 `expect_change=idempotent` 才会重试，非幂等目标绝不点第二次）。
- **`cua_snap_click_named`**：按控件的可访问名字找它并点击。名字比对时会去掉表情、符号和括号里的内容
  （所以「下载花名册」能命中「📥 下载花名册（全部人员）」）；同名命中多个时**不猜**，返回
  `AMBIGUOUS_TARGET` 与候选清单；同名控件都在屏幕外时返回 `NOT_VISIBLE`，需要先滚动到它。
- **`cua_snap_sequence`**：最多 5 步连点，每一步都按名字找、都做三档判定；任何一步失败立刻停住，
  后面的步骤不会执行，结果里说明停在第几步。
- **`cua_snap_wait_for`**：等某个名字的控件出现在屏幕上（`timeout_ms`，默认 5000 毫秒），
  控件出现就算成功，等到超时如实报 `WAIT_TIMEOUT`。

另外，读一次界面时每个候选都带一个唯一的 `elementId`，可以按 ID 精确操作（同名控件因此分得清）；
ID 只活到下一次重读界面，旧 ID 会得到 `ELEMENT_ID_EXPIRED`，不会静默改成按名字猜。控件支持 InvokePattern 时
会在后台运行（`manner: invoke`，鼠标不动），否则按坐标点（`manner: point`）。

**限制**：这四件工具只在 Windows 上可用（原生那一半是 WinForms + UIA）；像飞书这种自己画界面的
Chromium 应用不支持后台 InvokePattern，那里只能坐标点击。


## 插件与宿主之间：官方通道的状态路由

本插件的浏览器那一半要问宿主「官方电脑控制通道在不在」，走的是插件自己注册的一条路由。

### 路由路径：`/api/__dsh_cua_indicator/provider`

- 宿主**只把 `/api/` 下的路径交给插件**，其余路径不在放行区里。
- 浏览器那一半用**相对路径** `api/__dsh_cua_indicator/provider`（**不带前导斜杠**）：桌面版的页面跑在
  `dsh-app://app/` 下，带前导斜杠会解析成 `dsh-app://__dsh_cua_indicator/provider`，同样落在放行区外。
- 两边必须一致：宿主路径去掉前导斜杠 **==** 客户端路径。`tests/provider.test.mjs` 里有一条
  「the host route and the client route are the same path」把这件事钉死，防止两边再漂。

### 注册时机：等 webServer 就绪后再注册

插件走 `ctx.inject(['webServer'], …)`：**webServer 什么时候就绪，路由就什么时候挂上**。

插件挂载那一刻 webServer 常常还没起来。早期版本在 `apply` 里**同步**取服务、取不到就放弃 ——
路由**从未注册**过，面板去取状态只会拿到 401，于是按「状态不明」处理，什么都不画。
一直没就绪（无头模式）也只是**不挂这条路由**，插件的其它能力照常工作。

### 真机读数（2026-11-05，desktop profile）

- `GET /api/__dsh_cua_indicator/provider` → **200**，body 里 `status: "installed-disabled"`；
  屏幕弹出「官方电脑控制插件装了，但没有启用」卡片。
- 对照读数：`/api/definitely-not-a-route-xyz` 同样返回 **401** —— **401 不代表路由存在**，
  只看 401 会误判成「路由没注册」。

## 排障时先看这两处痕迹

宿主侧（插件日志）：

- `the official-channel route is registered (/api/__dsh_cua_indicator/provider)` —— 路由挂上了。
- `the official-channel route could not be scheduled` / `… was refused` /
  `no web server on this host` / `the host context has no inject` —— 没挂上。

浏览器侧（开发者工具控制台）：

- `[dsh-cua-driver-indicator] reading the provider state failed (route: api/__dsh_cua_indicator/provider): …`
  —— 取状态失败；后面跟的是 HTTP 状态码或错误信息。

## 版本号在哪些地方

- `package.json` 的 `version`：**0.7.0**（唯一事实来源）。
- 本文件顶部的「当前版本」：**0.7.0**。
- 根目录 [README.md](../README.md) 的第一条版本说明块（`**0.7.0：…**`）：**0.7.0**。
- 主入口 `lib/index.js`：**没有**版本常量 —— 插件自己从不读自己的版本，所以不存在第二处会漂的数字。
