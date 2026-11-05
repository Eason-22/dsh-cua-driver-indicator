/**
 * The provider gate: does this host have DSH's official computer-control
 * channel, and what do we say (and do) when it does not?
 *
 * Everything in this file is a PURE function of its arguments: no import
 * from the host, no file system, no network, no clock. The effects - reading
 * the host's tool registry, installing a package, parking a restart - are
 * INJECTED by the caller, so every rule below can be pinned by a test
 * without a DSH host running.
 *
 * The five states
 * ---------------
 *   available           the official tools are registered and callable
 *   installed-disabled  the official rows exist, but one of them is disabled
 *   installed-inactive  the official rows exist and are enabled, yet the
 *                       tools never showed up (version drift, a missing
 *                       native driver, a late registration, ...)
 *   missing             neither the rows nor the tools are there
 *   unknown             the host did not answer (no tool registry, no plugin
 *                       list): we say so instead of guessing
 *
 * `installed-inactive` is the state that must never be reported as
 * "missing": the package IS on the machine, it just does not work. The
 * answer therefore carries two real readings - the version of the official
 * package that is installed and the version of the host it runs in - so the
 * user can see the drift instead of guessing at it.
 */

/** The tool-name prefix of the official built-in Cua Driver channel. */
export const OFFICIAL_TOOL_PREFIX = 'cua_driver_native__';

/**
 * The two official rows that make up the computer-control channel, and the
 * npm packages that provide them.
 *
 * `row` is the Loader row id in the composition; `name` is the package that
 * fills that row. Both are matched, because a host may report either one.
 */
export const OFFICIAL_PACKAGES = Object.freeze([
  Object.freeze({
    name: '@deepseek-ai/dsh-computer-use',
    row: 'computer-use-registry',
  }),
  Object.freeze({
    name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native',
    row: 'computer-use-cua-driver-native',
  }),
]);

/** The five states of the channel. */
export const PROVIDER_STATUS = Object.freeze({
  AVAILABLE: 'available',
  INSTALLED_DISABLED: 'installed-disabled',
  INSTALLED_INACTIVE: 'installed-inactive',
  MISSING: 'missing',
  UNKNOWN: 'unknown',
});

/**
 * The independent provider bundle we install when the channel is missing.
 *
 * The bundle is NOT shipped inside this plugin: its source lives in
 * `provider-bundle/` and it is published as its own npm package, so it can
 * be updated on its own. This plugin only ever names it by "package name +
 * version range"; the range lives in the configuration and can be replaced.
 */
export const DEFAULT_PROVIDER_BUNDLE = 'dsh-cua-driver-indicator-provider';

/** The default range of the provider bundle. A range, never a fixed version. */
export const DEFAULT_PROVIDER_RANGE = '>=1';

/** The error codes the install step answers with. */
export const INSTALL_CODE = Object.freeze({
  REFUSED: 'refused',
  NOT_INSTALLABLE: 'not-installable-offline',
  REGISTRY_UNREACHABLE: 'registry-unreachable',
  NO_PLUGIN_MANAGER: 'plugin-manager-unavailable',
  INVALID_TARGET: 'invalid-install-target',
  FAILED: 'install-failed',
  /**
   * The host kept the change, but another configuration layer wins over it.
   *
   * The host says `overridden` when a higher-priority layer decides the
   * effective value. The install itself did not fail - the row may simply
   * not be in effect - so it gets its own code instead of being folded into
   * `install-failed`.
   */
  OVERRIDDEN: 'overridden',
  /**
   * The install did something, but the channel is still not usable.
   *
   * This is the answer of a HALF install: the two official rows are not both
   * there (or not both enabled) yet, so the plugin tells the user that
   * instead of claiming the channel works.
   */
  NOT_VERIFIED: 'not-verified',
});

/** The error codes the restart step answers with. */
export const RESTART_CODE = Object.freeze({
  NOT_AVAILABLE: 'autorestart-not-available',
  CALL_FAILED: 'autorestart-call-failed',
});

/** The reading used when a number could not be read at all. */
export const UNKNOWN_VERSION = 'unknown';

/** The plugin whose presence enables the one-click restart. */
export const AUTORESTART_PACKAGE = 'dsh-autorestart';

/** An exact version: `1.2.3`, `1.2.3-rc.1`, `1.2.3+build`. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** A range operator, a wildcard, or an `x` placeholder. */
const RANGE_MARKER = /[\^~><=*]|\bx\b|\s-\s/;

/** A dist-tag: a bare word such as `next`, `latest` or `alpha`. */
const DIST_TAG = /^[a-zA-Z][a-zA-Z0-9._-]*$/;

/** A package name: what npm accepts, minus the version part. */
const PACKAGE_NAME = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/**
 * Is this a version RANGE (or a dist-tag), rather than a fixed version?
 *
 * The rule exists because a fixed version of an official package would
 * freeze this plugin onto one build of the host. A range keeps following
 * the host; a dist-tag follows it even more literally.
 *
 * @param {unknown} value the configured range
 * @returns {boolean} true when the value may be used as an install range
 */
export function isVersionRange(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return false;
  if (EXACT_VERSION.test(text)) return false;
  if (RANGE_MARKER.test(text)) return true;
  return DIST_TAG.test(text);
}

/**
 * Build the install target: a package name plus a version range.
 *
 * The result is deliberately a "name@range" string, never "name@1.2.3": a
 * fixed version would tie this plugin to one build of the host and would
 * have to be edited every time the host moves.
 *
 * @param {unknown} bundleName the npm package that provides the channel
 * @param {unknown} bundleRange the version range of that package
 * @returns {{ok: boolean, spec: string, code?: string, message: string}}
 */
export function buildInstallTarget(bundleName, bundleRange) {
  const name = typeof bundleName === 'string' ? bundleName.trim() : '';
  if (name === '' || !PACKAGE_NAME.test(name)) {
    return {
      ok: false,
      spec: '',
      code: INSTALL_CODE.INVALID_TARGET,
      message: `安装目标不是合法的包名：${name === '' ? '(空)' : name}`,
    };
  }
  const range = typeof bundleRange === 'string' ? bundleRange.trim() : '';
  if (!isVersionRange(range)) {
    return {
      ok: false,
      spec: '',
      code: INSTALL_CODE.INVALID_TARGET,
      message: `安装目标必须写版本范围而不是固定版本：${name}@${range === '' ? '(空)' : range}`,
    };
  }
  return { ok: true, spec: `${name}@${range}`, message: `安装目标：${name}@${range}` };
}

/**
 * The names of the registered tools, and whether the registry could be read
 * at all.
 *
 * A host without a tool registry is not an error: the answer is simply
 * "unknown", and the caller says so instead of claiming the channel is
 * missing.
 *
 * @param {unknown} tools the host's tool service, or an array of names
 * @returns {{known: boolean, names: string[]}}
 */
export function readToolNames(tools) {
  if (Array.isArray(tools)) {
    return { known: true, names: tools.filter((name) => typeof name === 'string') };
  }
  if (!tools || typeof tools.definitions !== 'function') {
    return { known: false, names: [] };
  }
  let definitions;
  try {
    definitions = tools.definitions();
  } catch {
    return { known: false, names: [] };
  }
  if (!Array.isArray(definitions)) return { known: false, names: [] };
  return {
    known: true,
    names: definitions.map((definition) => definition?.name).filter((name) => typeof name === 'string'),
  };
}

/**
 * Is this plugin row one of the two official rows?
 *
 * Both the package name and the Loader row id are accepted, because a host
 * reports the row under one name and the package under the other.
 *
 * @param {unknown} plugin one entry of the host's plugin list
 * @param {Array<{name: string, row: string}>} packages the official rows
 * @returns {boolean}
 */
export function isOfficialRow(plugin, packages = OFFICIAL_PACKAGES) {
  if (!plugin || typeof plugin !== 'object') return false;
  const moduleName = typeof plugin.moduleName === 'string' ? plugin.moduleName : '';
  const entryId = typeof plugin.entryId === 'string' ? plugin.entryId : '';
  return packages.some((entry) => moduleName === entry.name || entryId === entry.row);
}

/**
 * The official rows of the host's plugin list.
 *
 * @param {unknown} plugins the host's plugin list, or null when it could
 *   not be read
 * @param {Array<{name: string, row: string}>} packages the official rows
 * @returns {{known: boolean, rows: Array<{entryId: string, moduleName: string, enabled: boolean}>}}
 */
export function readOfficialRows(plugins, packages = OFFICIAL_PACKAGES) {
  if (!Array.isArray(plugins)) return { known: false, rows: [] };
  const rows = plugins
    .filter((plugin) => isOfficialRow(plugin, packages))
    .map((plugin) => ({
      entryId: typeof plugin.entryId === 'string' ? plugin.entryId : '',
      moduleName: typeof plugin.moduleName === 'string' ? plugin.moduleName : '',
      enabled: plugin.enabled === true,
    }));
  return { known: true, rows };
}

/**
 * The version of the official package that is installed on this host.
 *
 * It is read from the host's bundle inventory: the entry that carries the
 * official package name holds the version that is really on the machine.
 * When the inventory does not answer, the reading is "unknown" - never a
 * guess.
 *
 * @param {unknown} bundles the host's bundle list
 * @param {Array<{name: string, row: string}>} packages the official rows
 * @returns {string} the version, or "unknown"
 */
export function readOfficialPackageVersion(bundles, packages = OFFICIAL_PACKAGES) {
  if (!Array.isArray(bundles)) return UNKNOWN_VERSION;
  const names = packages.map((entry) => entry.name);
  for (const bundle of bundles) {
    if (!bundle || typeof bundle !== 'object') continue;
    if (typeof bundle.name !== 'string' || !names.includes(bundle.name)) continue;
    const version = typeof bundle.version === 'string' ? bundle.version.trim() : '';
    if (version !== '') return version;
  }
  return UNKNOWN_VERSION;
}

/**
 * The version of the host that runs this plugin.
 *
 * The bundles the DSH installation itself provides carry the host's own
 * version, so the first installation-provided bundle with a version is the
 * host's reading. When nothing answers, the reading is "unknown".
 *
 * @param {unknown} bundles the host's bundle list
 * @returns {string} the version, or "unknown"
 */
export function readHostVersion(bundles) {
  if (!Array.isArray(bundles)) return UNKNOWN_VERSION;
  for (const bundle of bundles) {
    if (!bundle || typeof bundle !== 'object') continue;
    if (bundle.availability !== 'installation') continue;
    const version = typeof bundle.version === 'string' ? bundle.version.trim() : '';
    if (version !== '') return version;
  }
  return UNKNOWN_VERSION;
}

/**
 * Is the restart plugin installed on this host?
 *
 * The one-click restart is only offered when dsh-autorestart is really
 * there: calling a route that does not exist would look like a failed
 * restart rather than a missing feature.
 *
 * @param {unknown} plugins the host's plugin list
 * @param {unknown} bundles the host's bundle list
 * @returns {boolean}
 */
export function hasAutorestart(plugins, bundles) {
  const listed = Array.isArray(plugins)
    && plugins.some((plugin) => plugin && typeof plugin === 'object'
      && (plugin.moduleName === AUTORESTART_PACKAGE || plugin.entryId === AUTORESTART_PACKAGE));
  if (listed) return true;
  return Array.isArray(bundles)
    && bundles.some((bundle) => bundle && typeof bundle === 'object' && bundle.name === AUTORESTART_PACKAGE);
}

/**
 * The state of the official computer-control channel on this host.
 *
 * The rules, in the order they are applied:
 *
 *   1. the tools are registered  -> available (nothing else matters);
 *   2. the tool registry could not be read -> unknown;
 *   3. the plugin list could not be read -> unknown;
 *   4. no official row at all -> missing;
 *   5. an official row is disabled -> installed-disabled;
 *   6. otherwise -> installed-inactive (the rows are on and enabled, yet the
 *      tools never appeared).
 *
 * @param {object} input the readings of this host
 * @param {unknown} input.tools the tool service, or an array of tool names
 * @param {unknown} input.plugins the host's plugin list, or null
 * @param {unknown} input.bundles the host's bundle list, or null
 * @param {string} [input.toolPrefix] the official tool-name prefix
 * @param {Array<{name: string, row: string}>} [input.officialPackages]
 * @returns {object} the state of the channel
 */
export function detectProviderStatus(input = {}) {
  const packages = Array.isArray(input.officialPackages) ? input.officialPackages : OFFICIAL_PACKAGES;
  const prefix = typeof input.toolPrefix === 'string' && input.toolPrefix !== ''
    ? input.toolPrefix
    : OFFICIAL_TOOL_PREFIX;
  const toolNames = readToolNames(input.tools);
  const toolPresent = toolNames.known
    && toolNames.names.some((name) => name.startsWith(prefix));
  const rows = readOfficialRows(input.plugins, packages);
  // The channel needs BOTH official rows: `computer-use-registry` registers
  // the provider and `computer-use-cua-driver-native` is the Windows driver
  // itself. One row alone never brings the official tools up, so "installed"
  // means EVERY official package is there - not "at least one row".
  const installed = rows.rows.length > 0 && packages.every((entry) => rows.rows.some(
    (row) => row.moduleName === entry.name || row.entryId === entry.row,
  ));
  // Some rows but not all: the channel is half there and cannot work.
  const partial = rows.rows.length > 0 && !installed;
  const enabled = installed && rows.rows.every((row) => row.enabled);
  const officialPackageVersion = readOfficialPackageVersion(input.bundles, packages);
  const hostVersion = readHostVersion(input.bundles);

  let status;
  if (toolPresent) status = PROVIDER_STATUS.AVAILABLE;
  else if (!toolNames.known) status = PROVIDER_STATUS.UNKNOWN;
  else if (!rows.known) status = PROVIDER_STATUS.UNKNOWN;
  else if (!installed) status = PROVIDER_STATUS.MISSING;
  else if (!enabled) status = PROVIDER_STATUS.INSTALLED_DISABLED;
  else status = PROVIDER_STATUS.INSTALLED_INACTIVE;

  return {
    status,
    toolPresent,
    toolKnown: toolNames.known,
    pluginKnown: rows.known,
    installed,
    enabled,
    partial,
    rows: rows.rows,
    officialPackageVersion,
    hostVersion,
    autorestartAvailable: hasAutorestart(input.plugins, input.bundles),
  };
}

/**
 * Is the channel really installed AND enabled?
 *
 * This is the question the install answer has to answer with facts: the two
 * official rows are there and enabled. A half-installed channel (one row) is
 * NOT verified, and neither is a channel whose rows are disabled.
 *
 * @param {object} state the state read by `detectProviderStatus`
 * @returns {boolean}
 */
export function isProviderVerified(state) {
  if (!state || typeof state !== 'object') return false;
  return state.installed === true && state.enabled === true;
}

/**
 * Does this state need the user to do something?
 *
 * `available` needs nothing, and `unknown` needs nothing either: the host
 * did not answer, so there is nothing to ask about.
 *
 * @param {string} status one of the five states
 * @returns {boolean}
 */
export function needsUserAction(status) {
  return status === PROVIDER_STATUS.MISSING
    || status === PROVIDER_STATUS.INSTALLED_DISABLED
    || status === PROVIDER_STATUS.INSTALLED_INACTIVE;
}

/**
 * The reason of a failed installation, read out of the host's own answer.
 *
 * @param {unknown} result the host's installation result
 * @returns {{code: string, diagnostic: string}|null} null when the
 *   installation did not fail
 */
export function readInstallFailure(result) {
  if (!result || typeof result !== 'object') {
    return { code: 'unknown', diagnostic: '安装没有返回结果' };
  }
  const error = result.error && typeof result.error === 'object' ? result.error : null;
  const kind = typeof result.packageResult?.kind === 'string' ? result.packageResult.kind : '';
  const diagnostic = typeof error?.diagnostic === 'string' && error.diagnostic !== ''
    ? error.diagnostic
    : typeof result.packageResult?.output === 'string' && result.packageResult.output.trim() !== ''
      ? result.packageResult.output.trim().slice(-400)
      : '';
  if (kind !== '') return { code: kind, diagnostic };
  if (error && typeof error.code === 'string') return { code: error.code, diagnostic };
  if (result.application === 'cancelled') return { code: 'cancelled', diagnostic };
  if (result.application === 'failed') return { code: 'failed', diagnostic };
  // The host kept the change but another layer wins over it: that is not a
  // failed install, it is an install that may not be in effect.
  if (result.application === 'overridden') return { code: 'overridden', diagnostic };
  // A shape the Host does not describe: no error, no package result, and an
  // `application` we do not know. That is NOT a success - a silent
  // "installed" would be a lie we would tell the user.
  if (result.application !== 'applied' && result.application !== 'restart-required') {
    return {
      code: 'unknown-application',
      diagnostic: `宿主没有回答这次安装的结果（application=${JSON.stringify(result.application ?? null)}）`,
    };
  }
  return null;
}

/**
 * The failures that mean "the registry could not be reached".
 */
const REGISTRY_FAILURES = new Set(['network', 'timeout']);

/**
 * The failures that mean "the user stopped it".
 */
const REFUSED_FAILURES = new Set(['cancelled']);

/**
 * The failures that mean "this package cannot be installed here".
 */
const NOT_INSTALLABLE_FAILURES = new Set([
  'not-found',
  'no-matching-version',
  'pnpm-missing',
  'integrity',
  'disk-full',
  'permission',
  'build-blocked',
  'unsupported-platform',
  'incompatible-version',
  'invalid-spec',
  'not-bundle',
  'unknown-plugin',
  'ambiguous-install',
  'stale-approval',
]);

/**
 * The wording the install answer and the panel share: after the install the
 * host has to be restarted once. The browser half keeps the same sentence
 * (it is a classic script and cannot import this file), and a test pins the
 * two against each other.
 */
export const RESTART_HINT = '装完需要重启一次 DSH 才生效。';

/**
 * Turn the host's installation answer into our own structured answer.
 *
 * A failure is NEVER turned into a success: the caller has to be able to
 * tell "it is installed" from "it did not install", because the two lead to
 * completely different messages for the user. Only the two shapes the Host
 * names - `applied` and `restart-required` - are a success.
 *
 * @param {unknown} result the host's installation result
 * @returns {{ok: boolean, code?: string, message: string, needRestart: boolean}}
 */
export function mapInstallOutcome(result) {
  const failure = readInstallFailure(result);
  if (failure === null) {
    const application = result.application;
    const needRestart = application === 'restart-required';
    return {
      ok: true,
      code: needRestart ? 'restart-required' : undefined,
      message: needRestart ? `已经装上了，${RESTART_HINT}` : '已经装上了',
      needRestart,
    };
  }
  const { code, diagnostic } = failure;
  const detail = diagnostic === '' ? code : `${code}${diagnostic === '' ? '' : `：${diagnostic}`}`;
  if (REFUSED_FAILURES.has(code)) {
    return { ok: false, code: INSTALL_CODE.REFUSED, message: `安装被取消（${detail}）`, needRestart: false };
  }
  if (REGISTRY_FAILURES.has(code)) {
    return {
      ok: false,
      code: INSTALL_CODE.REGISTRY_UNREACHABLE,
      message: `连不上软件源（${detail}）`,
      needRestart: false,
    };
  }
  if (NOT_INSTALLABLE_FAILURES.has(code)) {
    return {
      ok: false,
      code: INSTALL_CODE.NOT_INSTALLABLE,
      message: `这里装不上（${detail}）`,
      needRestart: false,
    };
  }
  if (code === 'overridden') {
    // The change was kept, but another layer decides the effective value. The
    // install did not fail - the row may simply not be in effect.
    return {
      ok: false,
      code: INSTALL_CODE.OVERRIDDEN,
      message: `改动已保留，但被另一层配置覆盖了，可能不会生效${diagnostic === '' ? '' : `（${diagnostic}）`}`,
      needRestart: false,
    };
  }
  return {
    ok: false,
    code: INSTALL_CODE.FAILED,
    message: `安装没有成功（${detail}）`,
    needRestart: false,
  };
}

/**
 * The answer of an install, told with the verification in hand.
 *
 * Two facts belong together: what the host did, and whether the channel is
 * really usable afterwards. A HALF install (the host says it applied, but the
 * two official rows are not both there, or not both enabled) must never be
 * reported as "已经装上了" - the user would click install and see nothing
 * happen. So the verification decides:
 *
 *   - verified   -> the install answer stands;
 *   - not verified -> `not-verified`, with the wording that says what is
 *     missing and that a restart may settle it.
 *
 * @param {object} outcome the answer of `installProvider`
 * @param {object} state the state read AFTER the install
 * @returns {{ok: boolean, code?: string, message: string, needRestart: boolean, verified: boolean}}
 */
export function describeInstallResult(outcome, state) {
  const base = outcome && typeof outcome === 'object' ? outcome : {};
  const verified = isProviderVerified(state);
  if (base.ok === true) {
    // The install itself worked.
    //
    // If the host says a restart is needed, the rows are expected to show
    // up only AFTER that restart: that is not a half install, so the answer
    // keeps the host's success wording ("已经装上了，装完需要重启一次 DSH
    // 才生效。") and the verification is reported honestly as false.
    if (base.needRestart === true || verified) {
      return { ...base, verified };
    }
    // A complete install whose rows are still not there, and no restart
    // pending: that IS a half install, so say so instead of claiming the
    // channel works.
    return {
      ...base,
      ok: false,
      code: INSTALL_CODE.NOT_VERIFIED,
      message: '装上了一部分，通道还不可用：两行官方插件还没都到位，重启后再看',
      verified,
    };
  }
  // The host's own failure codes are kept (failed, cancelled, ...). Only the
  // overridden case is folded into `not-verified`, because there the rows
  // are missing for a reason the user can act on.
  if (base.code === INSTALL_CODE.OVERRIDDEN && !verified) {
    return {
      ...base,
      ok: false,
      code: INSTALL_CODE.NOT_VERIFIED,
      message: '装上了一部分，通道还不可用：改动被另一层配置覆盖了，两行官方插件还没都到位，重启后再看',
      verified,
    };
  }
  return { ...base, verified };
}

/**
 * Install the provider bundle.
 *
 * The host call is injected, so this function stays a pure function of its
 * arguments: the caller passes the host's `installBundle`, this function
 * decides what the answer means.
 *
 * @param {object} input what to install and who installs it
 * @param {(spec: string) => Promise<unknown>} [input.install] the host call
 * @param {string} [input.bundleName] the npm package of the provider bundle
 * @param {string} [input.bundleRange] the version range of that package
 * @returns {Promise<{ok: boolean, code?: string, message: string, needRestart: boolean}>}
 */
export async function installProvider(input = {}) {
  if (typeof input.install !== 'function') {
    return {
      ok: false,
      code: INSTALL_CODE.NO_PLUGIN_MANAGER,
      message: '宿主没有插件管理服务，装不了',
      needRestart: false,
    };
  }
  const target = buildInstallTarget(
    input.bundleName ?? DEFAULT_PROVIDER_BUNDLE,
    input.bundleRange ?? DEFAULT_PROVIDER_RANGE,
  );
  if (!target.ok) {
    return {
      ok: false,
      code: target.code ?? INSTALL_CODE.INVALID_TARGET,
      message: target.message,
      needRestart: false,
    };
  }
  let result;
  try {
    result = await input.install(target.spec);
  } catch (error) {
    return {
      ok: false,
      code: INSTALL_CODE.FAILED,
      message: `安装没有成功：${describeError(error)}`,
      needRestart: false,
    };
  }
  return mapInstallOutcome(result);
}

/**
 * Park one restart through dsh-autorestart.
 *
 * The call only happens when the restart plugin is really installed and
 * when the user pressed the button - the caller decides that, this function
 * only performs the call and reports what the host answered.
 *
 * @param {object} input what to call and who calls it
 * @param {(url: string, init: object) => Promise<unknown>} [input.request]
 *   the HTTP call (the host's own fetch)
 * @param {string} [input.origin] the origin of the host's web server
 * @param {string} [input.parkPath] the path of the restart plugin's route
 * @param {boolean} [input.enabled] whether the restart plugin is installed
 * @param {string} [input.sessionId] the session that asks for the restart
 * @returns {Promise<{ok: boolean, code?: string, message: string, needRestart: boolean}>}
 */
export async function restartProvider(input = {}) {
  if (input.enabled !== true) {
    return {
      ok: false,
      code: RESTART_CODE.NOT_AVAILABLE,
      message: '这台机器上没有装自动重启插件，不能一键重启',
      needRestart: false,
    };
  }
  if (typeof input.request !== 'function') {
    return {
      ok: false,
      code: RESTART_CODE.CALL_FAILED,
      message: '没有可用的 HTTP 通道，叫不动重启',
      needRestart: false,
    };
  }
  const origin = typeof input.origin === 'string' ? input.origin : '';
  const parkPath = typeof input.parkPath === 'string' && input.parkPath !== ''
    ? input.parkPath
    : '/__dsh_autorestart/park';
  let url;
  try {
    url = new URL(parkPath, origin).toString();
  } catch {
    return {
      ok: false,
      code: RESTART_CODE.CALL_FAILED,
      message: `重启路由拼不出来：${origin}${parkPath}`,
      needRestart: false,
    };
  }
  const body = { restart: true };
  if (typeof input.sessionId === 'string' && input.sessionId.trim() !== '') {
    body.sessionId = input.sessionId.trim();
  }
  let response;
  try {
    response = await input.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return {
      ok: false,
      code: RESTART_CODE.CALL_FAILED,
      message: `重启请求失败：${describeError(error)}`,
      needRestart: false,
    };
  }
  const status = typeof response?.status === 'number' ? response.status : 0;
  const accepted = response?.ok === true || (status >= 200 && status < 300);
  if (!accepted) {
    return {
      ok: false,
      code: RESTART_CODE.CALL_FAILED,
      message: `重启请求没有被接受（HTTP ${status || '未知'}）`,
      needRestart: false,
    };
  }
  // The route answers `restartRequested`: when it is false the restart was
  // NOT queued, and saying "restarting" would be a lie.
  const payload = typeof response?.payload === 'object' && response.payload !== null ? response.payload : null;
  if (payload && payload.ok === true && payload.restartRequested === false) {
    return {
      ok: false,
      code: RESTART_CODE.CALL_FAILED,
      message: '重启请求没有排上（宿主没有接受这次重启）',
      needRestart: false,
    };
  }
  return { ok: true, message: '已经排了一次重启', needRestart: true };
}

/**
 * The message of an error, as a short piece of text.
 *
 * @param {unknown} error the thrown value
 * @returns {string}
 */
export function describeError(error) {
  if (error === null || error === undefined) return '未知错误';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message || error.name || '未知错误';
  if (typeof error === 'object' && typeof error.message === 'string') return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
