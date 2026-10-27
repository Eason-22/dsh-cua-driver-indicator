# dsh-cua-driver-indicator

**English readme.** The Chinese one is [README.md](README.md).

Adds the "you can see it, and you can stop it" layer on top of **DSH's official built-in
Cua Driver channel** (`cua_driver_native__*`).

The official channel draws no banner of its own (it only has a pointer overlay that is off by
default), so you cannot tell when the desktop control starts or stops. This plugin supplies
exactly that layer and **nothing else**: it never clicks, never selects a window, and registers
no tool that can act.

---

## What it does

1. **A banner.** The first time the official channel really operates the desktop, a
   non-activating, click-through strip appears at the top (or bottom) of the screen, and a
   halo plus the DSH badge appears next to the pointer.
2. **A four-segment banner.** The strip reads
   `DSH 正在控制电脑 · 会话《<session title>》· <what it is doing> · 目标：<goal>`
   (see [Reading the banner](#reading-the-banner)).
3. **It goes away again.** When the turn ends, or 30 seconds after the last desktop call, the
   strip fades out.
4. **Esc really stops.** A physical Esc aborts the desktop call that is in flight and blocks
   the remaining desktop calls of that turn (the next turn works normally).
5. **Say the goal before touching the screen.** A session that has not declared a goal is sent
   back once, with an error the model can act on (see
   [The goal gate](#the-goal-gate)).

### Reading the banner

| Segment | What it means |
| --- | --- |
| **1. Head** — `DSH 正在控制电脑` | DSH is controlling your computer. The text is configurable (`indicatorText`). |
| **2. Session** — `会话《<title>》` | *Who* is driving the desktop. The title comes from the host's session-title service and is cut at 30 characters. When the host has no title, or the title is machine text (for example an AgentTeams dispatch notice), the banner names the session kind instead: `主会话` (main session), `子代理` (subagent) or `子代理任务` (subagent task). |
| **3. Action** — `正在点击` | *What* is happening right now. It is derived from the official tool that is currently running, so it is a fact, not a guess: `正在看屏幕` (reading the screen), `正在点击` (clicking), `正在输入` (typing), `正在按键` (pressing keys), `正在滚动` (scrolling), `正在拖拽` (dragging), `正在启动程序` (launching an app), `正在查看窗口` (inspecting a window), … A tool nobody mapped falls back to `正在操作桌面` (operating the desktop). **This segment is always there** — the banner never shows an English tool name and never leaves it empty. |
| **4. Goal** — `目标：<goal>` | *Why*. Two sources: an automatic summary of your latest human instruction (the baseline), and the model's own report through the `computer_control_goal` tool, which wins for the session it was reported in and survives across turns until you change the goal or give a new instruction. **The whole segment disappears when there is no goal** — you never get a dangling `目标：`. Machine text (injected context, a dispatch notice, …) and questions or complaints are never used as a goal. |

The default banner text is Chinese; `indicatorText` and `goalTemplate` let you replace both
segments (see [Configuration](#configuration)).

### The goal gate

Before the desktop is touched at all, the model has to say what it is about to do. The tool
name is **`computer_control_goal`**:

```jsonc
{ "goal": "click the Save button" }   // shown in the banner, at most `goalMaxChars` characters
```

The gate has three core semantics:

| Situation | Result |
| --- | --- |
| The model declared a goal | The call goes through. |
| No declared goal, **first** desktop call of the turn | The call is sent back **once**, with an error the model can act on: declare the goal with `computer_control_goal`, then retry the very same call. |
| No declared goal, the turn was **already** sent back | The call goes through — the gate never locks a session out of the desktop. |

On top of that:

- The block happens **before** the desktop lease is taken, so a blocked call touches nothing
  and leaves the desktop free for every other session.
- The counter is **reset per turn** (`turn/end` clears it), so the next turn starts over.
- The automatic summary of your instruction is **not** a declared goal: only what the model
  reports on purpose opens the gate.
- If the host names no turn for a call, the gate **fails open** (the call is let through and a
  warning is logged): a gate that locks the desktop out is worse than no gate.

### Esc really stops

A physical Esc aborts the desktop call that is currently in flight (each call carries a
combined `AbortSignal` and the native provider honours it) and blocks the rest of that turn,
because aborting only the current call would let the agent deliver the next one.

Limits you have to know:

- Esc can only interrupt a call that is **still in flight** and stop the **following** calls.
  Input that was already handed to an application cannot be recalled — a click that landed and
  characters that were typed are physically gone.
- Only the **physical** key counts. A simulated key press (for example the agent's own
  `press_key`) is not treated as a stop request, otherwise the agent could stop itself with a
  single key press.

## Install

The plugin is Windows-only (the picture layer is a WinForms overlay). Install it into DSH:

```powershell
dsh plugin --profile <profile> add dsh-cua-driver-indicator
```

Replace `<profile>` with the profile you actually use (for example `default`). **Restart DSH**
afterwards — plugins and their configuration are loaded at startup.

On a non-Windows platform the picture layer does not start: the plugin still loads and leaves
one line in the log,

```
cua-driver-indicator: takeover indicator is Windows-only; disabled on linux
```

Everything else steps aside: no error, no crash.

## Platform limits

- **Windows only.** The package declares `"os": ["win32"]`, so pnpm refuses to install it on
  Linux (EBADPLATFORM) instead of installing something that would never do anything.
- **The banner is drawn on the machine that runs DSH.** It is painted by a host-side Windows
  process (`powershell.exe` + WinForms), so it appears on that machine's screen. It is not an
  element of any web page.
- **The web UI works the same.** A browser pointing at a Windows host (`dsh web` on Windows)
  talks to that very host, so the banner behaves exactly as in the desktop app.
- **A DSH instance inside WSL cannot do either half of this.** Its host is Linux: the official
  channel there drives the WSLg virtual display (Linux GUI programs inside WSL) and cannot
  reach real Windows windows, and the banner would have to be painted by a Windows-side
  process. A WSL instance therefore controls neither your Windows desktop nor draws a banner.

## Configuration

Change it in the profile's `cordis.patch.yml` and restart DSH:

```yaml
- id: cua-driver-indicator
  config:
    indicatorEnabled: true            # screen edges and banner
    cursorIndicatorEnabled: true      # pointer halo
    remoteIndicatorVisible: true      # visible in remote sessions and recordings
    indicatorText: 'DSH 正在控制电脑'  # banner head text
    goalTemplate: '目标：{goal}'       # goal segment template, {goal} is replaced
    goalMaxChars: 24                  # max length of the goal summary
    indicatorPosition: top            # top / bottom
    indicatorIdleMs: 1200             # fade-out delay (200–3000 ms)
    idleMs: 30000                     # idle time that ends control (ms)
    stopOnEscape: true                # physical Esc stops
```

## Self-check: you should notice if the official tool names change

The only coupling between this plugin and the official channel is the tool-name prefix
`cua_driver_native__`. If the official channel ever renames its tools, the banner would
**disappear without a word** — no error, just a plugin that looks broken.

So the plugin runs a self-check every 60 seconds: it remembers when it last saw an official
tool call, and when it has never seen one, or when more than 10 minutes have passed since the
last one, it writes one log line (at most one every 30 minutes):

```
cua-driver-indicator: no official CUA tool call seen for 12 minutes — if the takeover
banner does not appear, the official tool names may have changed (currently matching:
cua_driver_native__*)
```

If you see that line, check whether the official tool names changed and update
`OFFICIAL_TOOL_PREFIX` in `lib/index.js` and `NATIVE_TOOL` in `lib/series.mjs`. The self-check
only reads two timestamps and writes one line: it cannot affect the banner, the Esc stop or
the desktop lease.

## Layout

| File | Responsibility |
| --- | --- |
| `lib/index.js` | Listens to `tools/execute`, keeps the banner in sync, assembles it (session + action + goal), runs the **goal gate**, reads the session title from the host, drives the Windows picture layer, wires Esc to the stop logic, registers the `computer_control_goal` tool, and runs the official-tool-name self-check. |
| `lib/goal.mjs` | Pure logic: goal summaries, human-vs-machine text, questions and complaints, the action-word table, banner assembly, session identity fallback, per-session goal state, **the gate decision and its wiring**, and message-source detection. Import-free, so plain node can test it. |
| `lib/series.mjs` | Pure state machine: the takeover lease, in-flight call registration, the Esc stop and its scope. Import-free, so plain node can test it. |
| `scripts/windows-takeover.*` | The Windows picture layer (copied from upstream, see `THIRD_PARTY.md`). |
| `tests/goal.test.mjs` | `node --test` unit tests (goal summaries, human-vs-machine text, action words, banner assembly, source filtering, the goal gate and its wiring). |
| `tests/series.test.mjs` | `node --test` unit tests (lease and stop semantics). |
| `scripts/check-package.mjs` | Checks what `npm pack` would ship (no `node_modules/`, no `*.tgz`, no `*.bak-*`, and the required files are in). |
| `docs/self-check.md` | The pre-release checklist. |

## Tests

There is **no `npm install` step**: the plugin has no runtime dependencies and the tests import
the pure logic modules only.

```powershell
node --check lib/index.js
node --check lib/goal.mjs
node --check lib/series.mjs
node --test tests/goal.test.mjs
node --test tests/series.test.mjs
```

CI (`.github/workflows/tests.yml`) runs the two test files on Node 20 and on Node 22 for every
push and pull request.

Contributions, the change rules and the release flow are in
[CONTRIBUTING.md](CONTRIBUTING.md); the version history is in [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE). The picture layer comes from upstream: see `THIRD_PARTY.md` and
`LICENSE-THIRD-PARTY`.
