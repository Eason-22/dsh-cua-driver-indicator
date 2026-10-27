#!/usr/bin/env node
/**
 * Check what `npm pack` would actually ship.
 *
 * The plugin is published to npm, so the tarball is the one artifact every user
 * gets. Two things can go wrong quietly:
 *
 *   - something that must not be published sneaks in (`node_modules/`, a
 *     leftover `*.tgz`, a `*.bak-*` backup file);
 *   - something that must be published is missing (the three library files,
 *     the bundle patch, the licence, the readme).
 *
 * `npm pack --dry-run --json` reports the file list without writing anything,
 * so this script can assert on it. Any violation ends the process with exit
 * code 1, which is what CI and the release checklist expect.
 *
 * Usage: node scripts/check-package.mjs
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package root: the directory that holds package.json. */
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Files that have to be in the tarball, or the install is broken. */
const REQUIRED = [
  'lib/goal.mjs',
  'lib/index.js',
  'lib/series.mjs',
  'cordis.patch.yml',
  'LICENSE',
  'README.md',
];

/**
 * Entries that must never be in the tarball.
 *
 * `node_modules/` would bloat the package and shadow the host's own
 * dependencies, a `*.tgz` would nest one tarball inside another, and a
 * `*.bak-*` is a leftover from a manual edit.
 */
const FORBIDDEN = [
  {
    label: 'node_modules/',
    matches: (file) =>
      file === 'node_modules'
      || file.startsWith('node_modules/')
      || file.includes('/node_modules/'),
  },
  {
    label: '*.tgz',
    matches: (file) => file.endsWith('.tgz'),
  },
  {
    label: '*.bak-*',
    matches: (file) => path.posix.basename(file).includes('.bak-'),
  },
];

/** Print a byte count the way a human reads it. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  return `${bytes.toLocaleString('en-US')} bytes`;
}

/** Report a violation and stop with exit code 1. */
function fail(message) {
  console.error(`check-package: ${message}`);
  process.exit(1);
}

// `npm` is a shell script on Unix and a `.cmd` file on Windows. Node refuses to
// spawn a `.cmd` without a shell (it would be a command-injection hole), so on
// Windows the call goes through the command interpreter instead.
const isWindows = process.platform === 'win32';
const command = isWindows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
const args = isWindows
  ? ['/d', '/s', '/c', 'npm.cmd pack --dry-run --json']
  : ['pack', '--dry-run', '--json'];

let stdout;
try {
  stdout = execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
} catch (error) {
  const detail = typeof error.stderr === 'string' ? error.stderr.trim() : '';
  fail(`npm pack --dry-run --json failed${detail ? `: ${detail}` : `: ${error.message}`}`);
}

// npm may print a notice before the JSON, so the manifest is cut out of the
// output instead of being parsed as a whole.
let manifest;
try {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  const json = start === -1 || end === -1 ? stdout : stdout.slice(start, end + 1);
  const parsed = JSON.parse(json);
  manifest = Array.isArray(parsed) ? parsed[0] : parsed;
} catch (error) {
  fail(`cannot read the pack manifest: ${error.message}`);
}

if (!manifest || !Array.isArray(manifest.files)) {
  fail('the pack manifest holds no file list');
}

const files = manifest.files.map((file) => file.path);
const problems = [];

for (const file of files) {
  for (const rule of FORBIDDEN) {
    if (rule.matches(file)) problems.push(`${file} (${rule.label})`);
  }
}

for (const required of REQUIRED) {
  if (!files.includes(required)) problems.push(`missing ${required}`);
}

const packedSize = manifest.size;
const unpackedSize = manifest.unpackedSize;
const summedSize = manifest.files.reduce((total, file) => total + (Number(file.size) || 0), 0);

console.log(`check-package: ${manifest.name}@${manifest.version}`);
console.log(`check-package: ${manifest.entryCount ?? files.length} files, ${formatBytes(packedSize)} packed, ${formatBytes(unpackedSize)} unpacked`);
for (const file of manifest.files) {
  console.log(`check-package:   ${file.path} (${formatBytes(file.size)})`);
}
if (Number.isFinite(unpackedSize) && unpackedSize !== summedSize) {
  console.log(`check-package: note: the file sizes add up to ${formatBytes(summedSize)}`);
}

if (problems.length > 0) {
  console.error('check-package: the tarball is not what it should be:');
  for (const problem of problems) console.error(`check-package:   ${problem}`);
  process.exit(1);
}

console.log('check-package: ok — no forbidden entries, every required file is in the tarball');
