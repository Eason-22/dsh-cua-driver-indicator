/**
 * Control-series state for the takeover indicator.
 *
 * Pure logic on purpose: no timers, no child process, no DSH services. The host
 * plugin wires this to tool execution, and the tests drive it directly.
 *
 * Vocabulary
 *   series  — one conversation turn that is operating the desktop. It stays
 *             "active" while a desktop call is running and for `idleMs` after
 *             the last one finished, so the banner survives short reasoning gaps.
 *   stop    — the user pressed Esc. Every call already in flight is aborted and
 *             the current turn is blocked, because letting the agent keep
 *             clicking after a stop request is worse than refusing the call.
 */

export const STOPPED = 'COMPUTER_USE_STOPPED_BY_USER: The user stopped this operation series with Escape. Do not retry desktop input in this turn; a new user turn may use the desktop again.';
export const BUSY = 'COMPUTER_USE_BUSY: Another conversation is using the desktop. Wait for that operation series to finish or stop it before retrying.';

const NATIVE_TOOL = /^cua_driver_native__[a-z_]+$/;

// Calls that bookkeeping the provider session rather than touching the desktop.
// Counting them would flash the banner for reading a config value.
const BOOKKEEPING = new Set([
  'get_config', 'set_config', 'health_report', 'check_permissions',
  'list_sessions', 'get_session', 'get_session_state', 'start_session', 'end_session',
  'get_recording_state', 'install_ffmpeg',
  'get_agent_cursor_state', 'set_agent_cursor_enabled', 'set_agent_cursor_motion', 'set_agent_cursor_theme',
  'replay_trajectory'
]);

/**
 * Bare upstream tool name when this call operates the desktop, otherwise null.
 * @param {string} name
 * @returns {string|null}
 */
export function desktopToolName(name = '') {
  if (typeof name !== 'string' || !NATIVE_TOOL.test(name)) return null;
  const bare = name.slice('cua_driver_native__'.length);
  return BOOKKEEPING.has(bare) ? null : bare;
}

export class ControlSeries {
  /** @param {{idleMs?: number}} options */
  constructor({ idleMs = 30000 } = {}) {
    this.idleMs = idleMs;
    /** @type {{sessionId: string, turn: number, pending: number, lastActive: number}|null} */
    this.current = null;
    /** Blocked series key (`sessionId:turn`) after a stop request. */
    this.pausedKey = null;
    /** @type {Map<number, {controller: AbortController, name: string, key: string}>} */
    this.inFlight = new Map();
    this.seq = 0;
    this.stops = 0;
  }

  key() {
    return this.current ? `${this.current.sessionId}:${this.current.turn}` : null;
  }

  expire(now = Date.now()) {
    if (this.current && this.current.pending === 0 && now - this.current.lastActive >= this.idleMs) {
      this.current = null;
    }
  }

  active(now = Date.now()) {
    this.expire(now);
    return this.current !== null;
  }

  /**
   * Claim the desktop for one call.
   * @returns {{blocked: true, reason: string} | {blocked: false, id: number, signal: AbortSignal}}
   */
  acquire({ name, sessionId, turn, signal, now = Date.now() }) {
    this.expire(now);
    const key = `${sessionId}:${turn}`;
    if (this.pausedKey === key) return { blocked: true, reason: STOPPED };
    // A stop request only covers the turn it happened in.
    if (this.pausedKey !== null && this.pausedKey !== key) this.pausedKey = null;
    if (this.current !== null && this.current.sessionId !== sessionId) return { blocked: true, reason: BUSY };
    if (this.current === null) this.current = { sessionId, turn, pending: 0, lastActive: now };
    this.current.turn = turn;
    this.current.pending += 1;
    this.current.lastActive = now;
    const id = ++this.seq;
    const controller = new AbortController();
    this.inFlight.set(id, { controller, name, key });
    return {
      blocked: false,
      id,
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    };
  }

  /** Release one call and refresh the idle clock. */
  release(id, now = Date.now()) {
    const entry = this.inFlight.get(id);
    this.inFlight.delete(id);
    if (this.current) {
      this.current.pending = Math.max(0, this.current.pending - 1);
      this.current.lastActive = now;
    }
    return entry;
  }

  /** A turn ended: its series is over, whatever is still in flight. */
  clearTurn(sessionId, turn) {
    if (this.current && this.current.sessionId === sessionId && this.current.turn === turn) this.current = null;
  }

  /**
   * The user asked to stop. Abort everything in flight and block this turn.
   * @returns {{aborted: number, key: string|null}}
   */
  pressStop() {
    const key = this.key();
    let aborted = 0;
    for (const { controller } of this.inFlight.values()) {
      aborted += 1;
      try { controller.abort(new Error(STOPPED)); } catch { /* already aborted */ }
    }
    this.inFlight.clear();
    if (key !== null) this.pausedKey = key;
    this.current = null;
    this.stops += 1;
    return { aborted, key };
  }

  /** Lift a stop block (used when a new turn is confirmed). */
  resume() {
    this.pausedKey = null;
  }
}
