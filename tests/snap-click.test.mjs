import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AMBIGUOUS_TARGET,
  NOT_VISIBLE,
  ELEMENT_MISMATCH,
  EXPECT_CHANGE,
  ELEMENT_ID_EXPIRED,
  MAX_RETRY_OFFSET,
  POINT_COVERED,
  POINT_NOT_IN_TARGET,
  RETRY_OFFSETS,
  SNAP_CLICK_TOOL_NAME,
  TARGET_NOT_FOUND,
  TOO_MANY_STEPS,
  VERIFICATION,
  WAIT_TIMEOUT,
  WINDOW_NOT_FOUND,
  chooseRetryOffset,
  classifyChange,
  elementMatches,
  elementState,
  formatSnapClickResult,
  normalizeSnapClickArgs,
  runNamedSnapClick,
  runSnapClick,
  runSnapSequence,
  runSnapWaitFor,
  snapClickTool,
  snapshotChanged,
  uiaChanged,
} from '../lib/snap-click.mjs';

/**
 * A backend that answers from a script, and records every call.

 * The pixel hashes are what the native side would report: the small area
 * around the point (localHash) and the whole window (windowHash). The clicks
 * are recorded, so a test can see whether the tool clicked once, twice, or
 * not at all.

 * @param {object} script what the backend answers
 * @returns {object} the fake backend
 */
function fakeBackend(script = {}) {
  const calls = [];
  const state = {
    covered: script.covered === true,
    coveredBy: script.coveredBy ?? null,
    windowFound: script.windowFound !== false,
    pointInTarget: script.pointInTarget !== false,
    targetIsForeground: script.targetIsForeground !== false,
    target: script.target ?? { handle: 11, title: '目标窗口', rect: { x: 0, y: 0, width: 800, height: 600 } },
    top: script.top ?? null,
    localHashes: script.localHashes ?? ['before', 'after'],
    // The window hash only moves when a test says so: by default the window
    // stays as it was, so a test about the point is not about the window.
    windowHashes: script.windowHashes ?? ['w1', 'w1'],
    uia: script.uia ?? null,
    uiaBySnapshot: script.uiaBySnapshot ?? null,
    clickResults: script.clickResults ?? null,
    probeByPoint: script.probeByPoint ?? null,
    candidates: script.candidates ?? [],
    candidates: script.candidates ?? [],
    // The answer of the native side for an element id: whether the control
    // can run in the background, and whether the id is known any more.
    invoke: script.invoke ?? null,
    // ready: the window has its content. starting: it has not built it yet.
    webContent: script.webContent ?? 'ready',
  };
  let snapshots = 0;
  let clicks = 0;
  return {
    calls,
    get clicks() {
      return clicks;
    },
    async probe({ x, y, windowId }) {
      calls.push({ command: 'probe', x, y, windowId });
      const probes = calls.filter((call) => call.command === 'probe').length;
      const override = state.probeByPoint ? state.probeByPoint({ x, y, probes }) : null;
      if (override !== null) return override;
      return {
        covered: state.covered,
        coveredBy: state.coveredBy,
        windowFound: state.windowFound,
        pointInTarget: state.pointInTarget,
        targetIsForeground: state.targetIsForeground,
        target: state.target,
        top: state.top,
        point: { x, y },
      };
    },
    async find({ name, windowId }) {
      calls.push({ command: 'find', name, windowId });
      const wanted = String(name ?? '').trim().toLowerCase();
      const all = typeof state.candidates === 'function' ? state.candidates(wanted) : state.candidates;
      return {
        candidates: (Array.isArray(all) ? all : []).filter((candidate) => {
          // The native side compares the names without their decoration, so
          // the fake does the same: a name with emoji and brackets is found by
          // its plain name.
          const plain = (text) => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
          const key = plain(wanted);
          const name = plain(candidate.name);
          if (!key || !name) return false;
          return name === key || name.includes(key) || key.includes(name);
        }),
        windowFound: state.windowFound,
        error: state.error ?? null,
        webContent: state.webContent ?? 'ready',
      };
    },
    async invoke({ elementId }) {
      // Run a control by its id: in the background when it supports it, and
      // a plain refusal when the id is not known any more.
      calls.push({ command: 'invoke', elementId });
      const answer = typeof state.invoke === 'function' ? state.invoke(elementId) : (state.invoke ?? {});
      return {
        ok: answer?.ok === true,
        canInvoke: answer?.canInvoke === true,
        expired: answer?.expired === true || answer?.code === 'ELEMENT_ID_EXPIRED',
        manner: answer?.manner ?? 'point',
        name: answer?.name ?? '',
        rect: answer?.rect ?? null,
        offscreen: answer?.offscreen === true,
        error: answer?.error ?? null,
      };
    },
    async hover({ x, y }) {
      calls.push({ command: 'hover', x, y });
      return { ok: true, reconfirmed: true };
    },
    async snapshot({ x, y }) {
      const index = snapshots;
      snapshots += 1;
      calls.push({ command: 'snapshot', x, y });
      const localHash = state.localHashes[Math.min(index, state.localHashes.length - 1)];
      const windowHash = state.windowHashes[Math.min(index, state.windowHashes.length - 1)];
      const uia = state.uiaBySnapshot ? state.uiaBySnapshot(index) : state.uia;
      return { localHash, windowHash, uia, window: state.target };
    },
    async click({ x, y }) {
      calls.push({ command: 'click', x, y });
      clicks += 1;
      if (state.clickResults !== null) {
        const result = state.clickResults[Math.min(clicks - 1, state.clickResults.length - 1)];
        if (result !== undefined) return result;
      }
      return { ok: true, reconfirmed: true };
    },
  };
}

test('a covered point is not clicked at all', async () => {
  const backend = fakeBackend({ covered: true, coveredBy: { handle: 99, title: '遮挡窗口' } });
  const result = await runSnapClick({ x: 100, y: 200 }, backend);
  assert.equal(result.verification, VERIFICATION.COVERED);
  assert.equal(result.code, POINT_COVERED);
  assert.equal(result.clicked, false);
  assert.equal(result.coveredBy.title, '遮挡窗口');
  assert.equal(backend.clicks, 0, 'nothing was clicked');
  assert.match(formatSnapClickResult(result), /POINT_COVERED/);
  assert.match(formatSnapClickResult(result), /遮挡窗口/);
});

test('a window that does not exist is an error, not a click on whatever is on top', async () => {
  const backend = fakeBackend({ windowFound: false, top: { handle: 99, title: '最上层窗口' } });
  const result = await runSnapClick({ x: 100, y: 200, window_id: '并不存在的窗口' }, backend);
  assert.equal(result.code, WINDOW_NOT_FOUND);
  assert.equal(result.verification, VERIFICATION.ERROR);
  assert.equal(result.clicked, false);
  assert.equal(backend.clicks, 0, 'the window on top is NOT a substitute');
  assert.match(result.reason, /并不存在的窗口/);
  assert.match(formatSnapClickResult(result), /WINDOW_NOT_FOUND/);
});

test('a point that is not on the window the caller named is refused', async () => {
  const backend = fakeBackend({ pointInTarget: false, top: { handle: 99, title: '别的窗口' } });
  const result = await runSnapClick({ x: 100, y: 200, window_id: '目标窗口' }, backend);
  assert.equal(result.code, POINT_NOT_IN_TARGET);
  assert.equal(result.clicked, false);
  assert.equal(backend.clicks, 0);
  assert.match(result.reason, /别的窗口/);
});

test('a click that changes the screen is reported as changed', async () => {
  const backend = fakeBackend({ localHashes: ['before', 'after'] });
  const result = await runSnapClick({ x: 100, y: 200 }, backend);
  assert.equal(result.verification, VERIFICATION.CHANGED);
  assert.equal(result.clicked, true);
  assert.equal(result.retried, false);
  assert.equal(backend.clicks, 1);
});

test('the cursor goes to the point before the first reading', async () => {
  const backend = fakeBackend();
  await runSnapClick({ x: 100, y: 200 }, backend);
  const order = backend.calls.map((call) => call.command);
  assert.deepEqual(order.slice(0, 4), ['probe', 'hover', 'snapshot', 'click']);
});

test('nothing changed and the target is not idempotent: no retry', async () => {
  const backend = fakeBackend({ localHashes: ['same', 'same'] });
  const result = await runSnapClick({ x: 100, y: 200, expect_change: EXPECT_CHANGE.NON_IDEMPOTENT }, backend);
  assert.equal(result.verification, VERIFICATION.UNCHANGED);
  assert.equal(result.retried, false);
  assert.equal(backend.clicks, 1);
});

test('nothing changed and the target is idempotent: one retry within four pixels', async () => {
  const backend = fakeBackend({ localHashes: ['same', 'same', 'same', 'same'] });
  const result = await runSnapClick({ x: 100, y: 200, expect_change: EXPECT_CHANGE.IDEMPOTENT }, backend);
  assert.equal(result.verification, VERIFICATION.UNCHANGED);
  assert.equal(result.retried, true);
  assert.equal(backend.clicks, 2, 'exactly one retry');
  assert.equal(result.attempts.length, 2);
  const [first, second] = result.attempts;
  assert.ok(Math.abs(second.x - first.x) <= MAX_RETRY_OFFSET);
  assert.ok(Math.abs(second.y - first.y) <= MAX_RETRY_OFFSET);
});

test('the retry hits the target: the answer is changed', async () => {
  const backend = fakeBackend({ localHashes: ['same', 'same', 'same', 'after'] });
  const result = await runSnapClick({ x: 100, y: 200, expect_change: EXPECT_CHANGE.IDEMPOTENT }, backend);
  assert.equal(result.verification, VERIFICATION.CHANGED);
  assert.equal(result.retried, true);
  assert.equal(backend.clicks, 2);
});

test('a covered retry point is not clicked either', async () => {
  const backend = fakeBackend({
    localHashes: ['same', 'same'],
    probeByPoint: ({ probes }) => (probes >= 2
      ? { covered: true, coveredBy: { handle: 99, title: '遮挡窗口' }, windowFound: true, pointInTarget: true, target: null }
      : null),
  });
  const result = await runSnapClick({ x: 100, y: 200, expect_change: EXPECT_CHANGE.IDEMPOTENT }, backend);
  assert.equal(result.verification, VERIFICATION.UNCHANGED);
  assert.equal(result.retried, false);
  assert.equal(backend.clicks, 1);
});

test('the window changed somewhere else: that is a success, not a retry', async () => {
  const backend = fakeBackend({ localHashes: ['same', 'same'], windowHashes: ['w1', 'w2'], uia: null });
  const result = await runSnapClick({ x: 100, y: 200, expect_change: EXPECT_CHANGE.IDEMPOTENT }, backend);
  assert.equal(result.verification, VERIFICATION.CHANGED_ELSEWHERE);
  assert.equal(result.retried, false, 'changed_elsewhere is never clicked again');
  assert.equal(backend.clicks, 1, 'one click, no retry');
  assert.equal(result.attempts[0].windowChanged, true, 'the window really changed');
  assert.equal(result.attempts[0].changed, false, 'but the point did not');
});

test('nothing changed anywhere: unchanged, and one retry is allowed', async () => {
  const backend = fakeBackend({ localHashes: ['same', 'same', 'same', 'same'], windowHashes: ['w1', 'w1', 'w1', 'w1'], uia: null });
  const result = await runSnapClick({ x: 100, y: 200, expect_change: EXPECT_CHANGE.IDEMPOTENT }, backend);
  assert.equal(result.verification, VERIFICATION.UNCHANGED);
  assert.equal(result.retried, true);
  assert.equal(backend.clicks, 2, 'one retry');
});

test('the three tiers of what the click did', () => {
  assert.equal(classifyChange({ localHash: 'a', windowHash: 'w' }, { localHash: 'b', windowHash: 'w' }), VERIFICATION.CHANGED);
  assert.equal(classifyChange({ localHash: 'a', windowHash: 'w', uia: { name: 'x' } }, { localHash: 'a', windowHash: 'w', uia: { name: 'y' } }), VERIFICATION.CHANGED);
  assert.equal(classifyChange({ localHash: 'a', windowHash: 'w', uia: null }, { localHash: 'a', windowHash: 'w2', uia: null }), VERIFICATION.CHANGED_ELSEWHERE);
  assert.equal(classifyChange({ localHash: 'a', windowHash: 'w', uia: null }, { localHash: 'a', windowHash: 'w', uia: null }), VERIFICATION.UNCHANGED);
});

test('an unknown UIA state is not a change', async () => {
  const backend = fakeBackend({ localHashes: ['same', 'same'], uiaBySnapshot: (index) => (index === 0 ? null : { name: 'x' }) });
  const result = await runSnapClick({ x: 100, y: 200 }, backend);
  assert.equal(result.verification, VERIFICATION.UNCHANGED);
  assert.equal(snapshotChanged({ localHash: 'a', uia: null }, { localHash: 'a', uia: { name: 'x' } }), false);
});

test('a known UIA state that changed is a change', async () => {
  const backend = fakeBackend({ localHashes: ['same', 'same'], uiaBySnapshot: (index) => ({ name: index === 0 ? 'a' : 'b' }) });
  const result = await runSnapClick({ x: 100, y: 200 }, backend);
  assert.equal(result.verification, VERIFICATION.CHANGED);
});

test('only the focus moved: that is not a change', async () => {
  // The click moved the focus and nothing else. `focused` flips on its own,
  // so it says nothing about the screen and must not count as a change.

  const before = { name: '按钮', focused: false };
  const after = { name: '按钮', focused: true };
  assert.equal(uiaChanged(before, after), false, 'focused alone is not a state change');
  assert.equal(
    classifyChange(
      { localHash: 'same', windowHash: 'w1', uia: before },
      { localHash: 'same', windowHash: 'w1', uia: after },
    ),
    VERIFICATION.UNCHANGED,
    'the click did nothing, so it is unchanged',
  );

  const backend = fakeBackend({
    localHashes: ['same', 'same'],
    windowHashes: ['w1', 'w1'],
    uiaBySnapshot: (index) => ({ name: '按钮', focused: index === 0 }),
  });
  const result = await runSnapClick({ x: 100, y: 200 }, backend);
  assert.equal(result.verification, VERIFICATION.UNCHANGED);
  assert.equal(result.attempts[0].uiaChanged, false, 'the focus moved, the state did not');
  assert.equal(result.attempts[0].changed, false);
  assert.equal(result.retried, false, 'the focus alone does not trigger a retry');
  assert.equal(backend.clicks, 1, 'one click');
});

test('the element under the point is not the one that was named: no click', async () => {
  const backend = fakeBackend({ uia: { name: '取消', automationId: 'cancel' } });
  const result = await runSnapClick({ x: 100, y: 200, element_token: '确定' }, backend);
  assert.equal(result.code, ELEMENT_MISMATCH);
  assert.equal(result.clicked, false);
  assert.equal(backend.clicks, 0);
  assert.match(result.reason, /取消/);
});

test('an unreadable UIA state is not a mismatch', async () => {
  const backend = fakeBackend({ uia: null });
  const result = await runSnapClick({ x: 100, y: 200, element_token: '确定' }, backend);
  assert.equal(result.clicked, true);
  assert.equal(result.element.known, false);
  assert.equal(result.element.matched, null);
  assert.equal(elementMatches('确定', null), null);
});

test('the retry point holds another element: the second click is refused', async () => {
  const backend = fakeBackend({
    localHashes: ['same', 'same', 'same', 'same'],
    uiaBySnapshot: (index) => ({ name: index < 2 ? '确定' : '取消' }),
  });
  const result = await runSnapClick({ x: 100, y: 200, element_token: '确定', expect_change: EXPECT_CHANGE.IDEMPOTENT }, backend);
  assert.equal(result.retried, false);
  assert.equal(backend.clicks, 1, 'the second click was refused');
  assert.match(result.reason, /element_token/);
});

test('the native side refuses the click when the point changed owner', async () => {
  const backend = fakeBackend({
    clickResults: [{ ok: false, code: POINT_COVERED, coveredBy: { handle: 99, title: '新弹窗' } }],
  });
  const result = await runSnapClick({ x: 100, y: 200 }, backend);
  assert.equal(result.verification, VERIFICATION.COVERED);
  assert.equal(result.code, POINT_COVERED);
  assert.equal(result.clicked, false);
  assert.equal(result.coveredBy.title, '新弹窗');
});

test('the retry offset stays inside the element under the point', () => {
  const offset = chooseRetryOffset({
    x: 100,
    y: 200,
    target: { rect: { x: 0, y: 0, width: 800, height: 600 } },
    element: { rect: { x: 98, y: 198, width: 6, height: 6 } },
  });
  assert.deepEqual(offset, { dx: 3, dy: 3 });
  const wide = chooseRetryOffset({ x: 100, y: 200, target: { rect: { x: 0, y: 0, width: 800, height: 600 } } });
  assert.ok(Math.abs(wide.dx) <= MAX_RETRY_OFFSET);
  for (const candidate of RETRY_OFFSETS) {
    assert.ok(Math.abs(candidate.dx) <= MAX_RETRY_OFFSET);
    assert.ok(Math.abs(candidate.dy) <= MAX_RETRY_OFFSET);
  }
});

test('the tool is Windows only', async () => {
  const tool = snapClickTool({ backend: fakeBackend(), platform: 'linux' });
  await assert.rejects(() => tool.execute({ x: 1, y: 2 }), /只支持 Windows/);
});

test('the tool is registered with the documented parameters', () => {
  const tool = snapClickTool({ backend: fakeBackend() });
  assert.equal(tool.name, SNAP_CLICK_TOOL_NAME);
  assert.equal(tool.name, 'cua_snap_click');
  assert.deepEqual(tool.parameters.required, ['x', 'y']);
  assert.deepEqual(tool.parameters.properties.expect_change.enum, ['idempotent', 'non_idempotent', 'none']);
  const rendered = tool.output.render({}, { verification: VERIFICATION.CHANGED, reason: '好了', attempts: [] });
  assert.match(rendered[0].text, /verification: changed/);
});

test('without a window_id the target is the window under the point', async () => {
  const backend = fakeBackend({ targetIsForeground: false, top: { handle: 22, title: '背景窗口' } });
  const result = await runSnapClick({ x: 100, y: 200 }, backend);
  assert.equal(result.clicked, true, 'a visible but not activated window is a legitimate target');
  assert.equal(result.target.title, '目标窗口');
  assert.equal(result.targetIsForeground, false);
  assert.match(formatSnapClickResult(result), /未激活/);
});

test('the answer says whether the point was confirmed again before the click', async () => {
  const backend = fakeBackend();
  const result = await runSnapClick({ x: 100, y: 200 }, backend);
  assert.equal(result.reconfirmed, true);
  assert.match(formatSnapClickResult(result), /又确认了一次/);
});

test('the arguments are normalised', () => {
  const call = normalizeSnapClickArgs({ x: 10, y: 20, expect_change: 'idemtpotent' });
  assert.equal(call.expectChange, EXPECT_CHANGE.NON_IDEMPOTENT);
  assert.throws(() => normalizeSnapClickArgs({ x: 'ten', y: 20 }), /x 和 y/);
  assert.throws(() => normalizeSnapClickArgs({}), /x 和 y/);
});

test('the element state says whether it could be read', () => {
  assert.equal(elementState('确定', { name: '确定' }).matched, true);
  assert.equal(elementState('确定', null).known, false);
  assert.equal(elementState('', null).matched, true);
});

test('a name that hits one control is clicked', async () => {
  const backend = fakeBackend({
    candidates: [{ name: '确定', rect: { x: 100, y: 200, width: 40, height: 20 }, level: 3 }],
    localHashes: ['before', 'after'],
  });
  const result = await runNamedSnapClick({ name: '确定', window_id: '目标窗口' }, backend);
  assert.equal(result.verification, VERIFICATION.CHANGED);
  assert.equal(result.name, '确定');
  assert.equal(result.unique, true);
  assert.equal(result.rect.x, 100);
  assert.equal(backend.clicks, 1);
  const click = backend.calls.find((call) => call.command === 'click');
  assert.equal(click.x, 120, 'the click is at the centre of the control');
  assert.equal(click.y, 210);
});

test('a name that hits two controls is refused, and the candidates are listed', async () => {
  const backend = fakeBackend({
    candidates: [
      { name: '确定', rect: { x: 100, y: 200, width: 40, height: 20 }, level: 3 },
      { name: '确定', rect: { x: 300, y: 400, width: 40, height: 20 }, level: 5 },
    ],
  });
  const result = await runNamedSnapClick({ name: '确定', window_id: '目标窗口' }, backend);
  assert.equal(result.code, AMBIGUOUS_TARGET);
  assert.equal(result.clicked, false);
  assert.equal(result.unique, false);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].rect.x, 100);
  assert.equal(result.candidates[1].level, 5);
  assert.equal(result.candidates[0].similarity, 1);
  assert.equal(backend.clicks, 0, 'nothing is clicked: the tool never guesses');
  assert.match(formatSnapClickResult(result), /候选/);
});

test('a name that hits nothing is an error, not a click somewhere else', async () => {
  const backend = fakeBackend({ candidates: [] });
  const result = await runNamedSnapClick({ name: '没有这个按钮', window_id: '目标窗口' }, backend);
  assert.equal(result.code, TARGET_NOT_FOUND);
  assert.equal(result.clicked, false);
  assert.equal(backend.clicks, 0);
});

test('the sequence stops at the first step that fails', async () => {
  const backend = fakeBackend({
    candidates: [{ name: '第一步', rect: { x: 10, y: 20, width: 40, height: 20 }, level: 2 }],
    localHashes: ['before', 'after', 'after', 'after'],
  });
  const result = await runSnapSequence({
    window_id: '目标窗口',
    steps: [{ name: '第一步' }, { name: '不存在的按钮' }, { name: '第三步' }],
  }, backend);
  assert.equal(result.stoppedAt, 2);
  assert.equal(result.executed, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.steps.length, 2, 'the third step was never looked for');
  assert.match(result.reason, /第 2 步/);
  assert.match(result.reason, /后面的 1 步没有执行/);
  assert.equal(backend.calls.filter((call) => call.command === 'find').length, 2);
});

test('a non idempotent step is not clicked twice', async () => {
  const backend = fakeBackend({
    candidates: [{ name: '发送', rect: { x: 10, y: 20, width: 40, height: 20 }, level: 2 }],
    localHashes: ['same', 'same', 'same', 'same'],
    windowHashes: ['w1', 'w1', 'w1', 'w1'],
  });
  const result = await runSnapSequence({
    window_id: '目标窗口',
    steps: [{ name: '发送', expect_change: 'non_idempotent' }],
  }, backend);
  assert.equal(result.verification, VERIFICATION.ERROR);
  assert.equal(result.stoppedAt, 1);
  assert.equal(backend.clicks, 1, 'one click, no retry');
});

test('a step that changed elsewhere is a success and the walk continues', async () => {
  const backend = fakeBackend({
    candidates: [
      { name: '甲', rect: { x: 10, y: 20, width: 40, height: 20 }, level: 2 },
      { name: '乙', rect: { x: 60, y: 20, width: 40, height: 20 }, level: 2 },
    ],
    localHashes: ['same', 'same', 'same', 'same'],
    windowHashes: ['w1', 'w2', 'w3', 'w4'],
  });
  const result = await runSnapSequence({
    window_id: '目标窗口',
    steps: [{ name: '甲' }, { name: '乙' }],
  }, backend);
  assert.equal(result.verification, VERIFICATION.CHANGED_ELSEWHERE, 'the walk says what its steps did');
  assert.equal(result.executed, 2);
  assert.equal(result.steps[0].verification, VERIFICATION.CHANGED_ELSEWHERE);
  assert.equal(result.steps[1].verification, VERIFICATION.CHANGED_ELSEWHERE);
});

test('more than five steps are refused before anything is clicked', async () => {
  const backend = fakeBackend({ candidates: [] });
  const result = await runSnapSequence({
    steps: ['一', '二', '三', '四', '五', '六'].map((name) => ({ name })),
  }, backend);
  assert.equal(result.code, TOO_MANY_STEPS);
  assert.equal(result.executed, 0);
  assert.equal(backend.clicks, 0);
  assert.equal(backend.calls.filter((call) => call.command === 'find').length, 0);
});

test('the named window does not exist: that is not a missing control', async () => {
  const backend = fakeBackend({ windowFound: false, candidates: [] });
  const result = await runNamedSnapClick({ name: '确定', window_id: '并不存在的窗口' }, backend);
  assert.equal(result.code, WINDOW_NOT_FOUND);
  assert.equal(result.verification, VERIFICATION.ERROR);
  assert.equal(result.clicked, false);
  assert.equal(backend.clicks, 0);
  assert.match(result.reason, /窗口/);
});

test('a sequence whose steps all changed elsewhere says so, and lists every step', async () => {
  const backend = fakeBackend({
    candidates: [
      { name: '甲', rect: { x: 10, y: 20, width: 40, height: 20 }, level: 2 },
      { name: '乙', rect: { x: 60, y: 20, width: 40, height: 20 }, level: 2 },
    ],
    localHashes: ['same', 'same', 'same', 'same'],
    windowHashes: ['w1', 'w2', 'w3', 'w4'],
  });
  const result = await runSnapSequence({
    window_id: '目标窗口',
    steps: [{ name: '甲' }, { name: '乙' }],
  }, backend);
  assert.equal(result.verification, VERIFICATION.CHANGED_ELSEWHERE, 'the walk says what its steps did');
  assert.equal(result.executed, 2);
  const text = formatSnapClickResult(result);
  assert.match(text, /步骤/);
  assert.equal((text.match(/changed_elsewhere/g) ?? []).length >= 3, true, 'every step is listed with its verdict');
});

test('a name that carries emoji and brackets is found by its plain name', async () => {
  const backend = fakeBackend({
    candidates: [{ name: '📥 下载花名册（全部人员）', rect: { x: 100, y: 100, width: 120, height: 32 }, level: 3 }],
  });
  const result = await runNamedSnapClick({ name: '下载花名册' }, backend);
  assert.equal(result.unique, true, 'the plain name finds the decorated control');
  assert.equal(result.clicked, true);
  assert.equal(result.name, '📥 下载花名册（全部人员）');
  assert.equal(backend.clicks, 1);
});

test('a control that is off the screen is not clicked: scroll to it first', async () => {
  const backend = fakeBackend({
    candidates: [{ name: '算薪', rect: { x: -300, y: -200, width: 80, height: 30 }, level: 3, offscreen: true }],
  });
  const result = await runNamedSnapClick({ name: '算薪' }, backend);
  assert.equal(result.code, NOT_VISIBLE);
  assert.equal(result.clicked, false);
  assert.equal(backend.clicks, 0);
  assert.match(result.reason, /屏幕外/);
});

test('when one of two controls with the same name is on the screen, the visible one is the one', async () => {
  const backend = fakeBackend({
    candidates: [
      { name: '确定', rect: { x: -300, y: -200, width: 80, height: 30 }, level: 3, offscreen: true },
      { name: '确定', rect: { x: 200, y: 300, width: 80, height: 30 }, level: 3, offscreen: false },
    ],
  });
  const result = await runNamedSnapClick({ name: '确定' }, backend);
  assert.equal(result.unique, true);
  assert.equal(result.clicked, true);
  assert.equal(result.rect.x, 200, 'the visible one is the one that is clicked');
});

test('an element id runs the control in the background, without moving the mouse', async () => {
  const backend = fakeBackend({
    candidates: [{ name: '确定', rect: { x: 100, y: 100, width: 80, height: 30 }, level: 3, elementId: 'e7' }],
    invoke: { ok: true, canInvoke: true, name: '确定', rect: { x: 100, y: 100, width: 80, height: 30 } },
  });
  const result = await runNamedSnapClick({ element_id: 'e7' }, backend);
  assert.equal(result.manner, 'invoke', 'the control ran in the background');
  assert.equal(result.clicked, true);
  assert.equal(result.elementId, 'e7');
  assert.equal(result.matchedBy, 'element_id');
  assert.equal(backend.clicks, 0, 'the mouse did not move');
});

test('an element id that is gone says so, it does not fall back to a guess', async () => {
  const backend = fakeBackend({ invoke: { ok: false, expired: true, code: 'ELEMENT_ID_EXPIRED' } });
  const result = await runNamedSnapClick({ element_id: 'e99' }, backend);
  assert.equal(result.code, ELEMENT_ID_EXPIRED);
  assert.equal(result.clicked, false);
  assert.equal(backend.clicks, 0, 'nothing was clicked');
  assert.match(result.reason, /失效/);
});

test('a control without the invoke pattern is clicked by its point', async () => {
  const backend = fakeBackend({
    candidates: [{ name: '确定', rect: { x: 100, y: 100, width: 80, height: 30 }, level: 3, elementId: 'e7' }],
    invoke: { ok: false, canInvoke: false, name: '确定', rect: { x: 100, y: 100, width: 80, height: 30 } },
  });
  const result = await runNamedSnapClick({ element_id: 'e7' }, backend);
  assert.equal(result.manner, 'point');
  assert.equal(result.clicked, true);
  assert.equal(backend.clicks, 1, 'the point was clicked');
});

test('waiting for a control that does not show up says that it timed out', async () => {
  const backend = fakeBackend({ candidates: [] });
  const result = await runSnapWaitFor({ name: '弹窗', timeout_ms: 300 }, backend);
  assert.equal(result.code, WAIT_TIMEOUT);
  assert.equal(result.found, false);
  assert.match(result.reason, /没有出现/);
});

test('an element id that points off the screen is not clicked', async () => {
  const backend = fakeBackend({
    invoke: { ok: false, canInvoke: false, name: '算薪', rect: { x: -300, y: -200, width: 80, height: 30 }, offscreen: true },
  });
  const result = await runNamedSnapClick({ element_id: 'e7' }, backend);
  assert.equal(result.code, NOT_VISIBLE);
  assert.equal(result.clicked, false);
  assert.equal(backend.clicks, 0, 'nothing was clicked');
});
