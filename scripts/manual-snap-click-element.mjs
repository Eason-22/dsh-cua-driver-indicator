/**
 * The element-id readings on a real window.
 *
 * Reads the window, shows the id of every candidate, asks the native side
 * what it can do with one of those ids (run it in the background or not),
 * asks for an id that is not known any more, and waits for a control to
 * show up.
 *
 * Usage: node scripts/manual-snap-click-element.mjs <window handle or title> [name]
 */
import {
  createWindowsBackend,
  formatWaitForResult,
  runNamedSnapClick,
  runSnapWaitFor,
} from '../lib/snap-click.mjs';

const target = process.argv[2] ?? '66594';
const wanted = process.argv[3] ?? '算薪';
const backend = createWindowsBackend();

const found = await backend.find({ name: wanted, windowId: target });
console.log('--- 1. the candidates and their ids ---');
console.log('webContent: ' + found.webContent);
for (const candidate of found.candidates ?? []) {
  console.log(`  ${candidate.elementId} 《${candidate.name}》 ${JSON.stringify(candidate.rect)} ${candidate.offscreen ? 'offscreen' : 'on screen'}`);
}

const elementId = (found.candidates ?? [])[0]?.elementId ?? '';
console.log('--- 2. what the native side can do with that id (the mouse stays put) ---');
const byId = await backend.invoke({ elementId });
console.log(JSON.stringify({ code: byId.code ?? '', canInvoke: byId.canInvoke, manner: byId.manner, name: byId.name, rect: byId.rect, offscreen: byId.offscreen, error: byId.error }, null, 2));

console.log('--- 2b. an id that is not known any more ---');
const expired = await runNamedSnapClick({ element_id: 'e-not-known', window_id: target }, backend);
console.log(JSON.stringify({ code: expired.code, clicked: expired.clicked, reason: expired.reason }, null, 2));

console.log('--- 3. wait for a control to show up ---');
const waited = await runSnapWaitFor({ name: wanted, window_id: target, timeout_ms: 3000 }, backend);
console.log(formatWaitForResult(waited));

await backend.close();
