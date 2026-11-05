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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package root: the directory that holds package.json. */
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * The official computer-control packages.
 *
 * This plugin does NOT depend on them: it asks the user whether the
 * independent provider bundle may be installed, and that bundle pulls the
 * official packages in. A dependency here would put the official packages
 * into this package's own manifest - and official packages move with the
 * host, so a fixed version of them would be wrong twice a year.
 */
const OFFICIAL_PACKAGES = [
  '@deepseek-ai/dsh-computer-use',
  '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native',
];

/**
 * The provider bundle.
 *
 * Its source lives in this repository (so a reader can see and review it),
 * but it is published as its OWN npm package and updated on its own. It
 * must therefore never travel inside this package's tarball.
 */
const PROVIDER_BUNDLE = 'provider-bundle';

/** The files that carry the runtime code. */
const SOURCE_FILES = [
  'lib/index.js',
  'lib/provider.mjs',
  'lib/goal.mjs',
  'lib/series.mjs',
  'client.js',
  'provider-bundle/package.json',
];

/** Files that have to be in the tarball, or the install is broken. */
const REQUIRED = [
  'lib/goal.mjs',
  'lib/index.js',
  'lib/provider.mjs',
  'lib/series.mjs',
  'client.js',
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
  {
    label: 'provider-bundle/ (it is published on its own)',
    matches: (file) => file === PROVIDER_BUNDLE || file.startsWith(`${PROVIDER_BUNDLE}/`),
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

// npm may print a notice before the JSON, and the shape of the JSON itself
// depends on the npm version: an older one writes an ARRAY of manifests,
// a newer one writes an OBJECT keyed by the package name. So the manifest is
// cut out of the output and then looked at in both shapes.
let manifest;
const candidates = [];
try {
  candidates.push(stdout);
} catch { /* the fallbacks below try harder */ }
const arrayStart = stdout.indexOf('[');
const arrayEnd = stdout.lastIndexOf(']');
if (arrayStart !== -1 && arrayEnd > arrayStart) {
  candidates.push(stdout.slice(arrayStart, arrayEnd + 1));
}
const objectStart = stdout.indexOf('{');
const objectEnd = stdout.lastIndexOf('}');
if (objectStart !== -1 && objectEnd > objectStart) {
  candidates.push(stdout.slice(objectStart, objectEnd + 1));
}
let parseError = null;
for (const candidate of candidates) {
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    if (parseError === null) parseError = error;
    continue;
  }
  if (Array.isArray(parsed)) {
    manifest = parsed[0];
    break;
  }
  if (parsed && typeof parsed === 'object') {
    // The newer shape: one entry per packed package.
    const entries = Object.values(parsed).filter(
      (entry) => entry && typeof entry === 'object' && Array.isArray(entry.files),
    );
    manifest = entries[0];
    break;
  }
}
if (!manifest) {
  fail(`cannot read the pack manifest: ${parseError ? parseError.message : 'no manifest in the output'}`);
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

// This package must not depend on the official computer-control packages:
// they belong to the independent provider bundle, and they move with the
// host, so a dependency here would freeze the wrong version.
let ownManifest;
try {
  ownManifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
} catch (error) {
  fail(`cannot read package.json: ${error.message}`);
}
for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
  const dependencies = ownManifest[section] ?? {};
  for (const name of OFFICIAL_PACKAGES) {
    if (name in dependencies) {
      problems.push(`package.json ${section} depends on the official package ${name}`);
    }
  }
}

// No source file may name a FIXED version of an official package. The
// install target and the provider bundle's dependencies are ranges, so a
// fixed version can only ever be a mistake.
for (const file of SOURCE_FILES) {
  let text;
  try {
    text = readFileSync(path.join(root, file), 'utf8');
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`);
  }
  for (const name of OFFICIAL_PACKAGES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`${escaped}@\\d+\\.\\d+\\.\\d+`).test(text)) {
      problems.push(`${file} names a fixed version of ${name}`);
    }
  }
}

// Every insert row of the provider bundle must say `disabled: false` ITSELF.
//
// The host's Loader dialect reads `disabled` from the insert item: a row
// that leaves it out is inserted in the disabled state, so the official
// channel never comes up. The user then clicks "install", the install
// succeeds, and the plugin still reports "installed but disabled" - the
// channel is on the machine and cannot be used. The profile patch that
// works on this machine writes `disabled: false` on both rows, so both rows
// here must say it too.
//
// The file is read with a regular expression on purpose: this script must
// not grow a YAML dependency just for one assertion.
const PROVIDER_PATCH_FILE = 'provider-bundle/cordis.patch.yml';

/**
 * The insert rows of the provider patch, with the flag they declare.
 *
 * @param {string} text the patch file
 * @returns {Array<{id: string, disabled: boolean}>}
 */
function providerPatchRows(text) {
  const rows = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const idMatch = /^\s*-\s+id:\s*(.+?)\s*$/.exec(line);
    if (idMatch !== null) {
      current = { id: idMatch[1].replace(/^['"]|['"]$/gu, ''), disabled: false };
      rows.push(current);
      continue;
    }
    if (current !== null && /^\s*disabled\s*:/u.test(line)) {
      current.disabled = /^\s*disabled\s*:\s*false\s*$/u.test(line);
    }
  }
  return rows;
}

let providerPatch;
try {
  providerPatch = readFileSync(path.join(root, PROVIDER_PATCH_FILE), 'utf8');
} catch (error) {
  fail(`cannot read ${PROVIDER_PATCH_FILE}: ${error.message}`);
}
const providerRows = providerPatchRows(providerPatch);
if (providerRows.length === 0) {
  problems.push(`${PROVIDER_PATCH_FILE} 里没有找到 insert 行`);
}
for (const row of providerRows) {
  if (!row.disabled) {
    problems.push(
      `${PROVIDER_PATCH_FILE} 的 insert 行「${row.id}」缺少 disabled: false`
      + '（缺了它，这行插出来是停用的：装完会落到 installed-disabled，点了安装还是不能用）',
    );
  }
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
