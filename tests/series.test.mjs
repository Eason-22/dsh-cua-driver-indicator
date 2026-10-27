import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlSeries, STOPPED, BUSY, desktopToolName } from '../lib/series.mjs';

const env = (over = {}) => ({ name: 'click', sessionId: 's1', turn: 1, ...over });

test('a call keeps the series active until the idle window closes', () => {
  const series = new ControlSeries({ idleMs: 1000 });
  const claim = series.acquire({ ...env(), now: 0 });
  assert.equal(claim.blocked, false);
  assert.equal(series.active(0), true);
  series.release(claim.id, 100);
  assert.equal(series.active(900), true, 'still inside the idle window');
  assert.equal(series.active(1200), false, 'idle window elapsed');
});

test('a second conversation is refused while the desktop is in use', () => {
  const series = new ControlSeries({ idleMs: 1000 });
  series.acquire({ ...env(), now: 0 });
  const other = series.acquire({ ...env({ sessionId: 's2' }), now: 10 });
  assert.equal(other.blocked, true);
  assert.match(other.reason, /COMPUTER_USE_BUSY/);
  assert.equal(other.reason, BUSY);
});

test('stop aborts everything in flight and blocks the rest of the turn', () => {
  const series = new ControlSeries({ idleMs: 1000 });
  const upstream = new AbortController();
  const first = series.acquire({ ...env(), signal: upstream.signal, now: 0 });
  const second = series.acquire({ ...env({ name: 'type_text' }), now: 10 });
  assert.equal(first.signal.aborted, false);

  const result = series.pressStop();
  assert.equal(result.aborted, 2);
  assert.equal(result.key, 's1:1');
  assert.equal(first.signal.aborted, true, 'in-flight call 1 aborted');
  assert.equal(second.signal.aborted, true, 'in-flight call 2 aborted');
  assert.equal(upstream.signal.aborted, false, 'the host signal is untouched');

  const retry = series.acquire({ ...env(), now: 20 });
  assert.equal(retry.blocked, true);
  assert.equal(retry.reason, STOPPED);

  const nextTurn = series.acquire({ ...env({ turn: 2 }), now: 30 });
  assert.equal(nextTurn.blocked, false, 'a new turn may use the desktop again');
  assert.equal(series.pausedKey, null, 'the block is scoped to one turn');
});

test('a stop with nothing in flight blocks nobody', () => {
  const series = new ControlSeries({ idleMs: 1000 });
  const result = series.pressStop();
  assert.deepEqual(result, { aborted: 0, key: null });
  const claim = series.acquire({ ...env(), now: 0 });
  assert.equal(claim.blocked, false);
});

test('a finished turn ends its series', () => {
  const series = new ControlSeries({ idleMs: 60000 });
  series.acquire({ ...env(), now: 0 });
  series.clearTurn('s1', 1);
  assert.equal(series.active(1), false);
  series.clearTurn('s1', 1);
  assert.equal(series.active(2), false, 'repeated turn/end is harmless');
});

test('only real desktop calls are counted', () => {
  assert.equal(desktopToolName('cua_driver_native__click'), 'click');
  assert.equal(desktopToolName('cua_driver_native__get_window_state'), 'get_window_state');
  assert.equal(desktopToolName('cua_driver_native__start_recording'), 'start_recording');
  assert.equal(desktopToolName('cua_driver_native__get_config'), null);
  assert.equal(desktopToolName('cua_driver_native__list_sessions'), null);
  assert.equal(desktopToolName('cua_driver_native__set_agent_cursor_enabled'), null);
  assert.equal(desktopToolName('mcp__wincu__windows_computer_use_click'), null);
  assert.equal(desktopToolName('read'), null);
  assert.equal(desktopToolName(''), null);
});
