import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  OFFICIAL_TOOL_PREFIX,
  OFFICIAL_PACKAGES,
  PROVIDER_STATUS,
  DEFAULT_PROVIDER_BUNDLE,
  DEFAULT_PROVIDER_RANGE,
  INSTALL_CODE,
  RESTART_CODE,
  RESTART_HINT,
  UNKNOWN_VERSION,
  buildInstallTarget,
  detectProviderStatus,
  describeInstallResult,
  installProvider,
  isProviderVerified,
  isVersionRange,
  mapInstallOutcome,
  needsUserAction,
  readHostVersion,
  readOfficialPackageVersion,
  restartProvider,
} from '../lib/provider.mjs';

/** The repository root: the directory that holds package.json. */
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** The two official rows, as the host's plugin list reports them. */
const REGISTRY_ROW = {
  entryId: 'computer-use-registry',
  moduleName: '@deepseek-ai/dsh-computer-use',
  enabled: true,
};
const NATIVE_ROW = {
  entryId: 'computer-use-cua-driver-native',
  moduleName: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native',
  enabled: true,
};

/** A tool registry that holds the given tool names. */
function toolsWith(names) {
  return { definitions: () => names.map((name) => ({ name })) };
}

/** The host's plugin list. */
function pluginsWith(rows) {
  return rows.map((row) => ({
    entryId: row.entryId,
    moduleName: row.moduleName,
    enabled: row.enabled,
  }));
}

/** The host's bundle list. */
function bundlesWith(entries) {
  return entries.map((entry) => ({
    name: entry.name,
    version: entry.version,
    availability: entry.availability ?? 'profile',
  }));
}

test('available: the official tools are registered', () => {
  const state = detectProviderStatus({
    tools: toolsWith([`${OFFICIAL_TOOL_PREFIX}click`, 'write_file']),
    plugins: pluginsWith([REGISTRY_ROW, NATIVE_ROW]),
    bundles: bundlesWith([{ name: '@deepseek-ai/dsh-computer-use', version: '9.9.9' }]),
  });
  assert.equal(state.status, PROVIDER_STATUS.AVAILABLE);
  assert.equal(state.toolPresent, true);
  assert.equal(state.installed, true);
  assert.equal(needsUserAction(state.status), false);
});

test('missing: neither the official rows nor the official tools are there', () => {
  const state = detectProviderStatus({
    tools: toolsWith(['write_file']),
    plugins: pluginsWith([{ entryId: 'other', moduleName: 'dsh-other', enabled: true }]),
    bundles: bundlesWith([]),
  });
  assert.equal(state.status, PROVIDER_STATUS.MISSING);
  assert.equal(state.installed, false);
  assert.equal(needsUserAction(state.status), true);
});

test('installed-disabled: the official rows are there but one of them is off', () => {
  const state = detectProviderStatus({
    tools: toolsWith([]),
    plugins: pluginsWith([REGISTRY_ROW, { ...NATIVE_ROW, enabled: false }]),
    bundles: bundlesWith([]),
  });
  assert.equal(state.status, PROVIDER_STATUS.INSTALLED_DISABLED);
  assert.equal(state.installed, true);
  assert.equal(state.enabled, false);
  assert.equal(state.rows.length, 2);
});

test('installed-inactive: the rows are on, yet the tools never appeared', () => {
  const state = detectProviderStatus({
    tools: toolsWith([]),
    plugins: pluginsWith([REGISTRY_ROW, NATIVE_ROW]),
    bundles: bundlesWith([
      { name: '@deepseek-ai/dsh-computer-use', version: '9.9.9' },
      { name: '@deepseek-ai/dsh-web-app', version: '8.8.8', availability: 'installation' },
    ]),
  });
  assert.equal(state.status, PROVIDER_STATUS.INSTALLED_INACTIVE);
  assert.equal(state.installed, true);
  assert.equal(state.enabled, true);
  // The two real readings the panel shows: the official package that is
  // installed, and the host it runs in.
  assert.equal(state.officialPackageVersion, '9.9.9');
  assert.equal(state.hostVersion, '8.8.8');
});

test('unknown: the host has no tool registry, and nothing crashes', () => {
  const state = detectProviderStatus({
    tools: null,
    plugins: pluginsWith([REGISTRY_ROW, NATIVE_ROW]),
    bundles: bundlesWith([]),
  });
  assert.equal(state.status, PROVIDER_STATUS.UNKNOWN);
  assert.equal(state.toolKnown, false);
  assert.equal(needsUserAction(state.status), false);
});

test('unknown: a tool registry that throws is not a crash either', () => {
  const state = detectProviderStatus({
    tools: {
      definitions() {
        throw new Error('the registry is broken');
      },
    },
    plugins: pluginsWith([]),
    bundles: bundlesWith([]),
  });
  assert.equal(state.status, PROVIDER_STATUS.UNKNOWN);
});

test('unknown: the plugin list cannot be read, so missing is not claimed', () => {
  const state = detectProviderStatus({
    tools: toolsWith([]),
    plugins: null,
    bundles: null,
  });
  assert.equal(state.status, PROVIDER_STATUS.UNKNOWN);
  assert.equal(state.pluginKnown, false);
});

test('the version readings say "unknown" instead of guessing', () => {
  assert.equal(readOfficialPackageVersion(null), UNKNOWN_VERSION);
  assert.equal(readOfficialPackageVersion([]), UNKNOWN_VERSION);
  assert.equal(readHostVersion(null), UNKNOWN_VERSION);
  assert.equal(readHostVersion([]), UNKNOWN_VERSION);
});

test('the official packages are the two rows of the computer-control channel', () => {
  assert.equal(OFFICIAL_PACKAGES.length, 2);
  assert.deepEqual(OFFICIAL_PACKAGES.map((entry) => entry.row).sort(), [
    'computer-use-cua-driver-native',
    'computer-use-registry',
  ]);
  for (const entry of OFFICIAL_PACKAGES) {
    assert.ok(entry.name.startsWith('@deepseek-ai/dsh-'));
  }
});

test('the install target is a package name plus a range, never a fixed version', () => {
  const target = buildInstallTarget(DEFAULT_PROVIDER_BUNDLE, DEFAULT_PROVIDER_RANGE);
  assert.equal(target.ok, true);
  assert.equal(target.spec, `${DEFAULT_PROVIDER_BUNDLE}@${DEFAULT_PROVIDER_RANGE}`);
  assert.ok(!/\d+\.\d+\.\d+/.test(target.spec), 'the target must not carry a fixed version');
});

test('a fixed version is refused as an install target', () => {
  const target = buildInstallTarget(DEFAULT_PROVIDER_BUNDLE, '1.2.3');
  assert.equal(target.ok, false);
  assert.equal(target.code, INSTALL_CODE.INVALID_TARGET);
  assert.equal(isVersionRange('1.2.3'), false);
  assert.equal(isVersionRange('1.2.3-rc.1'), false);
  assert.equal(isVersionRange('>=1'), true);
  assert.equal(isVersionRange('^1.2.0'), true);
  assert.equal(isVersionRange('1.x'), true);
  assert.equal(isVersionRange('next'), true);
  assert.equal(isVersionRange(''), false);
});

test('install() answers with a structured result and never turns a failure into a success', async () => {
  const applied = await installProvider({
    install: async () => ({ changed: true, application: 'applied', stage: 'install', target: 'x' }),
    bundleName: DEFAULT_PROVIDER_BUNDLE,
    bundleRange: DEFAULT_PROVIDER_RANGE,
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.needRestart, false);
  assert.equal(typeof applied.message, 'string');

  const network = await installProvider({
    install: async () => ({
      changed: false,
      application: 'failed',
      stage: 'install',
      target: 'x',
      packageResult: { kind: 'network', exitCode: 1, output: '', truncated: false, logPath: '' },
    }),
    bundleName: DEFAULT_PROVIDER_BUNDLE,
    bundleRange: DEFAULT_PROVIDER_RANGE,
  });
  assert.equal(network.ok, false);
  assert.equal(network.code, INSTALL_CODE.REGISTRY_UNREACHABLE);
  assert.equal(network.needRestart, false);

  const missing = await installProvider({
    install: async () => ({
      changed: false,
      application: 'failed',
      stage: 'install',
      target: 'x',
      packageResult: { kind: 'not-found', exitCode: 1, output: '', truncated: false, logPath: '' },
    }),
    bundleName: DEFAULT_PROVIDER_BUNDLE,
    bundleRange: DEFAULT_PROVIDER_RANGE,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, INSTALL_CODE.NOT_INSTALLABLE);

  const thrown = await installProvider({
    install: async () => {
      throw new Error('the installer exploded');
    },
    bundleName: DEFAULT_PROVIDER_BUNDLE,
    bundleRange: DEFAULT_PROVIDER_RANGE,
  });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.code, INSTALL_CODE.FAILED);
  assert.match(thrown.message, /exploded/);
});

test('a cancelled installation is reported as refused', () => {
  const outcome = mapInstallOutcome({ changed: false, application: 'cancelled', stage: 'install', target: 'x' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, INSTALL_CODE.REFUSED);
});

test('an installation that needs a restart says so', () => {
  const outcome = mapInstallOutcome({
    changed: true,
    application: 'restart-required',
    stage: 'install',
    target: 'x',
    restartReason: 'no-hmr',
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.needRestart, true);
});

test('restart() does nothing at all when the restart plugin is not there', async () => {
  let called = 0;
  const outcome = await restartProvider({
    request: async () => {
      called += 1;
      return { ok: true, status: 200 };
    },
    origin: 'http://127.0.0.1:1234',
    enabled: false,
  });
  assert.equal(called, 0);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, RESTART_CODE.NOT_AVAILABLE);
});

test('restart() posts to the restart route with restart:true, and only when it is allowed', async () => {
  const calls = [];
  const outcome = await restartProvider({
    request: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, payload: { ok: true, restartRequested: true } };
    },
    origin: 'http://127.0.0.1:1234',
    parkPath: '/__dsh_autorestart/park',
    enabled: true,
    sessionId: 'session-1',
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.needRestart, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:1234/__dsh_autorestart/park');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.restart, true);
  assert.equal(body.sessionId, 'session-1');
});

test('restart() reports a failed call instead of pretending it worked', async () => {
  const thrown = await restartProvider({
    request: async () => {
      throw new Error('connection refused');
    },
    origin: 'http://127.0.0.1:1234',
    enabled: true,
  });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.code, RESTART_CODE.CALL_FAILED);

  const refused = await restartProvider({
    request: async () => ({ ok: false, status: 500 }),
    origin: 'http://127.0.0.1:1234',
    enabled: true,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, RESTART_CODE.CALL_FAILED);

  // The route answered, but the restart was NOT queued: saying "restarting"
  // here would be a lie.
  const notQueued = await restartProvider({
    request: async () => ({ ok: true, status: 200, payload: { ok: true, restartRequested: false } }),
    origin: 'http://127.0.0.1:1234',
    enabled: true,
  });
  assert.equal(notQueued.ok, false);
  assert.equal(notQueued.code, RESTART_CODE.CALL_FAILED);
});

test('the source never names a fixed version of an official package', () => {
  const sources = [
    'lib/index.js',
    'lib/provider.mjs',
    'lib/goal.mjs',
    'lib/series.mjs',
    'client.js',
    'package.json',
    'provider-bundle/package.json',
    'provider-bundle/cordis.patch.yml',
  ];
  for (const file of sources) {
    const text = readFileSync(path.join(root, file), 'utf8');
    for (const entry of OFFICIAL_PACKAGES) {
      const escaped = entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // `name@1.2.3` (a fixed version) must not appear anywhere.
      assert.ok(
        !new RegExp(`${escaped}@\\d+\\.\\d+\\.\\d+`).test(text),
        `${file} must not carry a fixed version of ${entry.name}`,
      );
    }
  }
});

test('the provider bundle depends on the official packages by range, not by version', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'provider-bundle/package.json'), 'utf8'));
  const dependencies = manifest.dependencies ?? {};
  for (const entry of OFFICIAL_PACKAGES) {
    assert.ok(entry.name in dependencies, `${entry.name} must be a dependency of the provider bundle`);
    assert.equal(isVersionRange(dependencies[entry.name]), true, `${entry.name} must be a range`);
  }
});

test('the provider bundle is not part of this package', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const files = manifest.files ?? [];
  for (const entry of files) {
    assert.ok(!entry.includes('provider-bundle') || entry.startsWith('!'), 'provider-bundle must be excluded');
  }
  assert.ok(files.includes('client.js'), 'the browser half must be published');
  assert.ok(manifest.dsh?.client?.platform === 'web', 'the package must declare its client half');
  assert.ok(manifest.exports['./client'] === './client.js', 'the client half must be exported');
});

test('the panel asks the host for a route the desktop app can reach', () => {
  const client = readFileSync(path.join(root, 'client.js'), 'utf8');
  const match = /const ROUTE = '([^']+)'/u.exec(client);
  assert.ok(match !== null, 'the panel must have one route constant');
  const route = match[1];
  // A leading slash would resolve against the app scheme: under
  // dsh-app://app/ it becomes dsh-app://__dsh_cua_indicator/provider, which
  // is outside the /api/ area the host exposes plugin routes in - every
  // fetch would fail and the popup would never appear.
  assert.ok(!route.startsWith('/'), `the route must not start with a slash (got "${route}"): a leading slash resolves to dsh-app://__dsh_cua_indicator/provider, outside the /api/ allow area`);
  assert.ok(route.startsWith('api/'), `the route must be relative to the app root and start with api/ (got "${route}")`);
  assert.ok(route.includes('__dsh_cua_indicator/provider'), `the route must address the provider route (got "${route}")`);
  assert.equal(route, 'api/__dsh_cua_indicator/provider');
});

test('the read and the write go through that one route', () => {
  const client = readFileSync(path.join(root, 'client.js'), 'utf8');
  const fetches = client.match(/fetch\(ROUTE/g) ?? [];
  assert.equal(fetches.length, 2, 'the GET and the POST must both use the ROUTE constant');
  // No other spelling of the route may sneak in.
  assert.ok(!client.includes("'/__dsh_cua_indicator/provider'"), 'the absolute path must be gone');
  assert.ok(!client.includes('"/__dsh_cua_indicator/provider"'), 'the absolute path must be gone');
});

test('a failed call to the host leaves a trace', () => {
  const client = readFileSync(path.join(root, 'client.js'), 'utf8');
  assert.match(client, /console\.warn/u);
  // The trace has to name the route and the failure, or it says nothing.
  assert.match(client, /warnRoute\('reading the provider state failed'/u);
  assert.match(client, /warnRoute\('the action "/u);
  const warn = /console\.warn\('\[dsh-cua-driver-indicator\][^\n]*ROUTE/u.exec(client);
  assert.ok(warn !== null, 'the warning must contain the route');
});

test('the panel is registered in the overlay slot and stays quiet when the channel is there', () => {
  const client = readFileSync(path.join(root, 'client.js'), 'utf8');
  // The panel lives in the shell's overlay layer.
  assert.match(client, /ctx\.slots\.inject\('shell\.overlay'/u);
  // A working channel must not be nagged: the panel draws nothing at all.
  assert.match(client, /if \(state\.status === STATUS\.AVAILABLE\) return null/u);
  // The temporary diagnostic badge is gone: no switch, no marker, no wording.
  assert.ok(!/\bconst DIAG\b/u.test(client), 'the DIAG switch must be gone');
  assert.ok(!client.includes('DIAG_STYLE'), 'the badge style must be gone');
  assert.ok(!client.includes('cua-indicator client loaded'), 'the badge wording must be gone');
});

test('the host route and the client route are the same path', () => {
  const host = readFileSync(path.join(root, 'lib/index.js'), 'utf8');
  const client = readFileSync(path.join(root, 'client.js'), 'utf8');
  const hostPath = /const PROVIDER_ROUTE_PATH = '([^']+)'/u.exec(host);
  assert.ok(hostPath !== null, 'the host route constant must exist');
  assert.ok(hostPath[1].startsWith('/api/'), `the host route must live under /api/ (got "${hostPath[1]}")`);
  const clientPath = /const ROUTE = '([^']+)'/u.exec(client);
  assert.ok(clientPath !== null, 'the client route constant must exist');
  assert.equal(
    hostPath[1].replace(/^\//u, ''),
    clientPath[1],
    'the host path without its leading slash must equal the client path',
  );
});

test('the route waits for the web server instead of taking it at mount time', () => {
  const host = readFileSync(path.join(root, 'lib/index.js'), 'utf8');
  const region = /if \(providerSettings\.enabled\) \{([\s\S]*?)\n {2}\}\n/u.exec(host);
  assert.ok(region !== null, 'the provider gate must exist');
  const gate = region[1];
  // The wait-for-ready path, the same shape dsh-goal-board uses.
  assert.match(gate, /inject\.call\(ctx, \['webServer'\]/u);
  assert.match(gate, /server\.register\(buildProviderRoute\(\)\)/u);
  // The old shape - grabbing the service while mounting - must be gone.
  assert.ok(!/const server = webServer\(\);/u.test(gate), 'the web server must not be taken at mount time');
  // Every way it can fail leaves a readable line.
  assert.match(gate, /the official-channel route could not be scheduled/u);
  assert.match(gate, /the official-channel route was refused/u);
  assert.match(gate, /the official-channel route is registered/u);
});

test('the panel asks the user and says what happens without the channel', () => {
  const client = readFileSync(path.join(root, 'client.js'), 'utf8');
  assert.match(client, /本插件需要官方的「电脑控制」插件才能工作/);
  assert.match(client, /安装官方电脑控制插件/);
  assert.match(client, /暂不安装/);
  assert.match(client, /已跳过。本插件当前不可用，下次启动会再提醒一次。/);
  assert.match(client, /去设置页启用/);
  assert.match(client, /立即重启/);
  assert.match(client, /shell\.overlay/);
});

test('the missing card carries the confirmed wording word for word', () => {
  const client = readFileSync(path.join(root, 'client.js'), 'utf8');
  const match = /missing:\s*\{([\s\S]*?)\n\s{4}\},/u.exec(client);
  assert.ok(match !== null, 'the missing card must exist');
  const card = match[1];
  // The title.
  assert.ok(card.includes('本插件需要官方的「电脑控制」插件才能工作'));
  // The three sentences of the body.
  assert.ok(card.includes('检测到你还没安装（或没有启用）DSH 官方的电脑控制插件。'));
  assert.ok(card.includes('本插件只是它的「显示器」——屏幕上的横幅、按 Esc 中断，全靠它来驱动电脑。它不在，本插件就完全用不了：不是功能少一点，而是没有任何东西可显示。'));
  assert.ok(card.includes('装好之后要重启一次 DSH 才会生效。'));
  // The two buttons and the answer to "暂不安装".
  assert.ok(card.includes('安装官方电脑控制插件'));
  assert.ok(card.includes('暂不安装'));
  assert.ok(card.includes('已跳过。本插件当前不可用，下次启动会再提醒一次。'));
});

test('one official row is not an installed channel', () => {
  const state = detectProviderStatus({
    tools: toolsWith([]),
    plugins: pluginsWith([REGISTRY_ROW]),
    bundles: bundlesWith([]),
  });
  // One row alone can never bring the official tools up, so the channel is
  // NOT installed and the install is NOT verified.
  assert.equal(state.installed, false);
  assert.equal(state.enabled, false);
  assert.equal(state.partial, true);
  assert.equal(isProviderVerified(state), false);
  assert.equal(state.status, PROVIDER_STATUS.MISSING);
});

test('both official rows together are an installed channel', () => {
  const state = detectProviderStatus({
    tools: toolsWith([]),
    plugins: pluginsWith([REGISTRY_ROW, NATIVE_ROW]),
    bundles: bundlesWith([]),
  });
  assert.equal(state.installed, true);
  assert.equal(state.partial, false);
  assert.equal(isProviderVerified(state), true);
});

test('an install answer the host never described is not a success', async () => {
  const empty = await installProvider({
    install: async () => ({}),
    bundleName: DEFAULT_PROVIDER_BUNDLE,
    bundleRange: DEFAULT_PROVIDER_RANGE,
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, INSTALL_CODE.FAILED);
  assert.equal(empty.needRestart, false);
  assert.match(empty.message, /application/);

  const withoutApplication = mapInstallOutcome({ changed: true, stage: 'install', target: 'x' });
  assert.equal(withoutApplication.ok, false);
  assert.equal(withoutApplication.code, INSTALL_CODE.FAILED);

  const unknownApplication = mapInstallOutcome({ application: 'whatever', stage: 'install', target: 'x' });
  assert.equal(unknownApplication.ok, false);
  assert.equal(unknownApplication.code, INSTALL_CODE.FAILED);

  const applied = mapInstallOutcome({ application: 'applied', stage: 'install', target: 'x' });
  assert.equal(applied.ok, true);
  const restartRequired = mapInstallOutcome({ application: 'restart-required', stage: 'install', target: 'x' });
  assert.equal(restartRequired.ok, true);
  assert.equal(restartRequired.needRestart, true);
});

test('the missing card says all three things the user has to know', () => {
  const client = readFileSync(path.join(root, 'client.js'), 'utf8');
  const match = /missing:\s*\{([\s\S]*?)\n\s{4}\},/u.exec(client);
  assert.ok(match !== null, 'the missing card must exist');
  const card = match[1];
  // 1) what is missing
  assert.match(card, /检测到你还没安装（或没有启用）DSH 官方的电脑控制插件。/u);
  // 2) what happens without it
  assert.match(card, /本插件就完全用不了/u);
  // 3) that installing alone is not enough - the host has to be restarted
  assert.ok(card.includes('装好之后要重启一次 DSH 才会生效。'), 'the missing card must say that a restart is needed');
});

test('an install the host overrode is its own answer, not a generic failure', () => {
  const outcome = mapInstallOutcome({ application: 'overridden', stage: 'install', target: 'x' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, INSTALL_CODE.OVERRIDDEN);
  assert.notEqual(outcome.code, INSTALL_CODE.FAILED);
  assert.match(outcome.message, /被另一层配置覆盖/);
  assert.match(outcome.message, /可能不会生效/);
});

test('a half install is never reported as "已经装上了"', () => {
  // The host says it applied the install, but only ONE of the two official
  // rows is there and no restart is pending: the channel cannot work yet.
  const halfInstalled = detectProviderStatus({
    tools: toolsWith([]),
    plugins: pluginsWith([REGISTRY_ROW]),
    bundles: bundlesWith([]),
  });
  const outcome = describeInstallResult(
    { ok: true, message: '已经装上了', needRestart: false },
    halfInstalled,
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, INSTALL_CODE.NOT_VERIFIED);
  assert.equal(outcome.verified, false);
  assert.ok(!outcome.message.includes('已经装上了'), 'the user must not be told it is installed');
  assert.match(outcome.message, /装上了一部分/);
  assert.match(outcome.message, /两行官方插件还没都到位/);
});

test('an install that only waits for a restart is not a half install', () => {
  // The host applied the install and says a restart is needed: the rows are
  // expected to appear only after that restart. That is a complete install,
  // so the answer stays a success and keeps the host's wording.
  const halfInstalled = detectProviderStatus({
    tools: toolsWith([]),
    plugins: pluginsWith([REGISTRY_ROW]),
    bundles: bundlesWith([]),
  });
  const outcome = describeInstallResult(
    { ok: true, message: `已经装上了，${RESTART_HINT}`, needRestart: true },
    halfInstalled,
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.verified, false);
  assert.ok(!outcome.message.includes('装上了一部分'), 'a pending restart is not a half install');
  assert.ok(outcome.message.includes('已经装上了'));
  assert.ok(outcome.message.includes(RESTART_HINT));
});

test('a failed install keeps the host error code, not not-verified', () => {
  const missing = detectProviderStatus({
    tools: toolsWith([]),
    plugins: pluginsWith([]),
    bundles: bundlesWith([]),
  });
  const failed = describeInstallResult(
    { ok: false, code: INSTALL_CODE.FAILED, message: '安装没有成功（failed）', needRestart: false },
    missing,
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.code, INSTALL_CODE.FAILED);
  assert.equal(failed.verified, false);
});

test('an install that IS verified keeps its own answer', () => {
  const installed = detectProviderStatus({
    tools: toolsWith([]),
    plugins: pluginsWith([REGISTRY_ROW, NATIVE_ROW]),
    bundles: bundlesWith([]),
  });
  const outcome = describeInstallResult(
    { ok: true, message: '已经装上了', needRestart: false },
    installed,
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.verified, true);
  assert.equal(outcome.message, '已经装上了');
});

test('an overridden install that is also not verified falls back to not-verified', () => {
  const halfInstalled = detectProviderStatus({
    tools: toolsWith([]),
    plugins: pluginsWith([REGISTRY_ROW]),
    bundles: bundlesWith([]),
  });
  const outcome = describeInstallResult(
    { ok: false, code: INSTALL_CODE.OVERRIDDEN, message: '改动已保留，但被另一层配置覆盖了，可能不会生效', needRestart: false },
    halfInstalled,
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, INSTALL_CODE.NOT_VERIFIED);
  assert.match(outcome.message, /被另一层配置覆盖/);
  assert.ok(!outcome.message.includes('已经装上了'));
});

test('the panel does not say "已经装上了" for a half install', () => {
  const client = readFileSync(path.join(root, 'client.js'), 'utf8');
  const handler = /const onInstall = async \(\) => \{([\s\S]*?)\n\s{8}\}/u.exec(client);
  assert.ok(handler !== null, 'the install handler must exist');
  const body = handler[1];
  // The success wording is behind the verification check.
  assert.match(body, /answer\.verified !== false/u);
  // The two wordings are two different dictionary entries now.
  assert.match(body, /t\('install\.done'\)/u);
  assert.match(body, /t\('install\.partial'\)/u);
  const guardIndex = body.indexOf('answer.verified !== false');
  const successIndex = body.indexOf("t('install.done')");
  const partialIndex = body.indexOf("t('install.partial')");
  assert.ok(guardIndex !== -1 && successIndex !== -1 && partialIndex !== -1);
  assert.ok(guardIndex < successIndex, 'the verification check comes before the success wording');
  // The wording itself: the success one says it is installed, the half one does not.
  const zh = JSON.parse(readFileSync(path.join(root, 'locale/zh.json'), 'utf8'));
  assert.ok(zh.install.done.startsWith('已经装上了'), 'the installed wording says so');
  assert.equal(zh.install.partial, '装上了，但两行官方插件还没都到位，重启后再看。');
  assert.ok(!zh.install.partial.includes('已经装上了'), 'a half install must not claim it worked');
});

test('the panel and the install answer say the same thing about the restart', () => {
  const client = readFileSync(path.join(root, 'client.js'), 'utf8');
  assert.ok(client.includes(RESTART_HINT), 'the panel must use the shared restart wording');
  const outcome = mapInstallOutcome({ application: 'restart-required', stage: 'install', target: 'x' });
  assert.ok(outcome.message.includes(RESTART_HINT), 'the install answer must use the shared restart wording');
  assert.match(client, new RegExp(RESTART_HINT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

/* ------------------------------------------------------------------ *
 * The two languages of the panel.
 * ------------------------------------------------------------------ */

/** Every leaf of a dictionary, as 'path -> text'. */
function leaves(value, prefix = '', out = new Map()) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => leaves(item, prefix + '.' + index, out));
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      leaves(item, prefix ? prefix + '.' + key : key, out);
    }
    return out;
  }
  out.set(prefix, value);
  return out;
}

/** The dictionary of the client, read out of its source. */
function clientDictionary(name) {
  const client = readFileSync(path.join(root, 'client.js'), 'utf8');
  const block = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n {2}\\}\\n`, 'u').exec(client);
  assert.ok(block !== null, `the ${name} dictionary must exist in client.js`);
  // The Chinese dictionary mentions the shared restart wording.
  return new Function('RESTART_HINT', `return {${block[1]}}`)(RESTART_HINT);
}

/** The client, evaluated in a sandbox: no DOM, no network, no real host. */
function loadClient({ language = 'zh-CN', locale = null } = {}) {
  const source = readFileSync(path.join(root, 'client.js'), 'utf8');
  const sandbox = {
    console,
    navigator: language === null ? {} : { language },
    window: { __ModuleLoader__: { load: (module) => { sandbox.__module = module; } } },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

/** The host context the client is applied to. */
function fakeContext(locale) {
  return {
    slots: { inject: (name, fn) => fn(), register: () => {} },
    locale,
  };
}

const REACT_STUB = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (value) => [value, () => {}],
  useEffect: () => undefined,
  useCallback: (fn) => fn,
};

test('the Chinese and the English wording have exactly the same keys', () => {
  const zh = JSON.parse(readFileSync(path.join(root, 'locale/zh.json'), 'utf8'));
  const en = JSON.parse(readFileSync(path.join(root, 'locale/en.json'), 'utf8'));
  const zhKeys = [...leaves(zh).keys()].sort();
  const enKeys = [...leaves(en).keys()].sort();
  assert.deepEqual(zhKeys, enKeys, 'no wording may be translated in one language only');
  assert.ok(zhKeys.length > 20, 'the panel has a real amount of wording');
  // Every English text is really English (the Chinese one is not a copy).
  for (const [key, text] of leaves(en)) {
    assert.ok(!/[一-鿿]/u.test(text), `the English wording of ${key} must not be Chinese`);
  }
});

test('the locale files are the mirror of the dictionaries in the client', () => {
  const zhJson = JSON.parse(readFileSync(path.join(root, 'locale/zh.json'), 'utf8'));
  const enJson = JSON.parse(readFileSync(path.join(root, 'locale/en.json'), 'utf8'));
  const zh = leaves(clientDictionary('ZH'));
  const en = leaves(clientDictionary('EN'));
  assert.deepEqual([...zh.keys()].sort(), [...zhJson && leaves(zhJson).keys()].sort(), 'the Chinese dictionary and locale/zh.json must agree');
  for (const [key, text] of leaves(zhJson)) {
    assert.equal(zh.get(key), text, `locale/zh.json must carry the same Chinese wording for ${key}`);
  }
  for (const [key, text] of leaves(enJson)) {
    assert.equal(en.get(key), text, `locale/en.json must carry the same English wording for ${key}`);
  }
});

test('the panel speaks the language of the user', () => {
  const zh = loadClient({ language: 'zh-CN' });
  assert.equal(
    zh.__dshCuaDriverIndicatorClient.t('missing.title'),
    '本插件需要官方的「电脑控制」插件才能工作',
  );
  const en = loadClient({ language: 'en-US' });
  assert.equal(
    en.__dshCuaDriverIndicatorClient.t('missing.title'),
    "This plugin needs DSH's official computer-control plugin to work",
  );
  assert.equal(en.__dshCuaDriverIndicatorClient.t('missing.install'), 'Install the official computer-control plugin');
});

test('without any language the panel stays Chinese, exactly as before', () => {
  const blind = loadClient({ language: null });
  assert.equal(blind.__dshCuaDriverIndicatorClient.currentLanguage(), 'zh');
  assert.equal(
    blind.__dshCuaDriverIndicatorClient.t('missing.title'),
    '本插件需要官方的「电脑控制」插件才能工作',
  );
});

test('the host locale service decides, and it is read at call time', () => {
  const client = loadClient({ language: 'zh-CN' });
  const api = client.__dshCuaDriverIndicatorClient;
  // The host says English while the browser says Chinese: the host wins.
  const module = client.__module.factory(() => REACT_STUB);
  module.apply(fakeContext({ getLocale: () => ({ locale: 'en' }) }));
  assert.equal(api.currentLanguage(), 'en');
  assert.equal(api.t('missing.install'), 'Install the official computer-control plugin');
  // The service is read again at every call, so a switch is followed at once.
  let locale = 'en';
  module.apply(fakeContext({ getLocale: () => ({ locale }) }));
  locale = 'zh';
  assert.equal(api.currentLanguage(), 'zh');
  assert.equal(api.t('missing.install'), '安装官方电脑控制插件');
});

test('a wording that does not exist falls back to a text, never to a key', () => {
  const en = loadClient({ language: 'en-US' });
  const text = en.__dshCuaDriverIndicatorClient.t('nothing.here');
  assert.notEqual(text, 'nothing.here', 'a key name must never reach the screen');
  assert.equal(text, 'This text is missing.', 'the last resort is the wording of this language');
  const zh = loadClient({ language: 'zh-CN' });
  assert.equal(zh.__dshCuaDriverIndicatorClient.t('nothing.here'), '这段文字缺失。');
});

test('the panel asks the host for the language service', () => {
  const client = readFileSync(path.join(root, 'client.js'), 'utf8');
  assert.match(client, /inject:\s*\['slots',\s*'locale'\]/u, 'the client must ask for the locale service');
  assert.match(client, /localeService = ctx\?\.locale \?\? null/u);
  assert.match(client, /getLocale\(\)/u, 'the language is read from the host service');
});

test('the manifest exports the locale files and ships them', () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json', 'the locale files must be exported');
  assert.ok(
    (manifest.files || []).some((entry) => String(entry).includes('locale')),
    'the locale files must be in the tarball',
  );
});
