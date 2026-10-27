/**
 * Takeover indicator for DSH's official built-in Cua Driver channel.
 *
 * The built-in provider (`cua_driver_native__*`) draws no banner of its own, so
 * while it operates the desktop the host gives no visible signal that control is
 * happening or finished. This plugin supplies exactly that layer and nothing
 * else: it sends no input and never picks a window.
 *
 * The banner text reads: `DSH 正在控制电脑 · 会话《<会话标题>》· <动作> · 目标：<目标>`.
 * The session part names who is driving the desktop, so several open sessions
 * stay apart; the action part names what the running official tool is doing,
 * which the host knows for sure; the goal part names what the session is for.
 * The goal comes from two sources: an automatic summary of the user's latest
 * instruction, and the model's own report through the `computer_control_goal`
 * tool, which wins for the session it was reported in and stays until that
 * session ends or a new instruction arrives.
 *
 * It also turns a physical Escape into a real stop. The stop aborts every
 * desktop call already in flight (each call carries a combined AbortSignal, and
 * the native provider honours it) and blocks the rest of that turn, because
 * aborting only the current call would let the agent deliver the next one.
 * Input already handed to an application cannot be recalled — that limit is
 * physical, and the model is told so.
 *
 * Before the desktop is touched at all, the model has to say what it is
 * about to do: a session without a declared goal is sent back once with an
 * error it can act on, and the retry inside the same turn is let through. The
 * gate is soft on purpose — it teaches the model to announce itself without
 * ever locking a session out of the desktop.
 *
 * The only thing this plugin couples to the official channel is the tool-name
 * prefix. If the official channel ever renames its tools, the banner would
 * disappear without a word, so a self-check timer turns that silence into a
 * log line instead.
 */

import Schema from '@deepseek-ai/schemastery';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ControlSeries, desktopToolName } from './series.mjs';
import {
  GoalStore,
  DEFAULT_ACTION_WORD,
  actionWordFor,
  summarizeGoal,
  summarizeHumanGoal,
  composeBannerText,
  sessionLabel,
  extractUserText,
  isHumanInstruction,
  backfillGoalFrom,
  shouldBackfillGoal,
  shouldRescanHistory,
  GATE_BLOCK,
  runGoalGate,
  execTurn,
  gateStateKey,
  goalStoreKey,
} from './goal.mjs';

const helperScript = fileURLToPath(new URL('../scripts/windows-takeover.ps1', import.meta.url));

// Desktop calls that can send keystrokes. While one of them is running, an Escape
// seen by the overlay may be our own injection rather than the user's, so a stop
// inside this window is ignored.
const KEY_PRESS_TOOLS = new Set(['press_key', 'hotkey']);
const SELF_KEY_WINDOW_MS = 900;

// The tool-name prefix of the official built-in Cua Driver channel.
// `desktopToolName()` in lib/series.mjs recognises the same prefix to decide
// which calls operate the desktop. That prefix is the only coupling between
// this plugin and the official channel, so the self-check below watches it: a
// rename upstream has to show up in the log instead of silently removing the
// banner.
const OFFICIAL_TOOL_PREFIX = 'cua_driver_native__';

// The gate in front of the desktop: the model has to say what it is about to
// do before it touches the screen, because that sentence is what the user
// reads while the desktop is being controlled.
//
// The message is written for the model, so it can act on it: declare the
// goal, then retry the very same call. `{limit}` is the configured goal length.
const GOAL_REQUIRED_MESSAGE = '先调用 computer_control_goal 声明本轮目标（不超过 {limit} 字，说清要做什么），用户屏幕上会显示它；声明之后重试这个桌面操作。';

// Self-check cadence: look once a minute, complain after 10 quiet minutes,
// and never write more than one line every 30 minutes.
const SELF_CHECK_INTERVAL_MS = 60 * 1000;
const SELF_CHECK_STALE_MS = 10 * 60 * 1000;
const SELF_CHECK_REPEAT_MS = 30 * 60 * 1000;

/** Call shapes re-exported for tests and callers that only need the predicate. */
export { desktopToolName };

export const name = 'cua-driver-indicator';
export const inject = ['tools'];
export const Config = Schema.object({
  indicatorEnabled: Schema.boolean().default(true).description('显示屏幕边缘与提示条 / Screen edges and banner'),
  cursorIndicatorEnabled: Schema.boolean().default(true).description('突出显示鼠标（指针光环） / Pointer halo'),
  remoteIndicatorVisible: Schema.boolean().default(true).description('远程与录屏可见 / Visible in remote sessions and recordings'),
  indicatorText: Schema.string().default('DSH 正在控制电脑').description('横幅首段文字 / Banner head text'),
  goalTemplate: Schema.string().default('目标：{goal}').description('目标段模板，{goal} 会被替换成当前目标 / Goal segment template'),
  goalMaxChars: Schema.number().default(24).description('目标摘要最大字数 / Goal summary max chars'),
  indicatorPosition: Schema.union([Schema.const('top'), Schema.const('bottom')]).default('top').description('提示位置 / Banner position'),
  indicatorIdleMs: Schema.number().default(1200).description('结束后隐藏延时（毫秒，200–3000） / Hide delay'),
  idleMs: Schema.number().default(30000).description('空闲多久视为控制结束（毫秒） / Idle lease'),
  stopOnEscape: Schema.boolean().default(true).description('Esc 立即停止本回合的桌面操作 / Esc stops the series'),
});

/** Live config values may arrive as Schemastery references. */
const read = (value) => (value && typeof value.get === 'function' ? value.get() : value);

/** A goal summary needs room to say something; below four characters it is noise. */
const goalLimit = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 24;
  return Math.max(4, Math.floor(parsed));
};

export function apply(ctx, config = {}) {
  // The picture layer is a Windows WinForms overlay, so the whole indicator
  // only exists there. Everywhere else the plugin stays inert: one log line
  // says why, and nothing is started. A missing overlay must never stop the
  // plugin from loading.
  if (process.platform !== 'win32') {
    ctx.logger?.info?.(`cua-driver-indicator: takeover indicator is Windows-only; disabled on ${process.platform}`);
    return;
  }
  const settings = {
    indicatorEnabled: read(config.indicatorEnabled) !== false,
    cursorIndicatorEnabled: read(config.cursorIndicatorEnabled) !== false,
    remoteIndicatorVisible: read(config.remoteIndicatorVisible) !== false,
    indicatorText: String(read(config.indicatorText) ?? 'DSH 正在控制电脑'),
    goalTemplate: String(read(config.goalTemplate) ?? '目标：{goal}'),
    goalMaxChars: goalLimit(read(config.goalMaxChars) ?? 24),
    indicatorPosition: read(config.indicatorPosition) === 'bottom' ? 'bottom' : 'top',
    indicatorIdleMs: Math.max(200, Math.min(3000, Number(read(config.indicatorIdleMs) ?? 1200))),
    idleMs: Math.max(5000, Number(read(config.idleMs) ?? 30000)),
    stopOnEscape: read(config.stopOnEscape) !== false,
  };

  const series = new ControlSeries({ idleMs: settings.idleMs });
  const goals = new GoalStore();
  /**
   * Sessions whose own event history was scanned, with the history length
   * seen at that moment. A scan that threw leaves no entry, so it is retried;
   * a scan that succeeded is not repeated while the history stays the same.
   * @type {Map<string, number|null>}
   */
  const scanned = new Map();
  const cancelEvent = `Local\\DSH-CDI-${randomUUID()}`;
  let child = null;
  let starting = null;
  let buffer = '';
  let bufferDiagnostics = '';
  const waiters = new Map();
  let nextId = 0;
  let shown = false;
  let helperPaused = false;
  let selfKeyInjectionUntil = 0;
  let closed = false;
  /** Banner text handed to the overlay last time, used to detect a new goal. */
  let lastSentText = '';
  /** Timestamp of the last official CUA tool call; 0 when none was ever seen. */
  let lastOfficialCallAt = 0;
  /** Timestamp of the last self-check log line; 0 when none was written yet. */
  let lastSelfCheckAt = 0;
  /**
   * The host session that holds the desktop lease. The banner names it, so
   * several open sessions stay apart. The lease is exclusive, so one slot is
   * enough: a second conversation is refused while the first one holds it.
   */
  let leaseSession = null;
  /**
   * What the running official tool is doing, as a Chinese action word.
   *
   * The host knows which tool it is calling, so this is a fact and not a
   * guess. It is the one segment of the banner that is always there: the
   * banner stays readable even when there is no goal to show.
   */
  let currentAction = DEFAULT_ACTION_WORD;
  /**
   * The gate state of every session: the turns that were already sent back.
   *
   * The rules and the wiring of the gate live in lib/goal.mjs, so the tests
   * can pin them without a host and this file cannot keep a second copy of
   * them.
   * @type {Map<string, {sessionId: string, blockedTurns: string[]}>}
   */
  const gateStates = new Map();

  const warn = (error) => ctx.logger?.warn?.(`cua-driver-indicator: ${error?.message ?? error}`);
  const info = (message) => ctx.logger?.info?.(`cua-driver-indicator: ${message}`);

  /** The session that currently holds the desktop lease, if any. */
  function leaseSessionId() {
    return series.current?.sessionId ?? 'global';
  }

  /**
   * The real title of a session, read from the host's session-title service.
   *
   * The service is optional: a host without one falls back to the label of
   * the session kind. It is read once per banner and never cached, because a
   * session may be renamed while it drives the desktop.
   *
   * @param {unknown} session the host session
   * @returns {string|null} null when the host has no title for it
   */
  function sessionTitleOf(session) {
    if (!session) return null;
    let service;
    try {
      service = ctx.get('sessionTitle');
    } catch {
      return null;
    }
    if (!service || typeof service.get !== 'function') return null;
    try {
      const snapshot = service.get(session);
      const title = snapshot?.title;
      return typeof title === 'string' ? title : null;
    } catch {
      // A title is a nicety: a host that cannot answer must not break the
      // banner, so the session kind names it instead.
      return null;
    }
  }

  /**
   * Forget the gate counter of a session: the next turn counts again.
   *
   * The key is the one the gate itself writes the state under
   * (`gateStateKey`), so the two can never drift apart: a state that is
   * written under one key and forgotten under another would survive the turn
   * it belongs to.
   *
   * @param {unknown} sessionId
   * @param {unknown} agentId
   */
  function clearGate(sessionId, agentId) {
    gateStates.delete(gateStateKey(sessionId, agentId));
  }

  /**
   * The error the model gets when it touches the desktop without a goal.
   * @returns {Error}
   */
  function goalRequiredError() {
    const message = GOAL_REQUIRED_MESSAGE.replace('{limit}', () => String(settings.goalMaxChars));
    return new Error(message);
  }

  /**
   * The gate in front of the desktop.
   *
   * A session that has not declared a goal is sent back once, with an error
   * the model can act on: declare the goal, then retry the same call. The
   * retry inside the same turn is let through and logged, so a model that
   * ignores the request is never locked out.
   *
   * The whole gate — reading the declared goal, reading the block record of
   * this turn, deciding, and remembering the turn it sent back — lives in
   * lib/goal.mjs (`runGoalGate`). This file only reads the decision and
   * turns it into an error: it never assembles the facts of the decision
   * and never writes the gate state, so a mistake in the wiring cannot hide
   * in a file no test can reach.
   *
   * @param {unknown} session the host session of the call
   * @param {number|string} turn the running turn
   * @param {string} toolName the bare name of the official tool
   * @param {unknown} exec the tool execution
   * @returns {Error|null} the error to throw, or null to let the call through
   */
  function checkGoalGate(session, turn, toolName, exec) {
    const evaluation = runGoalGate(goals, gateStates, {
      sessionId: session.id,
      agentId: exec?.agent?.id,
      turn,
    });
    if (evaluation.missingTurn) {
      // The host named no turn for this call, so the gate cannot tell a first
      // call from a retry inside the same turn. It let the call through on
      // purpose — a gate that locks the desktop out is worse than no gate.
      warn(`the host named no turn for ${toolName}; the gate let it through`);
    }
    if (evaluation.decision !== GATE_BLOCK) {
      if (!evaluation.declared && evaluation.alreadyBlocked) {
        // The model did not declare a goal and came back anyway. Let it
        // through — blocking again would trap the session — and leave a trace
        // in the log.
        warn(`session ${evaluation.stateKey} called ${toolName} without declaring a goal; the gate let it through`);
      }
      return null;
    }
    return goalRequiredError();
  }

  /**
   * Banner sentence for one session: who is driving the desktop, what is
   * being done right now and for what. The goal segment is dropped when
   * there is no goal.
   */
  function bannerTextFor(sessionId) {
    const label = sessionLabel(leaseSession, sessionTitleOf(leaseSession));
    return composeBannerText(
      settings.indicatorText,
      label,
      goals.forSession(sessionId),
      settings.goalTemplate,
      currentAction,
    );
  }

  /**
   * Say out loud when the official channel has gone quiet.
   *
   * This plugin hooks the official Cua Driver channel through one thing only:
   * the tool-name prefix. If the official channel ever renames its tools, the
   * banner stops appearing and nothing else would notice, so this check turns
   * that silence into a log line.
   *
   * It reads two timestamps and writes one line. It cannot change the banner,
   * the Escape stop, or the desktop lease.
   */
  function selfCheckOfficialChannel(now = Date.now()) {
    const seen = lastOfficialCallAt !== 0;
    // An official call arrived recently: the channel is alive, nothing to say.
    if (seen && now - lastOfficialCallAt < SELF_CHECK_STALE_MS) return;
    // Rate limit: one line every 30 minutes, whatever happens in between.
    if (lastSelfCheckAt !== 0 && now - lastSelfCheckAt < SELF_CHECK_REPEAT_MS) return;
    lastSelfCheckAt = now;
    const quiet = seen
      ? `no official CUA tool call seen for ${Math.floor((now - lastOfficialCallAt) / 60000)} minutes`
      : 'no official CUA tool call seen yet';
    const hint = `if the takeover banner does not appear, the official tool names may have changed (currently matching: ${OFFICIAL_TOOL_PREFIX}*)`;
    // A channel that went quiet after it was seen is worth a warning; a channel
    // that was never used is normal, so it stays an info line.
    if (seen) warn(`${quiet} — ${hint}`);
    else info(`${quiet} — ${hint}`);
  }

  /**
   * How many events a session's own history holds, or null when the host
   * does not say. It is the signal that a history grew, so a settled scan is
   * not repeated while the history stays the same.
   *
   * `ownEvents()` returns the events after the fork-inherited prefix, so its
   * length is the log length minus that prefix. Both counters are plain
   * numbers, which makes this an O(1) check instead of a copy of the log.
   * @param {unknown} session
   * @returns {number|null}
   */
  function sessionLength(session) {
    const seq = session?.seq;
    if (typeof seq !== 'number') return null;
    const inherited = session?.inheritedEventCount;
    if (typeof inherited !== 'number') return seq;
    return Math.max(0, seq - inherited);
  }

  /**
   * Recover a goal for a session that started before this plugin was mounted.
   *
   * The automatic goal is recorded from the `user/message` event, so a
   * session that already existed when DSH started never produced one: its
   * banner showed the plain fallback text. That session's own event history
   * still holds the instruction, so the latest human one becomes the goal.
   *
   * A goal that is already known always wins: the model reported one through
   * `computer_control_goal`, or the instruction arrived as a live event.
   *
   * This runs while the caller holds the desktop lease, so it must never
   * throw: an escaping exception would skip the lease release and leave the
   * desktop locked for every other session. Every failure is caught here.
   */
  function backfillGoal(session) {
    try {
      if (!session) return;
      const sessionId = session.id;
      if (typeof sessionId !== 'string' || sessionId === '') return;
      // A session that already has a goal never needs its history: the model
      // reported one, or a live instruction produced an automatic summary.
      // Returning here keeps the history unopened. The session log grows with
      // every turn, so a scan would otherwise repeat itself on each desktop
      // call and its result would be thrown away.
      if (!shouldBackfillGoal(goals.forSession(sessionId))) return;
      const length = sessionLength(session);
      // A settled scan is not repeated while the history stays the same. A
      // scan that failed left no record, so it is retried.
      if (!shouldRescanHistory(scanned.get(sessionId), length)) return;
      if (typeof session.ownEvents !== 'function') {
        // The host no longer exposes the history reader. That is an expected
        // branch, not a failure, but it must stay visible: the banner then
        // keeps its plain fallback text.
        info(`session history API unavailable, banner goal backfill skipped for ${sessionId}`);
        scanned.set(sessionId, length);
        return;
      }
      const events = session.ownEvents();
      if (!Array.isArray(events)) return;
      // The scan produced a result, so the session is recorded as scanned. A
      // scan that threw or returned something unusable leaves no record, so
      // the next desktop call tries again.
      scanned.set(sessionId, length);
      // The store write happens inside the tested helper: it never replaces
      // a goal the session already has.
      backfillGoalFrom(goals, sessionId, events, settings.goalMaxChars);
    } catch (error) {
      // A failed backfill must never disturb the desktop control.
      warn(error);
    }
  }

  const payload = () => ({
    indicatorEnabled: settings.indicatorEnabled,
    cursorIndicatorEnabled: settings.cursorIndicatorEnabled,
    remoteIndicatorVisible: settings.remoteIndicatorVisible,
    indicatorText: bannerTextFor(leaseSessionId()),
    indicatorPosition: settings.indicatorPosition,
    indicatorIdleMs: settings.indicatorIdleMs,
    // Remote-control software and input remappers mark the user's own keystrokes
    // as injected. Accepting injected stops is the only way a physical Escape is
    // seen there; the plugin compensates around its own key injections instead.
    allowInjectedStop: true,
    stopShortcut: '',
  });

  function start() {
    if (child !== null) return Promise.resolve();
    if (starting !== null) return starting;
    starting = new Promise((resolve, reject) => {
      let ready = false;
      const args = [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
        '-File', helperScript, '-CancelEvent', cancelEvent,
      ];
      const proc = spawn('powershell.exe', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child = proc;
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk) => { bufferDiagnostics = (bufferDiagnostics + chunk).slice(-2000); });
      const deadline = setTimeout(() => {
        if (ready) return;
        reject(new Error(`indicator helper startup timed out${bufferDiagnostics ? `: ${bufferDiagnostics}` : ''}`));
        proc.kill();
      }, 15000);
      proc.stdout.on('data', (chunk) => {
        buffer += chunk;
        for (;;) {
          const at = buffer.indexOf('\n');
          if (at < 0) break;
          const line = buffer.slice(0, at).trim();
          buffer = buffer.slice(at + 1);
          if (!line) continue;
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          if (message.kind === 'ready') {
            ready = true;
            clearTimeout(deadline);
            resolve();
          } else if (message.kind === 'stopped') {
            onStopRequest();
          } else {
            const pending = waiters.get(message.id);
            if (!pending) continue;
            clearTimeout(pending.timer);
            waiters.delete(message.id);
            if (message.ok) pending.resolve(message);
            else pending.reject(new Error(message.error));
          }
        }
      });
      const died = (error) => {
        clearTimeout(deadline);
        if (child === proc) child = null;
        shown = false;
        helperPaused = false;
        const failure = error ?? new Error(`indicator helper exited${bufferDiagnostics ? `: ${bufferDiagnostics}` : ''}`);
        if (!ready) reject(failure);
        for (const [, pending] of waiters) { clearTimeout(pending.timer); pending.reject(failure); }
        waiters.clear();
      };
      proc.once('error', died);
      proc.once('exit', () => died());
      proc.stdin.on('error', () => {});
    }).finally(() => { starting = null; });
    return starting;
  }

  async function command(command, params = {}) {
    if (closed) throw new Error('indicator is shutting down');
    await start();
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`indicator ${command} timed out`));
      }, 5000);
      waiters.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ ...params, id, command }) + '\n', (error) => {
        if (error) { clearTimeout(timer); waiters.delete(id); reject(error); }
      });
    });
  }

  /** Show or hide the indicator to match the live series. */
  async function syncShow() {
    const want = series.active();
    if (want && helperPaused) {
      // The helper refuses `begin` while it is paused; lifting the stop first
      // also guarantees the banner is not left over from a stopped turn.
      helperPaused = false;
      await command('resume');
    }
    if (want && !shown) {
      shown = true;
      const text = bannerTextFor(leaseSessionId());
      await command('begin', payload());
      lastSentText = text;
    } else if (want && shown) {
      // Only `begin` rebuilds the banner text, so a changed goal re-sends it.
      const text = bannerTextFor(leaseSessionId());
      if (text !== lastSentText) {
        await command('begin', payload());
        lastSentText = text;
      }
    } else if (!want) {
      // The lease is over: the session that held it is no longer the one the
      // banner names, and the action word it carried is stale. The banner
      // keeps its session and goal parts either way.
      currentAction = DEFAULT_ACTION_WORD;
      if (shown) {
        shown = false;
        leaseSession = null;
        await command('end');
      }
    }
  }

  function onStopRequest() {
    shown = false;
    helperPaused = true;
    if (Date.now() < selfKeyInjectionUntil) {
      // Our own press_key/hotkey just injected Escape. Re-show on the next tick.
      info('ignored an Escape injected by our own key press');
      return;
    }
    if (!settings.stopOnEscape) {
      info('escape pressed but stopOnEscape is disabled');
      return;
    }
    const { aborted, key } = series.pressStop();
    info(`stopped by Escape: aborted=${aborted} blocked=${key ?? 'none'}`);
  }

  ctx.on('tools/execute', async (exec, next) => {
    // Remember that the official channel is still reachable. This is the only
    // signal the self-check has: it separates "the user is not using the
    // desktop" from "the official tool names changed and the banner went
    // silent".
    if (typeof exec.name === 'string' && exec.name.startsWith(OFFICIAL_TOOL_PREFIX)) {
      lastOfficialCallAt = Date.now();
    }
    const bare = desktopToolName(exec.name);
    if (bare === null || exec.signal?.aborted) return next();
    const session = exec.agent?.session;
    // The rule that reads the turn out of the host lives in lib/goal.mjs
    // (`execTurn`), next to the gate that uses it, so the plugin and the gate
    // cannot disagree about which turn a call belongs to.
    const turn = execTurn(exec);
    if (!session || turn === undefined) return next();

    // The gate: a session that never declared a goal is sent back once, so
    // the banner can say what the desktop work is about. It runs before the
    // lease is taken, so a blocked call holds nothing and leaves the desktop
    // free for everybody else.
    const gateError = checkGoalGate(session, turn, bare, exec);
    if (gateError !== null) throw gateError;

    const claim = series.acquire({ name: bare, sessionId: session.id, turn, signal: exec.signal });
    if (claim.blocked) throw new Error(claim.reason);
    // The host knows which official tool is running, so the banner can say
    // what is happening right now. This is a fact, not a guess, and it is the
    // segment that is always there. It is recorded after the lease was taken,
    // so a call that was refused cannot describe the work of the session that
    // holds the desktop.
    currentAction = actionWordFor(bare);

    // Invariant: the desktop lease is held from `series.acquire` until
    // `series.release` in the `finally` below, so no failure may skip that
    // release and leave the desktop locked for every other session.
    //
    // The only statement outside the `try` is the capture of the upstream
    // signal, a plain property read that cannot throw. It stays outside on
    // purpose: declaring `upstream` inside the `try` would leave it in the
    // temporal dead zone when an exception escapes the block, and the
    // `finally` would then throw on `exec.signal = upstream` before it
    // reached the release.
    const upstream = exec.signal;
    try {
      exec.signal = claim.signal;
      if (KEY_PRESS_TOOLS.has(bare)) selfKeyInjectionUntil = Date.now() + SELF_KEY_WINDOW_MS;
      // The banner names the session that holds the lease, so the host
      // session is remembered for as long as the lease lasts.
      leaseSession = session;
      // A session that predates this plugin has no recorded goal yet, so its
      // history supplies one before the banner is drawn.
      backfillGoal(session);
      await syncShow().catch(warn);
      return await next();
    } finally {
      if (KEY_PRESS_TOOLS.has(bare)) selfKeyInjectionUntil = Date.now() + SELF_KEY_WINDOW_MS;
      exec.signal = upstream;
      series.release(claim.id);
      // No desktop call is running any more. The action word would describe
      // something that already happened, so it goes back to the safe
      // fallback: the banner keeps its session and goal parts, but it never
      // keeps an action that is over.
      if (series.current === null || series.current.pending === 0) {
        currentAction = DEFAULT_ACTION_WORD;
      }
    }
  }, { global: true });

  ctx.on('session/event', (session, event) => {
    const type = event?.type;
    if (type === 'user/message') {
      // Only a human instruction is the baseline goal. The same event also
      // carries injected context (runtime-context snapshots, working directory,
      // tool registry, cron notices, goal continuations, ...); summarizing one
      // of those would show an environment snapshot in the banner and would
      // clear the goal the model reported. The source kind tells them apart —
      // see `HUMAN_SOURCE_KINDS` in goal.mjs for the MessageSourceMap list.
      if (!isHumanInstruction(event.data)) return;
      const text = extractUserText(event.data);
      // Two more gates decide this: an AgentTeams task dispatch reaches the
      // subagent as a plain `user` message, and a question or a complaint is
      // not a task at all. Neither becomes the goal, and neither may drop the
      // goal the session already shows — the complaint "现在配置似乎搞的有点
      // 复杂我没看懂应该怎么配置" is the user's trouble, not the work of the
      // session.
      const summary = summarizeHumanGoal(text, settings.goalMaxChars);
      if (summary === null) return;
      // A new instruction means a new task: it replaces the goal the model
      // reported, which described the previous one.
      goals.setAutoGoal(session?.id, summary);
      syncShow().catch(warn);
      return;
    }
    if (type !== 'turn/end') return;
    // The goal the model reported describes the work of the session, not of
    // one turn, so it survives the turn that reported it. It is dropped when
    // the session is gone (`agent/disposed`) or when a new instruction
    // arrives (`user/message` above).
    // The gate counts per turn, so the next turn starts over. The action
    // word is dropped too: it described the turn that just ended. The gate
    // state is forgotten under the very key the gate wrote it under.
    clearGate(session?.id, session?.agent?.id);
    currentAction = DEFAULT_ACTION_WORD;
    if (event.data?.turn === undefined) {
      syncShow().catch(warn);
      return;
    }
    series.clearTurn(session.id, event.data.turn);
    series.resume();
    syncShow().catch(warn);
  }, { global: true });

  // The host process is long-lived: drop the goal bucket of a session that is
  // gone, so the store does not grow with every session ever opened.
  ctx.on('agent/disposed', (payload) => {
    // The goal is stored under the id of the session. The id of the agent is
    // cleaned as well, as a defense against a host that names the two apart.
    const agentId = payload?.agent?.id;
    const sessionId = payload?.agent?.session?.id;
    for (const id of [agentId, sessionId]) {
      if (typeof id !== 'string' || id === '') continue;
      goals.delete(id);
      scanned.delete(id);
    }
    // The gate state is forgotten under the very key the gate wrote it under,
    // so the two can never point at different buckets.
    clearGate(sessionId, agentId);
  });

  ctx.effect(() => {
    const disposers = [];

    disposers.push(
      ctx.tools.register({
        name: 'computer_control_goal',
        description:
          '声明当前桌面操作目标，横幅会显示成「DSH 正在控制电脑 · 会话《…》· 正在点击 · 目标：目标」。'
          + '动桌面前必须先调用它：没声明目标时第一次桌面调用会被退回，声明后重试即可。'
          + '目标会一直保留，直到你换目标或用户下了新指令。',
        parameters: {
          type: 'object',
          properties: {
            goal: { type: 'string', description: `当前目标的一句话，≤${settings.goalMaxChars}字（超出自动截断）` },
          },
          required: ['goal'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'string' },
          render(_args, value) {
            return [{ type: 'text', text: String(value) }];
          },
        },
        execute(args, exec) {
          const raw = args?.goal;
          if (typeof raw !== 'string') throw new Error('goal 必须是字符串');
          const summary = summarizeGoal(raw, settings.goalMaxChars);
          if (!summary) throw new Error('goal 不能为空');
          // The goal is stored under the id of the session, because that is
          // the key the banner reads it under. The id of the agent is only the
          // fallback for a host that does not name the session at all.
          const sessionId = goalStoreKey(exec?.agent?.session?.id, exec?.agent?.id);
          goals.setModelGoal(sessionId, summary);
          syncShow().catch(warn);
          return `已记录当前桌面操作目标：${summary}`;
        },
      }),
    );

    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* disposal must not throw */
        }
      }
    };
  });

  const timer = setInterval(() => { if (!closed) syncShow().catch(warn); }, 1000);
  timer.unref?.();

  // The self-check runs on its own minute, apart from the banner tick, so it
  // can never slow the indicator down or change when the banner appears.
  const selfCheckTimer = setInterval(() => { if (!closed) selfCheckOfficialChannel(); }, SELF_CHECK_INTERVAL_MS);
  selfCheckTimer.unref?.();

  ctx.effect(() => () => {
    closed = true;
    clearInterval(timer);
    clearInterval(selfCheckTimer);
    const proc = child;
    child = null;
    if (proc === null) return;
    try { proc.stdin.write(JSON.stringify({ id: ++nextId, command: 'close' }) + '\n'); } catch { /* already gone */ }
    const force = setTimeout(() => { if (proc.exitCode === null) proc.kill(); }, 1000);
    force.unref?.();
  });

  info(`mounted (idleMs=${settings.idleMs}, stopOnEscape=${settings.stopOnEscape}, officialToolPrefix=${OFFICIAL_TOOL_PREFIX}*)`);
}
