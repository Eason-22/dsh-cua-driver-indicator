/**
 * The `cua_snap_click` tool: click a point, and check that the click landed.
 *
 * The built-in Cua Driver sends the mouse to the point the model names. Two
 * things go wrong in practice:
 *
 *   - the point is covered by another window (a dialog, a notification, the
 *     upper half of a stacked pair) - the click then hits the wrong window;
 *   - the point is a few pixels off a small target - the click lands on the
 *     background and nothing happens at all.
 *
 * So this tool does three things around one click:
 *
 *   1. it asks the operating system which window is on top at that point, and
 *      REFUSES to click when that is not the window the caller meant
 *      (`POINT_COVERED`, with the title of the window that is in the way);
 *   2. it reads the pixel hash AROUND the point and the UIA state of the
 *      element under it before and after the click, so "the click did something"
 *      is a fact and not a guess; the hash of the whole window is only used to
 *      tell "changed somewhere else" from "nothing changed";
 *   3. when nothing changed and the caller declared the target idempotent, it
 *      retries ONCE, at an offset of at most four pixels.
 *
 * The decision logic lives here and takes its backend as an argument, so the
 * tests can drive all three branches without a Windows desktop. The native half
 * (the window probe, the pixel hash, the click itself) lives in
 * scripts/windows-snap-click.cs.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The name the tool is registered under. */
export const SNAP_CLICK_TOOL_NAME = 'cua_snap_click';

/** What the tool can say about the click. */
export const VERIFICATION = {
  CHANGED: 'changed',
  UNCHANGED: 'unchanged',
  COVERED: 'covered',
  CHANGED_ELSEWHERE: 'changed_elsewhere',
  ERROR: 'error',
};

/** The code that says: the point was covered, so nothing was clicked. */
export const POINT_COVERED = 'POINT_COVERED';

/** The window the caller named does not exist: nothing may be clicked. */
export const WINDOW_NOT_FOUND = 'WINDOW_NOT_FOUND';

/** The point is not on the window the caller named (it belongs to another one). */
export const POINT_NOT_IN_TARGET = 'POINT_NOT_IN_TARGET';

/** The element under the point is not the one the caller named. */
export const ELEMENT_MISMATCH = 'ELEMENT_MISMATCH';

/** What the caller may say about the target of the click. */
export const EXPECT_CHANGE = {
  /** The click should change the screen, and clicking twice is safe. */
  IDEMPOTENT: 'idempotent',
  /** The click should change the screen, but clicking twice is not safe. */
  NON_IDEMPOTENT: 'non_idempotent',
  /** No change is expected (a label, a divider, an empty area). */
  NONE: 'none',
};

export const EXPECT_CHANGE_VALUES = [
  EXPECT_CHANGE.IDEMPOTENT,
  EXPECT_CHANGE.NON_IDEMPOTENT,
  EXPECT_CHANGE.NONE,
];

/** The retry never moves the click further than this (in pixels). */
export const MAX_RETRY_OFFSET = 4;

/** The offsets the retry may use. */
export const RETRY_OFFSETS = [
  { dx: 3, dy: 3 },
  { dx: -3, dy: 3 },
  { dx: 3, dy: -3 },
  { dx: -3, dy: -3 },
  { dx: 4, dy: 0 },
  { dx: 0, dy: 4 },
  { dx: -4, dy: 0 },
  { dx: 0, dy: -4 },
];

/**
 * The helper that answers the questions about the screen.
 *
 * The path is a module constant, never a parameter: the command line of the
 * helper stays constant, and everything the model says travels over stdin as
 * JSON instead of becoming a command.
 */
const helperScript = fileURLToPath(new URL('../scripts/windows-snap-click.ps1', import.meta.url));

/** Wait a little: the screen needs a moment to show what the click did. */
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * The arguments of one call, in the shape the rest of the file works with.
 *
 * An unknown `expect_change` is treated as the safe one (no retry): a typo
 * must never turn into a second click on a button that is not idempotent.
 *
 * @param {object} args the raw tool arguments
 * @returns {{x: number, y: number, windowId: string, elementToken: string, expectChange: string}}
 */
export function normalizeSnapClickArgs(args) {
  const source = args && typeof args === 'object' ? args : {};
  const x = Number(source.x);
  const y = Number(source.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('x 和 y 必须是数字：这是屏幕上的物理坐标');
  }
  const raw = typeof source.expect_change === 'string' ? source.expect_change.trim().toLowerCase() : '';
  const windowId = typeof source.window_id === 'string'
    ? source.window_id.trim()
    : (source.window_id == null ? '' : String(source.window_id).trim());
  return {
    x: Math.round(x),
    y: Math.round(y),
    windowId,
    elementToken: typeof source.element_token === 'string' ? source.element_token.trim() : '',
    expectChange: EXPECT_CHANGE_VALUES.includes(raw) ? raw : EXPECT_CHANGE.NON_IDEMPOTENT,
  };
}

/**
 * The offset the retry uses: at most four pixels, and inside the target
 * window when the window is known.
 *
 * The choice is deterministic (the same point always retries the same way),
 * so a run can be repeated and compared.
 *
 * @param {{x: number, y: number, target?: object}} context
 * @returns {{dx: number, dy: number}}
 */
export function chooseRetryOffset({ x, y, target, element } = {}) {
  // The element under the point is the tightest box that still holds the
  // target of the click, so the retry aims at the SAME element whenever the
  // UIA state knows it. The window is the fallback boundary.
  const elementRect = element && typeof element.rect === 'object' ? element.rect : null;
  const clientRect = target && typeof target.clientRect === 'object' ? target.clientRect : null;
  const windowRect = target && typeof target.rect === 'object' ? target.rect : null;
  const inside = (offset, rect) => {
    if (!rect || typeof rect.x !== 'number') return true;
    const px = x + offset.dx;
    const py = y + offset.dy;
    return px >= rect.x && px < rect.x + rect.width && py >= rect.y && py < rect.y + rect.height;
  };
  const inElement = RETRY_OFFSETS.filter((offset) => inside(offset, elementRect));
  const inClient = RETRY_OFFSETS.filter((offset) => inside(offset, clientRect));
  const inWindow = RETRY_OFFSETS.filter((offset) => inside(offset, windowRect));
  const list = inElement.length > 0
    ? inElement
    : (inClient.length > 0 ? inClient : (inWindow.length > 0 ? inWindow : RETRY_OFFSETS));
  const seed = Math.abs(Math.round(x) + Math.round(y)) % list.length;
  return { dx: list[seed].dx, dy: list[seed].dy };
}

/**
 * The UIA state without the fields that move on their own.
 *
 * `focused` flips as soon as the click moves the focus, which says nothing
 * about whether the click changed anything: comparing it would report a change
 * that is not one.
 *
 * @param {object|null} uia the state of the element under the point
 * @returns {object|null} the state that is compared
 */
function comparableUiaState(uia) {
  if (uia == null || typeof uia !== 'object') return uia;
  const rest = { ...uia };
  delete rest.focused;
  return rest;
}

/** Did the UIA state of the element under the point change? */
export function uiaChanged(before, after) {
  // An unknown UIA state is NOT a change: the element may simply not be
  // readable, and calling that a change would report a click that did
  // nothing as a success.
  if (before == null || after == null) return false;
  return JSON.stringify(comparableUiaState(before)) !== JSON.stringify(comparableUiaState(after));
}

/** Did the screen under the click change at all? */
export function snapshotChanged(before, after) {
  if (!before || !after) return false;
  // The pixels AROUND the point are the primary signal: that is what a click
  // changes. The hash of the whole window is auxiliary only (it is reported,
  // but it never decides), because any repaint anywhere in the window would
  // make a click that did nothing look like a success.
  if ((before.localHash || '') !== (after.localHash || '')) return true;
  // The UIA state of the element under the point is the second signal, and
  // only when BOTH readings are known.
  return uiaChanged(before.uia, after.uia);
}

/**
 * Does the element under the point look like the one the caller named?
 *
 * The token of the official snapshot is opaque, so this is a hint and not a
 * verdict: the answer tells the model that the point holds another element.
 *
 * @param {string} token the token the caller named
 * @param {object|null} uia the state of the element under the point
 * @returns {boolean|null} true when nothing was named or the element matches,
 *   null when the UIA state is unknown (the element cannot be compared)
 */
/**
 * The three tiers of "what did the click do".
 *
 * - changed: the pixels around the point, or the UIA state of the element under
 *   it, moved: the click did exactly what it was aimed at.
 * - changed_elsewhere: neither moved, but the window as a whole changed: this may
 *   be the effect of the click landing somewhere else in the window (a status bar,
 *   a label next to the button). It counts as a success, not a reason to click again.
 * - unchanged: nothing moved at all: the click had no effect.

 * @param {object} before the reading taken before the click
 * @param {object} after the reading taken after the click
 * @returns {string} the tier
 */
export function classifyChange(before, after) {
  if (!before || !after) return VERIFICATION.UNCHANGED;
  if ((before.localHash || '') !== (after.localHash || '')) return VERIFICATION.CHANGED;
  if (before.uia != null && after.uia != null && uiaChanged(before.uia, after.uia)) {
    return VERIFICATION.CHANGED;
  }
  if ((before.windowHash || '') !== (after.windowHash || '')) return VERIFICATION.CHANGED_ELSEWHERE;
  return VERIFICATION.UNCHANGED;
}

export function elementMatches(token, uia) {
  if (!token) return true;
  // The UIA state is not readable: the element cannot be compared, and an
  // unknown element is NOT a mismatch.
  if (!uia) return null;
  const wanted = String(token).trim().toLowerCase();
  const name = typeof uia.name === 'string' ? uia.name.trim().toLowerCase() : '';
  const automationId = typeof uia.automationId === 'string' ? uia.automationId.trim().toLowerCase() : '';
  return wanted === name || wanted === automationId;
}

/**
 * Click one point and report what happened.
 *
 * @param {object} args the tool arguments
 * @param {object} backend the native side: probe, snapshot and click
 * @param {{settleMs?: number, radius?: number}} [options]
 * @returns {Promise<object>} the answer of the tool
 */
/**
 * What the tool knows about the element under the point.
 *
 * `known` says whether the UIA state could be read at all; `matched` is null
 * when it could not, because an unknown element is not a mismatch.
 *
 * @param {string} token the token the caller named
 * @param {object|null} uia the state of the element under the point
 * @returns {object} what is known about the element
 */
export function elementState(token, uia) {
  const matched = elementMatches(token, uia);
  return {
    token: typeof token === 'string' ? token : '',
    known: uia != null,
    matched: matched === null ? null : matched,
    name: uia?.name ?? '',
    automationId: uia?.automationId ?? '',
    rect: uia?.rect ?? null,
  };
}

/**
 * One attempt: what the point looked like before and after the click.
 *
 * The hash of the whole window is reported, but it never decides: only the
 * pixels around the point and the UIA state of the element under it do.
 *
 * @param {number} x the point of this attempt
 * @param {number} y the point of this attempt
 * @param {object} before the reading taken before the click
 * @param {object} after the reading taken after the click
 * @returns {object} the record of this attempt
 */
export function attemptOf(x, y, before, after) {
  return {
    x,
    y,
    verification: classifyChange(before, after),
    changed: snapshotChanged(before, after),
    localChanged: (before?.localHash || '') !== (after?.localHash || ''),
    uiaChanged: uiaChanged(before?.uia, after?.uia),
    windowChanged: (before?.windowHash || '') !== (after?.windowHash || ''),
  };
}
export async function runSnapClick(args, backend, options = {}) {
  const settleMs = Number.isFinite(options.settleMs) ? options.settleMs : 400;
  const hoverMs = Number.isFinite(options.hoverMs) ? options.hoverMs : 180;
  const radius = Number.isFinite(options.radius) ? options.radius : 24;
  const call = normalizeSnapClickArgs(args);
  const base = {
    ok: true,
    point: { x: call.x, y: call.y },
    elementToken: call.elementToken,
    expectChange: call.expectChange,
    target: null,
    coveredBy: null,
    attempts: [],
    retried: false,
    reconfirmed: false,
    targetIsForeground: true,
  };

  const probe = await backend.probe({ x: call.x, y: call.y, windowId: call.windowId });
  const target = probe.target ?? null;
  base.targetIsForeground = probe.targetIsForeground === true;

  // The window the caller named does not exist. The window that happens to be
  // on top is NOT a substitute: the click would land on the wrong window.
  if (probe.windowFound === false) {
    return {
      ...base,
      ok: false,
      target: null,
      clicked: false,
      verification: VERIFICATION.ERROR,
      code: WINDOW_NOT_FOUND,
      reason: call.windowId
        ? `点名的窗口《${call.windowId}》没有找到，没有点击`
        : '当前没有可用的前台窗口，没有点击',
    };
  }

  // Another window really is on top of the point, and the point is on the
  // target window too: that window covers the target.
  if (probe.covered) {
    const coverer = probe.coveredBy ?? null;
    return {
      ...base,
      target,
      clicked: false,
      verification: VERIFICATION.COVERED,
      code: POINT_COVERED,
      coveredBy: coverer,
      reason: `落点 (${call.x}, ${call.y}) 被《${coverer?.title || '未知窗口'}》挡住，没有点击`,
    };
  }

  // The point belongs to another window than the one the caller named (the
  // target is behind, or the point is simply not on it).
  if (probe.pointInTarget === false) {
    const top = probe.top ?? null;
    return {
      ...base,
      target,
      clicked: false,
      verification: VERIFICATION.ERROR,
      code: POINT_NOT_IN_TARGET,
      reason: `落点 (${call.x}, ${call.y}) 不在目标窗口《${target?.title || call.windowId || '当前前台窗口'}》上（该点属于《${top?.title || '未知窗口'}》），没有点击`,
    };
  }

  // The cursor goes to the point BEFORE the "before" reading: a hover that only
  // repaints the window must not look like the click changed something.
  await backend.hover({ x: call.x, y: call.y });
  await delay(hoverMs);
  // From here on the cursor already sits on the point: a refusal has to say so,
  // because the hover may already have painted something.
  base.cursorMoved = true;

  const before = await backend.snapshot({ x: call.x, y: call.y, radius, windowId: call.windowId });
  const element = elementState(call.elementToken, before.uia);

  // The element under the point is not the one the caller named: clicking would
  // hit the wrong control, so the click is refused.
  if (element.known && element.matched === false) {
    return {
      ...base,
      target,
      clicked: false,
      verification: VERIFICATION.ERROR,
      code: ELEMENT_MISMATCH,
      element,
      reason: `落点上的元素是《${element.name || element.automationId || '未知'}》，不是 element_token 说的那个，没有点击（光标已经移到落点，悬停可能已经触发）`,
    };
  }

  const click = await backend.click({ x: call.x, y: call.y, windowId: call.windowId, expectHandle: target?.handle ?? 0 });
  // Whether the point was confirmed to still belong to the target right
  // before the click: the answer says so, so a refusal is never silent.
  base.reconfirmed = click?.reconfirmed === true;
  if (click && click.ok === false) {
    // The window that owns the point changed between the probe and the click:
    // the click is refused instead of landing on whatever is there now.
    const code = click.code ?? POINT_COVERED;
    return {
      ...base,
      target,
      clicked: false,
      verification: code === POINT_COVERED ? VERIFICATION.COVERED : VERIFICATION.ERROR,
      code,
      coveredBy: click.coveredBy ?? null,
      element,
      reason: click.reason ?? `落点 (${call.x}, ${call.y}) 在点击前不再属于目标窗口，没有点击（光标已经移到落点，悬停可能已经触发）`,
    };
  }

  await delay(settleMs);
  const after = await backend.snapshot({ x: call.x, y: call.y, radius, windowId: call.windowId });
  const attempts = [attemptOf(call.x, call.y, before, after)];
  const first = attempts[0].verification;
  if (first === VERIFICATION.CHANGED || first === VERIFICATION.CHANGED_ELSEWHERE) {
    return {
      ...base,
      target,
      clicked: true,
      verification: first,
      code: "",
      attempts,
      element,
      reason: first === VERIFICATION.CHANGED
        ? `已点击 (${call.x}, ${call.y})，界面有变化`
        : `已点击 (${call.x}, ${call.y})，落点附近没变，但窗口别处变了（可能是这次点击的效果），不重试`,
    };
  }

  // Nothing changed. A target that is not idempotent is never clicked twice.
  if (call.expectChange !== EXPECT_CHANGE.IDEMPOTENT) {
    return {
      ...base,
      target,
      clicked: true,
      verification: VERIFICATION.UNCHANGED,
      code: "",
      attempts,
      element,
      reason: `已点击 (${call.x}, ${call.y})，界面没有变化；expect_change 不是 idempotent，所以没有重试`,
    };
  }

  // One retry, at most four pixels away from the first point, and inside the
  // element the caller named.
  const offset = chooseRetryOffset({ x: call.x, y: call.y, target, element });
  const rx = call.x + offset.dx;
  const ry = call.y + offset.dy;
  const retryProbe = await backend.probe({ x: rx, y: ry, windowId: call.windowId });
  if (retryProbe.covered || retryProbe.pointInTarget === false) {
    return {
      ...base,
      target,
      clicked: true,
      verification: VERIFICATION.UNCHANGED,
      code: "",
      coveredBy: retryProbe.coveredBy ?? null,
      attempts,
      element,
      reason: `已点击 (${call.x}, ${call.y})，界面没有变化；偏移后的落点不再属于目标窗口，没有再点`,
    };
  }

  await backend.hover({ x: rx, y: ry });
  await delay(hoverMs);
  const retryBefore = await backend.snapshot({ x: rx, y: ry, radius, windowId: call.windowId });
  const retryElement = elementState(call.elementToken, retryBefore.uia);
  if (retryElement.known && retryElement.matched === false) {
    return {
      ...base,
      target,
      clicked: true,
      verification: VERIFICATION.UNCHANGED,
      code: "",
      attempts,
      element: retryElement,
      reason: `已点击 (${call.x}, ${call.y})，界面没有变化；偏移后的落点上不是 element_token 说的那个元素，没有再点`,
    };
  }

  const retryClick = await backend.click({ x: rx, y: ry, windowId: call.windowId, expectHandle: target?.handle ?? 0 });
  if (retryClick && retryClick.ok === false) {
    return {
      ...base,
      target,
      clicked: true,
      verification: VERIFICATION.UNCHANGED,
      code: "",
      coveredBy: retryClick.coveredBy ?? null,
      attempts,
      element,
      reason: `已点击 (${call.x}, ${call.y})，界面没有变化；偏移后的落点在点击前不再属于目标窗口，没有再点`,
    };
  }

  await delay(settleMs);
  const retryAfter = await backend.snapshot({ x: rx, y: ry, radius, windowId: call.windowId });
  const retryTier = classifyChange(retryBefore, retryAfter);
  attempts.push(attemptOf(rx, ry, retryBefore, retryAfter));
  return {
    ...base,
    target,
    clicked: true,
    verification: retryTier,
    code: "",
    attempts,
    retried: true,
    retryOffset: offset,
    element,
    reason: retryTier === VERIFICATION.CHANGED
      ? `已点击 (${call.x}, ${call.y})，界面没有变化；在偏移 (${offset.dx}, ${offset.dy}) 处重试一次后，界面有变化`
      : (retryTier === VERIFICATION.CHANGED_ELSEWHERE
        ? `已点击 (${call.x}, ${call.y})，界面没有变化；在偏移 (${offset.dx}, ${offset.dy}) 处重试一次后，窗口别处变了（可能是这次点击的效果）`
        : `已点击 (${call.x}, ${call.y})，界面没有变化；在偏移 (${offset.dx}, ${offset.dy}) 处重试一次，仍然没有变化`),
  };
}
/**
 * The text the model reads.
 *
 * @param {object} result the answer of `runSnapClick`
 * @returns {string}
 */
/**
 * The lines that list what every step of a sequence did.
 *
 * @param {object} value the answer of `runSnapSequence`
 * @returns {string[]} the lines
 */
function stepLines(value) {
  const lines = [];
  if (Array.isArray(value.steps) && value.steps.length > 0) {
    lines.push('步骤：');
    for (const step of value.steps) {
      lines.push(`  ${step.index}. ${step.name || '(未命名)'} → ${step.verification}${step.code ? ` (${step.code})` : ''}`);
    }
  }
  return lines;
}

export function formatSnapClickResult(result) {
  const value = result && typeof result === 'object' ? result : {};
  if (value.verification === VERIFICATION.ERROR) {
    const lines = [`${value.code || 'ERROR'}：${value.reason ?? '这一次没有点击'}`];
    if (value.coveredBy) {
      lines.push(`挡住的窗口：${value.coveredBy.title || '(无标题)'}（handle ${value.coveredBy.handle ?? '?'}）`);
    }
    if (Array.isArray(value.candidates) && value.candidates.length > 0) {
      lines.push('候选（没有猜哪一个）：');
      for (const candidate of value.candidates) {
        const rect = candidate.rect ?? {};
        lines.push(`  《${candidate.name || '(无名字)'}》 相似度 ${candidate.similarity ?? 0} 位置 (${rect.x ?? 0}, ${rect.y ?? 0}) ${rect.width ?? 0}x${rect.height ?? 0} 层级 ${candidate.level ?? 0}`);
      }
    }
    lines.push(...stepLines(value));
    if (value.cursorMoved === true) {
      lines.push('这一次没有点击，但光标已经移到落点：悬停可能已经触发，界面也可能已经重绘过。');
    }
    return lines.join('\n');
  }
  if (value.verification === VERIFICATION.COVERED) {
    const coverer = value.coveredBy ?? {};
    return [
      `${POINT_COVERED}：${value.reason ?? '落点被挡住，没有点击'}`,
      `挡住的窗口：${coverer.title || '(无标题)'}（handle ${coverer.handle ?? '?'}）`,
      '这次没有点击：先把那个窗口让开，或者改点它上面的目标。',
    ].join('\n');
  }
  const lines = [`verification: ${value.verification ?? VERIFICATION.UNCHANGED}`];
  if (value.reason) lines.push(value.reason);
  if (value.target && value.targetIsForeground === false) {
    lines.push(`目标窗口《${value.target.title || '未知窗口'}》当前未激活（点的是它上面的那个点）。`);
  }
  if (value.reconfirmed === true) {
    lines.push('点击前又确认了一次落点仍属于目标窗口。');
  }
  const attempts = Array.isArray(value.attempts) ? value.attempts : [];
  if (attempts.length > 1) {
    const tierText = (attempt) => {
      if (attempt.verification === VERIFICATION.CHANGED) return '有变化';
      if (attempt.verification === VERIFICATION.CHANGED_ELSEWHERE) return '窗口别处变了';
      return '没变化';
    };
    lines.push(`点了 ${attempts.length} 次：${attempts.map((attempt) => `(${attempt.x}, ${attempt.y}) → ${tierText(attempt)}`).join('，')}`);
  }
  if (value.element && value.element.token && value.element.known && value.element.matched === false) {
    const name = value.element.name || value.element.automationId || '未知';
    lines.push(`落点上的元素是《${name}》，不是 element_token 说的那个`);
  }
  // The steps of a sequence are listed whether it succeeded or not: the
  // verdict of every step is part of the answer.
  lines.push(...stepLines(value));
  return lines.join('\n');
}

/**
 * The tool as the host registers it.
 *
 * @param {{backend: object, settleMs?: number}} options the native side
 * @returns {object} the tool definition
 */
export function snapClickTool({ backend, settleMs, platform = process.platform } = {}) {
  if (!backend || typeof backend.probe !== 'function') {
    throw new Error('cua_snap_click needs a backend that can probe, snapshot and click');
  }
  return {
    name: SNAP_CLICK_TOOL_NAME,
    description:
      '点一个屏幕坐标，并检查这次点击是否真的落到了目标上。'
      + '点之前先问系统这个点上最上层是哪个窗口：被别的窗口真挡住时不会点，返回 POINT_COVERED '
      + '和挡住它的窗口标题；点名的窗口找不到时返回 WINDOW_NOT_FOUND；落点不在点名的窗口上时返回 '
      + 'POINT_NOT_IN_TARGET（这时请把 window_id 写成你要点的那个窗口）。'
      + '想要遮挡保护就必须点名窗口：不给 window_id 时没有「你指定的窗口」，只能按落点所在的那扇窗判断。'
      + '点之后看落点附近的像素和落点元素的 UIA 状态：落点附近变了返回 changed；落点附近没变但整窗变了返回'
      + 'changed_elsewhere（窗口别处变了，可能是这次点击的效果，算成功、绝不重试）；哪儿都没变才返回 unchanged。'
      + '只有答案是 unchanged 且 expect_change=idempotent（重复点一次是安全的）时，才会在 4 像素内偏移重试一次。',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '目标点的屏幕横坐标（物理像素）' },
        y: { type: 'number', description: '目标点的屏幕纵坐标（物理像素）' },
        window_id: {
          type: 'string',
          description: '可选：目标窗口。填窗口句柄（十进制或 0x 十六进制）或窗口标题的一段；不填就用落点下面那扇窗。想要遮挡保护（判断落点是不是被别的窗口挡住）就必须点名窗口。',
        },
        element_token: {
          type: 'string',
          description: '可选：快照里的元素标记。填了就会核对落点上的元素是不是它，不一致会在结果里说明。',
        },
        element_id: {
          type: 'string',
          description: '可选：读界面时拿到的元素 ID。填了就按 ID 精确操作（同名控件也分得清），ID 失效会返回 ELEMENT_ID_EXPIRED，不会静默改成按名字猜。',
        },
        expect_change: {
          type: 'string',
          enum: [...EXPECT_CHANGE_VALUES],
          description: '点完之后界面应该怎么变：idempotent（会变，且重复点安全）、non_idempotent（会变，但重复点不安全，不重试）、none（这一步本来就不该变：只看有没有被拒、有没有点得下去，不看变化）。默认 non_idempotent。',
        },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: formatSnapClickResult(value) }];
      },
    },
    async execute(args) {
      // The native half is Windows-only, so the tool says so plainly instead
      // of failing with a puzzling error.
      if (platform !== 'win32') {
        throw new Error(`cua_snap_click 只支持 Windows（当前平台：${platform}）`);
      }
      return await runSnapClick(args, backend, { settleMs });
    },
  };
}

/**
 * The native side: one long-lived helper process that answers the questions
 * about the screen.
 *
 * The request travels over stdin and the answer comes back over stdout, so
 * the command line of the helper stays constant and nothing the model says can
 * become a command.
 *
 * @param {{logger?: (message: string) => void}} [options]
 * @returns {object} the backend: probe, snapshot, click and close
 */
export function createWindowsBackend(options = {}) {
  const log = typeof options.logger === 'function' ? options.logger : () => {};
  let child = null;
  let starting = null;
  let buffer = '';
  let diagnostics = '';
  let nextId = 0;
  /** The requests that are still waiting for their answer, in the order they were sent. */
  const waiters = [];

  function start() {
    if (child !== null) return Promise.resolve();
    if (starting !== null) return starting;
    starting = new Promise((resolve) => {
      const args = [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
        '-File', helperScript,
      ];
      const proc = spawn('powershell.exe', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      child = proc;
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk) => {
        diagnostics = (diagnostics + chunk).slice(-2000);
        log(`snap-click helper: ${String(chunk).trim()}`);
      });
      proc.stdout.on('data', (chunk) => {
        buffer += chunk;
        for (;;) {
          const at = buffer.indexOf('\n');
          if (at < 0) break;
          const line = buffer.slice(0, at).trim();
          buffer = buffer.slice(at + 1);
          if (!line) continue;
          const waiter = takeWaiter(idOf(line));
          if (!waiter) continue;
          clearTimeout(waiter.timer);
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            waiter.reject(new Error(`the snap-click helper answered something that is not JSON: ${line.slice(0, 200)}`));
            continue;
          }
          waiter.resolve(message);
        }
      });
      const died = (error) => {
        if (child === proc) child = null;
        const failure = error ?? new Error(`the snap-click helper exited${diagnostics ? `: ${diagnostics.trim()}` : ''}`);
        for (const waiter of waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(failure);
        }
        resolve();
      };
      proc.once('error', died);
      proc.once('exit', () => died());
      proc.stdin.on('error', () => {});
      resolve();
    }).finally(() => { starting = null; });
    return starting;
  }

  /** The id the helper put in its answer, when there is one. */
  function idOf(line) {
    try {
      const message = JSON.parse(line);
      return message && message.id !== undefined ? message.id : null;
    } catch {
      return null;
    }
  }

  /** The waiter that owns an answer: the one with the same id, else the oldest. */
  function takeWaiter(id) {
    if (id !== null && id !== undefined) {
      const index = waiters.findIndex((waiter) => waiter.id === id);
      if (index >= 0) return waiters.splice(index, 1)[0];
    }
    return waiters.shift() ?? null;
  }

  async function send(command, payload) {
    await start();
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const request = { ...payload, id, command };
      const waiter = { id, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`the snap-click helper did not answer "${command}" in time`));
      }, 20000);
      waiters.push(waiter);
      child.stdin.write(JSON.stringify(request) + '\n', (error) => {
        if (!error) return;
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        reject(error);
      });
    });
  }

  return {
    async probe({ x, y, windowId }) {
      const answer = await send('probe', { x, y, windowId: windowId ?? '' });
      return {
        covered: answer.covered === true,
        coveredBy: answer.coveredBy ?? null,
        target: answer.target ?? null,
        top: answer.top ?? null,
        point: answer.point ?? { x, y },
        // The native side says whether the named window was found at all,
        // whether the point is on it, and whether it is the active one.
        windowFound: answer.windowFound !== false,
        pointInTarget: answer.pointInTarget !== false,
        targetIsForeground: answer.targetIsForeground === true,
      };
    },
    async snapshot({ x, y, radius, windowId }) {
      const answer = await send('snapshot', { x, y, radius, windowId: windowId ?? '' });
      return {
        windowHash: answer.windowHash ?? '',
        localHash: answer.localHash ?? '',
        uia: answer.uia ?? null,
        window: answer.window ?? null,
      };
    },
    async find({ name, windowId }) {
      // The controls of a window whose accessible name matches. The native
      // side lists them; picking one is done here, never here.

      const answer = await send('find', { name: name ?? '', windowId: windowId ?? '' });
      return {
        candidates: Array.isArray(answer?.candidates) ? answer.candidates : [],
        windowFound: answer?.windowFound !== false,
        target: answer?.target ?? null,
        // The native side reports what went wrong instead of answering with an
        // empty list: the caller has to be able to tell "no such control" from
        // "the lookup failed".
        error: answer?.error ?? null,
        // ready: the window has its content. starting: the process has not
        // built its tree yet, and "the control is not there" would be a lie.
        webContent: answer?.webContent ?? 'ready',
      };
    },
    async invoke({ elementId }) {
      // Run a control by its id: in the background when it supports it.
      const answer = await send('invoke', { elementId: elementId ?? '' });
      return {
        ok: answer?.ok === true,
        canInvoke: answer?.canInvoke === true,
        expired: answer?.code === 'ELEMENT_ID_EXPIRED',
        manner: answer?.manner ?? 'point',
        name: answer?.name ?? '',
        rect: answer?.rect ?? null,
        offscreen: answer?.offscreen === true,
        error: answer?.error ?? null,
      };
    },
    async hover({ x, y }) {
      // The cursor goes to the point BEFORE the "before" reading: a hover that
      // only repaints must not look like the click changed something.
      return await send('hover', { x, y });
    },
    async click({ x, y, windowId, expectHandle }) {
      return await send('click', { x, y, windowId: windowId ?? '', expectHandle: expectHandle ?? 0 });
    },
    async close() {
      const proc = child;
      child = null;
      if (proc === null) return;
      try {
        proc.stdin.write(JSON.stringify({ id: ++nextId, command: 'shutdown' }) + '\n');
      } catch { /* already gone */ }
      const force = setTimeout(() => { if (proc.exitCode === null) proc.kill(); }, 1000);
      force.unref?.();
    },
  };
}

/**
 * The codes the name-based tools answer with.
 *
 * AMBIGUOUS_TARGET: the name matches more than one control, so NOTHING is
 * clicked: the candidates are listed and the caller decides.
 * TARGET_NOT_FOUND: no control carries that name.
 * TOO_MANY_STEPS: the caller asked for more steps than the tool walks.
 */
export const AMBIGUOUS_TARGET = 'AMBIGUOUS_TARGET';
export const TARGET_NOT_FOUND = 'TARGET_NOT_FOUND';
export const TOO_MANY_STEPS = 'TOO_MANY_STEPS';
export const NOT_VISIBLE = 'NOT_VISIBLE';
export const ELEMENT_ID_EXPIRED = 'ELEMENT_ID_EXPIRED';
export const WAIT_TIMEOUT = 'WAIT_TIMEOUT';

/// How long a window that is not ready yet is read again.
const ReadyWaitMs = 1500;

/// A short pause between two readings.
const waitMs = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The most steps one call may walk. */
export const MAX_SEQUENCE_STEPS = 5;

/**
 * How close a candidate name is to the name the caller asked for.
 *
 * 1 means the names are the same (ignoring case and spaces), 0.8 means one
 * name contains the other, anything lower is the share of the common
 * prefix. It only tells the caller how close each candidate is: the tool
 * never uses it to pick one.
 *
 * @param {string} wanted the name the caller asked for
 * @param {string} actual the name of a candidate
 * @returns {number} between 0 and 1
 */
export function nameSimilarity(wanted, actual) {
  // The decoration is dropped first: a name that only differs by emoji or
  // by brackets is the same name.
  const a = normalizeName(wanted);
  const b = normalizeName(actual);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.8;
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common += 1;
  return Math.round((common / Math.max(a.length, b.length)) * 100) / 100;
}

/**
 * Find the controls of a window by their accessible name.
 *
 * Three answers: `unique` (exactly one control), `ambiguous` (more than
 * one, so nothing is clicked) and `not_found`.
 *
 * @param {{name: string, windowId?: string}} request the name and the window
 * @param {object} backend the native side
 * @returns {Promise<{status: string, target: object|null, candidates: object[]}>}
 */
/**
 * The name without its decoration.
 *
 * Emoji, symbols, the text in brackets and the extra spaces are dropped and
 * the case is ignored: "📥 下载花名册（全部人员）" becomes "下载花名册", so the
 * wanted name finds the control whatever it is decorated with.
 *
 * @param {string} text the name
 * @returns {string} the plain name
 */
export function normalizeName(text) {
  return String(text ?? '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{20E3}]/gu, ' ')
    .replace(/[(（\[【][^)）\]】]*/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

/**
 * How well a name matches the wanted one.
 *
 * Three levels: `exact` (the plain names are equal), `contains` (one of them
 * holds the other) and `word` (they only share a beginning). The best level
 * wins: a name that is exactly the wanted one is never mixed with a name that
 * merely contains it.
 *
 * @param {string} wanted the wanted name
 * @param {string} actual the name of the control
 * @returns {string} exact, contains, word or none
 */
export function matchKind(wanted, actual) {
  const a = normalizeName(wanted);
  const b = normalizeName(actual);
  if (!a || !b) return 'none';
  if (a === b) return 'exact';
  if (a.includes(b) || b.includes(a)) return 'contains';
  return 'word';
}

export async function resolveNamedTarget({ name, windowId }, backend) {
  const wanted = String(name ?? '').trim();
  // The content of a window that draws itself may still be on its way: while
  // it is not ready, "the control is not there" would be a lie. So the window is
  // read again for a moment before the name is looked for.
  const deadline = Date.now() + ReadyWaitMs;
  let answer = null;
  for (;;) {
    answer = await backend.find({ name: wanted, windowId: windowId ?? '' });
    if (answer?.webContent !== 'starting') break;
    if (Date.now() >= deadline) break;
    await waitMs(200);
  }
  const raw = Array.isArray(answer?.candidates) ? answer.candidates : [];
  const error = answer?.error ?? null;
  // The window itself can be missing: that is not the same answer as
  // "the window is there, but it has no control with that name".
  const windowFound = answer?.windowFound !== false;
  const scored = raw.map((candidate) => ({
    name: candidate.name ?? '',
    automationId: candidate.automationId ?? '',
    controlType: candidate.controlType ?? '',
    level: Number.isFinite(candidate.level) ? candidate.level : 0,
    rect: candidate.rect ?? null,
    // A control that is off the screen cannot be clicked: the caller has to
    // scroll to it first.
    offscreen: candidate.offscreen === true,
    match: matchKind(wanted, candidate.name ?? ''),
    similarity: nameSimilarity(wanted, candidate.name ?? ''),
  }));
  if (!windowFound) return { status: 'window_not_found', target: null, candidates: [], error };
  if (answer?.webContent === 'starting') {
    // The window has not built its content yet: that is not the same as
    // "the control is not there".
    return { status: 'not_ready', target: null, candidates: [], error: answer?.error ?? null };
  }
  const order = { exact: 0, contains: 1, word: 2 };
  const matched = scored.filter((candidate) => candidate.match !== 'none');
  if (matched.length === 0) return { status: 'not_found', target: null, candidates: [], error };
  // Only the best level counts: a name that is exactly the wanted one is not
  // mixed with the names that merely hold it.
  const best = matched.reduce(
    (kind, candidate) => (order[candidate.match] < order[kind] ? candidate.match : kind),
    matched[0].match,
  );
  const candidates = matched.filter((candidate) => candidate.match === best);
  const visible = candidates.filter((candidate) => !candidate.offscreen);
  if (visible.length === 1) return { status: 'unique', target: visible[0], candidates, error };
  if (visible.length > 1) return { status: 'ambiguous', target: null, candidates: visible, error };
  // Every match is off the screen: the caller has to scroll first.
  return { status: 'not_visible', target: null, candidates, error };
}

/**
 * Click the control that carries the given name.
 *
 * The name must hit exactly ONE control: when it hits more, nothing is
 * clicked and the candidates are reported, because guessing is worse than
 * stopping. The click itself is the same click as cua_snap_click: the same
 * cover check, the same three tiers, the same retry rule.
 *
 * @param {object} args name, window_id, element_token, expect_change
 * @param {object} backend the native side
 * @param {object} [options] settleMs and radius
 * @returns {Promise<object>} the answer of the tool
 */
/**
 * Run a control by its id.
 *
 * The id comes from a reading of the window: it tells two controls with the
 * same name apart. When the control supports the invoke pattern it runs in
 * the background: the mouse does not move and the window does not come to the
 * front. Otherwise it is clicked by its point, the same click as
 * cua_snap_click, with the same cover check and the same three tiers.
 *
 * @param {object} args element_id, window_id, element_token, expect_change
 * @param {object} backend the native side
 * @param {object} [options] settleMs and radius
 * @returns {Promise<object>} the answer of the tool
 */
export async function runElementSnapClick(args, backend, options = {}) {
  const elementId = String(args?.element_id ?? args?.elementId ?? '').trim();
  const answer = await backend.invoke({ elementId });
  if (answer?.expired) {
    // The id is gone: the window was read again. It is not silently turned
    // into a guess by name.
    return {
      verification: VERIFICATION.ERROR,
      code: ELEMENT_ID_EXPIRED,
      clicked: false,
      elementId,
      name: '',
      unique: false,
      candidates: [],
      reason: `element_id ${elementId} 已经失效（界面被重读过）：重新读一次界面、拿到新的 ID 再操作，没有点击`,
    };
  }
  if (answer?.canInvoke) {
    // The control ran in the background: the mouse stayed where it was.
    return {
      verification: VERIFICATION.CHANGED,
      code: '',
      clicked: true,
      manner: 'invoke',
      elementId,
      name: answer?.name ?? '',
      rect: answer?.rect ?? null,
      unique: true,
      matchedBy: 'element_id',
      reason: `按 element_id ${elementId} 在后台运行了控件（InvokePattern），鼠标没有移动；这一步没有做像素比对`,
    };
  }
  // A control that is off the screen cannot be clicked: the same rule as the
  // path that looks the control up by name - the caller has to scroll to it
  // first.
  if (answer?.offscreen === true) {
    return {
      verification: VERIFICATION.ERROR,
      code: NOT_VISIBLE,
      clicked: false,
      elementId,
      name: answer?.name ?? '',
      rect: answer?.rect ?? null,
      unique: false,
      candidates: [],
      reason: `element_id ${elementId} 指向的控件在屏幕外：先滚动到它再点，没有点击`,
    };
  }
  // The control does not support the invoke pattern: it is clicked by its
  // point, with the same rules as any other click.
  const rect = answer?.rect ?? {};
  const x = Math.round(Number(rect.x ?? 0) + Number(rect.width ?? 0) / 2);
  const y = Math.round(Number(rect.y ?? 0) + Number(rect.height ?? 0) / 2);
  const result = await runSnapClick({
    x,
    y,
    window_id: args?.window_id ?? args?.windowId ?? '',
    element_token: args?.element_token,
    expect_change: args?.expect_change,
  }, backend, options);
  return {
    ...result,
    manner: 'point',
    elementId,
    name: answer?.name ?? '',
    rect,
    matchedBy: 'element_id',
    clickedAt: { x, y },
  };
}

export async function runNamedSnapClick(args, backend, options = {}) {
  const wanted = String(args?.name ?? '').trim();
  const elementId = String(args?.element_id ?? args?.elementId ?? '').trim();
  if (!wanted && !elementId) {
    return {
      verification: VERIFICATION.ERROR,
      code: 'MISSING_NAME',
      clicked: false,
      name: wanted,
      unique: false,
      candidates: [],
      reason: '没有给出控件的名字，也没有给出 element_id，没有点击',
    };
  }
  if (elementId) {
    return await runElementSnapClick(args, backend, options);
  }
  const windowId = args?.window_id ?? args?.windowId ?? '';
  const resolved = await resolveNamedTarget({ name: wanted, windowId }, backend);
  if (resolved.status === 'window_not_found') {
    return {
      verification: VERIFICATION.ERROR,
      code: WINDOW_NOT_FOUND,
      clicked: false,
      name: wanted,
      unique: false,
      candidates: [],
      error: resolved.error ?? null,
      reason: windowId
        ? `点名的窗口《${windowId}》没有找到，没有点击`
        : '没有找到可用的目标窗口，没有点击',
    };
  }
  if (resolved.status === 'not_found') {
    return {
      verification: VERIFICATION.ERROR,
      code: TARGET_NOT_FOUND,
      clicked: false,
      name: wanted,
      unique: false,
      candidates: [],
      error: resolved.error ?? null,
      reason: resolved.error
        ? `按名字找《${wanted}》失败：${resolved.error}`
        : `窗口里没有叫《${wanted}》的控件，没有点击`,
    };
  }
  if (resolved.status === 'not_visible') {
    return {
      verification: VERIFICATION.ERROR,
      code: NOT_VISIBLE,
      clicked: false,
      name: wanted,
      unique: false,
      candidates: resolved.candidates,
      reason: `《${wanted}》在屏幕上找不到：它现在在屏幕外，先滚动到它再点，没有点击`,
    };
  }
  if (resolved.status === 'ambiguous') {
    return {
      verification: VERIFICATION.ERROR,
      code: AMBIGUOUS_TARGET,
      clicked: false,
      name: wanted,
      unique: false,
      candidates: resolved.candidates,
      reason: `有 ${resolved.candidates.length} 个控件叫《${wanted}》，不猜哪一个，没有点击`,
    };
  }
  const target = resolved.target;
  const rect = target.rect ?? {};
  const x = Math.round(Number(rect.x ?? 0) + Number(rect.width ?? 0) / 2);
  const y = Math.round(Number(rect.y ?? 0) + Number(rect.height ?? 0) / 2);
  const result = await runSnapClick({
    x,
    y,
    window_id: windowId,
    element_token: args?.element_token,
    expect_change: args?.expect_change,
  }, backend, options);
  return { ...result, name: target.name, unique: true, rect, matchedBy: 'name', clickedAt: { x, y } };
}

/**
 * Walk a short list of names, one after the other.
 *
 * At most MAX_SEQUENCE_STEPS steps. Every step is checked with the same
 * three tiers the single click uses: `changed` and `changed_elsewhere` are a
 * success and the walk continues, anything else stops the walk right there.
 * The steps after the failed one are NOT executed.
 *
 * @param {object} args steps, window_id, expect_change
 * @param {object} backend the native side
 * @param {object} [options] settleMs and radius
 * @returns {Promise<object>} the answer of the tool
 */
export async function runSnapSequence(args, backend, options = {}) {
  const rawSteps = Array.isArray(args?.steps) ? args.steps : [];
  const windowId = args?.window_id ?? args?.windowId ?? '';
  const defaultExpect = args?.expect_change;
  if (rawSteps.length === 0) {
    return {
      verification: VERIFICATION.ERROR,
      code: 'NO_STEPS',
      clicked: false,
      steps: [],
      executed: 0,
      stoppedAt: null,
      skipped: 0,
      reason: '没有给出任何步骤，没有执行',
    };
  }
  if (rawSteps.length > MAX_SEQUENCE_STEPS) {
    return {
      verification: VERIFICATION.ERROR,
      code: TOO_MANY_STEPS,
      clicked: false,
      steps: [],
      executed: 0,
      stoppedAt: null,
      skipped: rawSteps.length,
      reason: `最多 ${MAX_SEQUENCE_STEPS} 步，给了 ${rawSteps.length} 步，一步都没有执行`,
    };
  }
  const steps = [];
  for (let index = 0; index < rawSteps.length; index += 1) {
    const step = rawSteps[index] ?? {};
    const stepName = String(step.name ?? '').trim();
    const expect = step.expect_change ?? defaultExpect ?? EXPECT_CHANGE.NON_IDEMPOTENT;
    const result = await runNamedSnapClick({
      name: stepName,
      window_id: step.window_id ?? windowId,
      element_token: step.element_token,
      expect_change: step.expect_change ?? defaultExpect,
    }, backend, options);
    steps.push({ index: index + 1, name: stepName, expect_change: expect, ...result });
    const succeeded = result.verification === VERIFICATION.CHANGED
      || result.verification === VERIFICATION.CHANGED_ELSEWHERE
      || (expect === EXPECT_CHANGE.NONE && result.verification === VERIFICATION.UNCHANGED);
    if (!succeeded) {
      return {
        verification: VERIFICATION.ERROR,
        code: result.code || 'STEP_FAILED',
        clicked: steps.some((entry) => entry.clicked === true),
        steps,
        executed: steps.length,
        stoppedAt: index + 1,
        skipped: rawSteps.length - steps.length,
        reason: `第 ${index + 1} 步（${stepName || '未命名'}）没有成功：${result.reason ?? '未知原因'}；后面的 ${rawSteps.length - steps.length} 步没有执行`,
      };
    }
  }
  // The verdict of the whole walk is the verdict of its steps: a walk whose
  // steps all changed somewhere else says so, instead of claiming a change
  // right at the point.
  const overall = steps.some((entry) => entry.verification === VERIFICATION.CHANGED)
    ? VERIFICATION.CHANGED
    : (steps.some((entry) => entry.verification === VERIFICATION.CHANGED_ELSEWHERE)
      ? VERIFICATION.CHANGED_ELSEWHERE
      : VERIFICATION.UNCHANGED);
  return {
    verification: overall,
    code: '',
    clicked: true,
    steps,
    executed: steps.length,
    stoppedAt: null,
    skipped: 0,
    reason: `按顺序执行了 ${steps.length} 步，每一步都点到了`,
  };
}

/**
 * The tool that clicks a control by its name.
 *
 * @param {{backend: object, settleMs?: number}} options the native side
 * @returns {object} the tool definition
 */
/**
 * Wait for a control with a given name to show up.
 *
 * This is what a caller needs after a click that opens something: the control
 * showing up is a better sign than the pixels changing. When the control does
 * not show up in time, the answer says that it timed out.
 *
 * @param {object} args name, window_id, timeout_ms
 * @param {object} backend the native side
 * @returns {Promise<object>} the answer of the tool
 */
export async function runSnapWaitFor(args, backend) {
  const wanted = String(args?.name ?? '').trim();
  const timeoutMs = Number.isFinite(args?.timeout_ms) ? Math.max(0, Number(args.timeout_ms)) : 5000;
  const windowId = args?.window_id ?? args?.windowId ?? '';
  if (!wanted) {
    return {
      verification: VERIFICATION.ERROR,
      code: 'MISSING_NAME',
      found: false,
      clicked: false,
      name: wanted,
      candidates: [],
      reason: '没有给出要等的名字',
    };
  }
  const deadline = Date.now() + timeoutMs;
  let resolved = null;
  for (;;) {
    resolved = await resolveNamedTarget({ name: wanted, windowId }, backend);
    const visible = (resolved.candidates ?? []).filter((candidate) => !candidate.offscreen);
    if (visible.length > 0) {
      return {
        verification: VERIFICATION.CHANGED,
        code: '',
        found: true,
        clicked: false,
        name: wanted,
        candidates: resolved.candidates,
        reason: `《${wanted}》出现了（屏幕上有 ${visible.length} 个）`,
      };
    }
    if (Date.now() >= deadline) {
      return {
        verification: VERIFICATION.ERROR,
        code: WAIT_TIMEOUT,
        found: false,
        clicked: false,
        name: wanted,
        candidates: resolved.candidates ?? [],
        timeoutMs,
        reason: `等了 ${timeoutMs} 毫秒，《${wanted}》没有出现在屏幕上`,
      };
    }
    await waitMs(200);
  }
}

/**
 * The text of a wait.
 *
 * @param {object} value the answer of `runSnapWaitFor`
 * @returns {string}
 */
export function formatWaitForResult(value) {
  const v = value && typeof value === 'object' ? value : {};
  const lines = [`${v.found ? 'FOUND' : (v.code || 'NOT_FOUND')}：${v.reason ?? ''}`];
  for (const candidate of v.candidates ?? []) {
    const rect = candidate.rect ?? {};
    lines.push(`  《${candidate.name || '(无名字)'}》 位置 (${rect.x ?? 0}, ${rect.y ?? 0}) ${rect.width ?? 0}x${rect.height ?? 0}${candidate.offscreen ? ' 屏幕外' : ''}`);
  }
  return lines.join('\n');
}


/**
 * The tool that waits for a control to show up.
 *
 * @param {{backend: object}} options the native side
 * @returns {object} the tool definition
 */
export function snapWaitForTool({ backend, platform = process.platform } = {}) {
  if (!backend || typeof backend.find !== 'function') {
    throw new Error('cua_snap_wait_for needs a backend that can find controls by name');
  }
  return {
    name: 'cua_snap_wait_for',
    description: `等某个名字的控件出现在屏幕上。点完东西等界面变化时用它比像素比对可靠：控件出现就算成功，等到超时还没出现就如实报 WAIT_TIMEOUT。名字的匹配规则和 cua_snap_click_named 一样：去掉表情、符号和括号里的内容再比对。`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要等的控件的可访问名字' },
        window_id: { type: 'string', description: '可选：目标窗口（句柄或标题的一段）。' },
        timeout_ms: { type: 'integer', description: '最多等多少毫秒，默认 5000。' },
      },
      required: ['name'],
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: formatWaitForResult(value) }];
      },
    },
    async execute(args) {
      if (platform !== 'win32') {
        throw new Error(`cua_snap_wait_for 只支持 Windows（当前平台：${platform}）`);
      }
      return await runSnapWaitFor(args, backend);
    },
  };
}

export function snapClickNamedTool({ backend, settleMs, platform = process.platform } = {}) {
  if (!backend || typeof backend.find !== 'function') {
    throw new Error('cua_snap_click_named needs a backend that can find controls by name');
  }
  return {
    name: 'cua_snap_click_named',
    description: `按控件的文字名找它并点击。名字必须只命中一个控件：命中多个时不会点，返回 AMBIGUOUS_TARGET 和候选清单（名字、位置、相似度），绝不猜；一个都没命中时返回 TARGET_NOT_FOUND；点名的窗口本身找不到时返回 WINDOW_NOT_FOUND。名字会去掉表情、符号和括号里的内容再比对，所以「下载花名册」能命中「📥 下载花名册（全部人员）」；命中的控件都在屏幕外时返回 NOT_VISIBLE（先滚动到它，不会点）。点击本身和 cua_snap_click 一样：先查遮挡（被挡就返回 POINT_COVERED，不点），点后按三档判定（changed / changed_elsewhere / unchanged），只有 expect_change=idempotent 且答案是 unchanged 时才偏移重试一次。想要遮挡保护就必须点名窗口（window_id）：不填时没有「你指定的窗口」。`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '控件的可访问名字（按钮上的文字、菜单项的名字等）' },
        window_id: {
          type: 'string',
          description: '可选：目标窗口。填窗口句柄（十进制或 0x 十六进制）或窗口标题的一段；不填就用落点下面那扇窗。想要遮挡保护（判断落点是不是被别的窗口挡住）就必须点名窗口。',
        },
        element_token: {
          type: 'string',
          description: '可选：快照里的元素标记。填了就会核对落点上的元素是不是它，不一致会在结果里说明。',
        },
        expect_change: {
          type: 'string',
          enum: [...EXPECT_CHANGE_VALUES],
          description: '点完之后界面应该怎么变：idempotent（会变，且重复点安全）、non_idempotent（会变，但重复点不安全，不重试）、none（这一步本来就不该变：只看有没有被拒、有没有点得下去，不看变化）。默认 non_idempotent。',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: formatSnapClickResult(value) }];
      },
    },
    async execute(args) {
      if (platform !== 'win32') {
        throw new Error(`cua_snap_click_named 只支持 Windows（当前平台：${platform}）`);
      }
      return await runNamedSnapClick(args, backend, { settleMs });
    },
  };
}

/**
 * The tool that walks a short list of names.
 *
 * @param {{backend: object, settleMs?: number}} options the native side
 * @returns {object} the tool definition
 */
export function snapSequenceTool({ backend, settleMs, platform = process.platform } = {}) {
  if (!backend || typeof backend.find !== 'function') {
    throw new Error('cua_snap_sequence needs a backend that can find controls by name');
  }
  return {
    name: 'cua_snap_sequence',
    description: `按顺序点一串控件，每一步都按名字找、点，并用和 cua_snap_click 一样的三档判定校验。最多 5 步：超过就不执行。每一步成功（changed 或 changed_elsewhere）才走下一步；任一步失败（找不到、同名多个、被挡、没变化）立刻停住，结果里说明停在第几步、后面的步骤没有执行。结果里的 verification 是整串的档位（每一步都是 changed_elsewhere 就是 changed_elsewhere），每一步的判定也会逐条列出来。非幂等目标（默认）不会重试。想要遮挡保护就必须点名窗口（window_id）。`,
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          maxItems: MAX_SEQUENCE_STEPS,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '这一步要点��控件的名字' },
              expect_change: { type: 'string', enum: [...EXPECT_CHANGE_VALUES], description: '这一步点完界面应该怎么变，默认跟整体一样。' },
            },
            required: ['name'],
            additionalProperties: false,
          },
          description: `按顺序执行的控件名字，最多 ${MAX_SEQUENCE_STEPS} 步。`,
        },
        window_id: {
          type: 'string',
          description: '可选：目标窗口。填窗口句柄（十进制或 0x 十六进制）或窗口标题的一段；不填就用落点下面那扇窗。想要遮挡保护（判断落点是不是被别的窗口挡住）就必须点名窗口。',
        },
        expect_change: {
          type: 'string',
          enum: [...EXPECT_CHANGE_VALUES],
          description: '每一步点完之后界面应该怎么变：idempotent（会变，且重复点安全）、non_idempotent（会变，但重复点不安全，不重试）、none（这一步本来就不该变：只看有没有被拒、有没有点得下去，不看变化）。默认 non_idempotent。',
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: formatSnapClickResult(value) }];
      },
    },
    async execute(args) {
      if (platform !== 'win32') {
        throw new Error(`cua_snap_sequence 只支持 Windows（当前平台：${platform}）`);
      }
      return await runSnapSequence(args, backend, { settleMs });
    },
  };
}
