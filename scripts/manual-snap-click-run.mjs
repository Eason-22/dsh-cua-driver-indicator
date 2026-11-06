/**
 * Drive the real-machine scenario of scripts/manual-snap-click-scenario.ps1.

 * The scenario script starts two real windows and writes the points it printed
 * into a JSON file; this script clicks those points with the real native helper
 * and prints what the tool answered.

 * Usage:
 *   1. powershell -NoProfile -STA -ExecutionPolicy Bypass -File scripts/manual-snap-click-scenario.ps1
 *   2. node scripts/manual-snap-click-run.mjs

 * The geometry path can be given with SNAP_CLICK_GEOMETRY.

 * @module scripts/manual-snap-click-run
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWindowsBackend,
  formatSnapClickResult,
  runNamedSnapClick,
  runSnapClick,
  runSnapSequence,
} from '../lib/snap-click.mjs';

const geometryPath = process.env.SNAP_CLICK_GEOMETRY ?? join(tmpdir(), 'snap-click-geometry.json');
const geometry = JSON.parse(readFileSync(geometryPath, 'utf8'));
const backend = createWindowsBackend();

/** Print what the tool answered, in full. */
function show(title, result) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify({
    verification: result.verification,
    code: result.code,
    clicked: result.clicked,
    retried: result.retried,
    retryOffset: result.retryOffset ?? null,
    coveredBy: result.coveredBy?.title ?? null,
    target: result.target?.title ?? null,
    targetIsForeground: result.targetIsForeground,
    reconfirmed: result.reconfirmed,
    attempts: result.attempts,
  }, null, 2));
  console.log(formatSnapClickResult(result));
}

const one = await runSnapClick(
  { x: geometry.covered.x, y: geometry.covered.y, window_id: geometry.targetTitle },
  backend,
);
show('1. the point is covered by another window', one);

const two = await runSnapClick(
  { x: geometry.button.x, y: geometry.button.y, window_id: geometry.targetTitle, expect_change: 'idempotent' },
  backend,
);
show('2. the click works, but the change lands elsewhere in the window', two);

const twoB = await runSnapClick(
  { x: geometry.paint.x, y: geometry.paint.y, window_id: geometry.targetTitle, expect_change: 'idempotent' },
  backend,
);
show('2b. the click repaints the pixels right at the point', twoB);

const twoC = await runSnapClick(
  { x: geometry.far.x, y: geometry.far.y, window_id: geometry.targetTitle, expect_change: 'idempotent' },
  backend,
);
show('2c. the click works, the change lands far away in the same window', twoC);

const three = await runSnapClick(
  { x: geometry.static.x, y: geometry.static.y, window_id: geometry.targetTitle, expect_change: 'idempotent' },
  backend,
);
show('3. nothing changes: one retry, still nothing', three);

const four = await runSnapClick(
  { x: geometry.hover.x, y: geometry.hover.y, window_id: geometry.targetTitle, expect_change: 'idempotent' },
  backend,
);
show('4. the hover repaints but the click does nothing', four);

// The same point without the hover step: what the tool used to answer, side by side.
const withoutHover = { ...backend, async hover() { return { ok: true }; } };
const old = await runSnapClick(
  { x: geometry.hover.x, y: geometry.hover.y, window_id: geometry.targetTitle, expect_change: 'idempotent' },
  withoutHover,
);
console.log('\n=== 4b. the same point WITHOUT the hover step (the old behaviour) ===');
console.log(JSON.stringify({
  verification: old.verification,
  code: old.code,
  clicked: old.clicked,
  retried: old.retried,
  attempts: old.attempts,
}, null, 2));

const missing = await runSnapClick(
  { x: geometry.button.x, y: geometry.button.y, window_id: '并不存在的窗口' },
  backend,
);
show('5. a window that does not exist', missing);

const duplicate = await runNamedSnapClick(
  { name: geometry.namedTargets.duplicate, window_id: geometry.targetTitle },
  backend,
);
show('6. the same name twice: nothing is clicked', duplicate);

const unique = await runNamedSnapClick(
  { name: '改变', window_id: geometry.targetTitle, expect_change: 'idempotent' },
  backend,
);
show('7. the name hits one control: it is clicked', unique);

const chain = await runSnapSequence(
  {
    window_id: geometry.targetTitle,
    steps: geometry.namedTargets.chain.map((name) => ({ name, expect_change: 'idempotent' })),
  },
  backend,
);
show('8. three steps in a row', chain);

await backend.close();
