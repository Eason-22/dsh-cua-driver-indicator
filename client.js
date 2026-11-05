/**
 * dsh-cua-driver-indicator browser half: the question about DSH's official
 * computer-control channel.
 *
 * This plugin draws the takeover banner FOR the official channel
 * (`cua_driver_native__*`). Without that channel there is nothing to draw,
 * so the plugin asks the user: install the official channel, or live
 * without the banner?
 *
 * The panel lives in the shell's overlay layer (`shell.overlay` slot) and it
 * renders NOTHING at all when the channel is there - a working host must
 * not be nagged.
 *
 * The wording lives here, in the browser half, because the wording is for
 * the user. The host only sends the facts (which state, which versions).
 *
 * Everything is side-effect free until `apply(ctx)` runs: no timers, no
 * fetches, no DOM access at module scope.
 *
 * THE WHOLE FILE IS ONE IIFE: the client module loader evaluates this file
 * as a CLASSIC script and concatenates the client scripts of every plugin
 * into ONE bundle, so top-level names are shared. The IIFE keeps ours
 * private.
 */
;(function () {
  'use strict'

  /**
   * The host's route: it reads the state and takes the actions.
   *
   * It is a RELATIVE path on purpose, and that is not a style choice: the
   * desktop app serves the web UI from `dsh-app://app/`, so a leading slash
   * resolves to `dsh-app://__dsh_cua_indicator/provider` - outside the
   * `/api/` area the host exposes plugin routes in - and every fetch fails.
   * The host mounts this route under `/api/`, so the client asks for
   * `api/...`, which resolves to `dsh-app://app/api/...`.
   *
   * The GET and the POST both go through this one constant.
   */
  const ROUTE = 'api/__dsh_cua_indicator/provider'

  /**
   * Leave a trace when a call to the host fails.
   *
   * The panel draws NOTHING when the host does not answer, so a silent
   * failure is indistinguishable from "the popup never appears". Every
   * failed call leaves one line in the console, naming the route and what
   * went wrong (a status code, or the error message).
   *
   * @param {string} what what was being attempted
   * @param {unknown} detail the status code or the error
   */
  function warnRoute(what, detail) {
    try {
      const text = detail && detail.message ? detail.message : String(detail)
      console.warn('[dsh-cua-driver-indicator] ' + what + ' (route: ' + ROUTE + '): ' + text)
    } catch {
      // A console that refuses to print must not break the panel.
    }
  }

  /** How often the state is read again while the user has to do something. */
  const POLL_MS = 3000

  /**
   * How often the state is read again when nobody has to act.
   *
   * The channel may appear later (the user installs it by hand, the host
   * registers the official plugin late), so the panel keeps watching - but a
   * host that is already fine does not need to be polled every three
   * seconds. Thirty seconds is enough to notice, and it costs nothing.
   */
  const IDLE_POLL_MS = 30000

  /**
   * The states in which the user has to do something. In every other state
   * (the channel is there, or the host did not answer) the panel only
   * watches.
   */
  const ACTION_STATUSES = new Set(['missing', 'installed-disabled', 'installed-inactive'])

  /**
   * The sentence the install answer and the panel share. `lib/provider.mjs`
   * keeps the same wording (it cannot be imported from a classic script), and
   * a test pins the two against each other.
   */
  const RESTART_HINT = '装完需要重启一次 DSH 才生效。'

  /**
   * The five states of the official channel, as the browser sees them.
   *
   * The host sends the same names; they are written out here so a typo in
   * the host is visible in one place.
   */
  const STATUS = {
    AVAILABLE: 'available',
    MISSING: 'missing',
    DISABLED: 'installed-disabled',
    INACTIVE: 'installed-inactive',
    UNKNOWN: 'unknown',
  }

  /**
   * The wording of the panel: one entry per state, in two languages.
   *
   * WHY THE COPY LIVES HERE AND NOT ONLY IN `locale/*.json`: this file is
   * evaluated as a CLASSIC script, so it cannot import the JSON files - the
   * words have to be here. `locale/zh.json` and `locale/en.json` are the
   * MIRROR of the two dictionaries below (same keys, same words; a test holds
   * the three together), exactly like `dsh-autorestart` does it.
   *
   * The Chinese is the ORIGINAL and the default: a user whose language cannot
   * be read sees exactly what they saw before this file was touched.
   */
  const ZH = {
    missing: {
      title: '本插件需要官方的「电脑控制」插件才能工作',
      body: [
        '检测到你还没安装（或没有启用）DSH 官方的电脑控制插件。',
        '本插件只是它的「显示器」——屏幕上的横幅、按 Esc 中断，全靠它来驱动电脑。它不在，本插件就完全用不了：不是功能少一点，而是没有任何东西可显示。',
        '装好之后要重启一次 DSH 才会生效。',
      ],
      install: '安装官方电脑控制插件',
      dismiss: '暂不安装',
      declined: '已跳过。本插件当前不可用，下次启动会再提醒一次。',
    },
    disabled: {
      title: '官方电脑控制插件装了，但没有启用',
      body: '它在插件列表里是「停用」的状态，所以官方工具不会出现，接管提示条也不会出现。',
      note: '本插件在你启用它之前将不可用。',
      action: '去设置页启用',
      hint: '（在设置页的插件列表里启用它；这里的按钮替你做同一件事。）',
    },
    inactive: {
      title: '官方电脑控制插件装了，但工具没有出现',
      body: '两行官方插件都在、也都是启用的，可官方工具（cua_driver_native__*）没有注册进来。',
      note: '版本对不上是常见原因。重启一次宿主通常就能解决。',
      restart: '立即重启',
      noAutorestart: '这台机器上没有装自动重启插件，重启得你自己来。',
    },
    text: {
      restartHint: RESTART_HINT,
      withCode: '（{code}）',
      missing: '这段文字缺失。',
    },
    install: {
      done: '已经装上了，' + RESTART_HINT,
      partial: '装上了，但两行官方插件还没都到位，重启后再看。',
      failed: '安装没有成功。',
      requestFailed: '安装请求没有送到宿主：{error}',
    },
    enable: {
      done: '已经启用了。',
      failed: '启用没有成功。',
      requestFailed: '启用请求没有送到宿主：{error}',
    },
    restart: {
      done: '已经排了一次重启。',
      failed: '重启没有排上。',
      requestFailed: '重启请求没有送到宿主：{error}',
    },
    version: {
      installed: '已装官方包版本：{version}',
      host: '宿主版本：{version}',
    },
  }

  /** The same wording in English. The keys are the ones of `ZH`. */
  const EN = {
    missing: {
      title: 'This plugin needs DSH\'s official computer-control plugin to work',
      body: [
        'It looks like DSH\'s official computer-control plugin is not installed (or not enabled).',
        'This plugin is only the display of that channel: the on-screen banner and the Esc interrupt are driven by it. Without it this plugin cannot do anything at all - not "a little less", but nothing to show.',
        'After the install, DSH has to be restarted once for it to take effect.',
      ],
      install: 'Install the official computer-control plugin',
      dismiss: 'Not now',
      declined: 'Skipped. This plugin is unavailable for now; it will ask again on the next start.',
    },
    disabled: {
      title: 'The official computer-control plugin is installed, but not enabled',
      body: 'It sits in the plugin list as "disabled", so the official tools do not appear - and neither does the takeover banner.',
      note: 'This plugin stays unavailable until you enable it.',
      action: 'Enable it in the settings',
      hint: '(Enable it in the plugin list of the settings page; this button does the same thing.)',
    },
    inactive: {
      title: 'The official computer-control plugin is installed, but its tools did not appear',
      body: 'Both official rows are there and both are enabled, but the official tools (cua_driver_native__*) were not registered.',
      note: 'A version mismatch is the usual reason. Restarting the host usually fixes it.',
      restart: 'Restart now',
      noAutorestart: 'There is no auto-restart plugin on this machine, so the restart is yours to do.',
    },
    text: {
      restartHint: 'DSH has to be restarted once for it to take effect.',
      withCode: '({code})',
      missing: 'This text is missing.',
    },
    install: {
      done: 'It is installed - DSH has to be restarted once for it to take effect.',
      partial: 'Partly installed: the two official plugin rows are not both in place yet; look again after the restart.',
      failed: 'The install did not work.',
      requestFailed: 'The install request did not reach the host: {error}',
    },
    enable: {
      done: 'It is enabled now.',
      failed: 'Enabling it did not work.',
      requestFailed: 'The enable request did not reach the host: {error}',
    },
    restart: {
      done: 'A restart has been queued.',
      failed: 'The restart could not be queued.',
      requestFailed: 'The restart request did not reach the host: {error}',
    },
    version: {
      installed: 'Installed official package version: {version}',
      host: 'Host version: {version}',
    },
  }

  /**
   * THE LOCALE SERVICE of the Host (null until the plugin is applied).
   *
   * It knows the active language: the user picked one in the settings, or the
   * browser's language decided. It is read at CALL time, so a language switch
   * is followed at once. This is the same shape `dsh-autorestart` uses.
   */
  let localeService = null

  /**
   * The active language of this interface: 'zh' or 'en'.
   *
   * The Host's locale service decides; when it is not there (a slot rendered
   * without the locale seat, an old host), the browser's language does.
   * `zh*` is Chinese, everything else is English - the same rule the DSH
   * locale service uses.
   *
   * ONE DEVIATION FROM `dsh-autorestart`, and it is deliberate: when NO
   * language can be read at all, this plugin answers **Chinese**, because
   * that is what it always showed. An English card must never appear
   * because the host was old.
   *
   * @returns {'zh'|'en'}
   */
  function currentLanguage() {
    let raw = ''
    try {
      if (localeService && typeof localeService.getLocale === 'function') {
        const snapshot = localeService.getLocale()
        if (snapshot && typeof snapshot.locale === 'string') raw = snapshot.locale
      }
    } catch {
      raw = ''
    }
    if (raw === '' && typeof navigator !== 'undefined' && navigator && typeof navigator.language === 'string') {
      raw = navigator.language
    }
    const lower = String(raw).toLowerCase()
    if (lower === '') return 'zh'
    return lower.startsWith('zh') ? 'zh' : 'en'
  }

  /**
   * One entry out of a dictionary, by its dotted path ('missing.title').
   *
   * @param {object} table the dictionary
   * @param {string} path the dotted path
   * @returns {unknown} the entry, or undefined
   */
  function pick(table, path) {
    let value = table
    for (const part of String(path).split('.')) {
      if (value === null || typeof value !== 'object') return undefined
      value = value[part]
    }
    return value
  }

  /**
   * Fill `{name}` placeholders from `params`.
   *
   * The value is inserted as LITERAL text (`$&` / `$1` are characters and not
   * replace patterns, hence split + join and never `replace`), a placeholder
   * without a value stays as it is (blanking it would delete the information
   * the sentence carries), and a `null` / `undefined` value counts as "no
   * value" - never as the word `null` printed on screen.
   *
   * @param {string} text the template
   * @param {object} [params] the values
   * @returns {string}
   */
  function fillPlaceholders(text, params) {
    if (typeof text !== 'string' || text === '') return text
    if (!params || typeof params !== 'object') return text
    let out = text
    for (const [name, value] of Object.entries(params)) {
      if (value === null || value === undefined || value === '') continue
      out = out.split('{' + name + '}').join(String(value))
    }
    return out
  }

  /**
   * One text out of the built-in dictionaries.
   *
   * The dictionary of the current language wins; the Chinese original is the
   * second choice (a human-readable text beats a key name); the last resort
   * is the "missing" line - NEVER the key itself.
   *
   * @param {string} path the dotted path of the entry
   * @param {object} [params] the placeholder values
   * @returns {string}
   */
  function t(path, params) {
    const language = currentLanguage()
    const table = language === 'en' ? EN : ZH
    let text = pick(table, path)
    if (typeof text !== 'string' || text === '') text = pick(ZH, path)
    if (typeof text !== 'string' || text === '') text = pick(table, 'text.missing')
    if (typeof text !== 'string' || text === '') text = pick(ZH, 'text.missing')
    if (typeof text !== 'string') text = ''
    return fillPlaceholders(text, params)
  }

  /**
   * The translator of this plugin, on the global namespace.
   *
   * The same global namespace `dsh-autorestart` uses: it exists as soon as
   * this file is evaluated (no factory call needed), so the wording can be
   * asked for in a given language without mounting the panel.
   */
  globalThis.__dshCuaDriverIndicatorClient = Object.assign(
    globalThis.__dshCuaDriverIndicatorClient || {},
    { t, currentLanguage },
  )

  /** The slim line that stays after the user said no. */
  const DECLINED_STYLE = {
    position: 'fixed',
    left: '16px',
    bottom: '16px',
    zIndex: 2147483000,
    maxWidth: '360px',
    padding: '10px 14px',
    borderRadius: '10px',
    fontSize: '13px',
    lineHeight: '1.5',
    color: 'var(--dsw-fg, #1f2328)',
    background: 'var(--dsw-bg-elevated, #ffffff)',
    border: '1px solid var(--dsw-border, #d0d7de)',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
  }

  /** The frame that centres the card on the screen. */
  const OVERLAY_STYLE = {
    position: 'fixed',
    inset: 0,
    zIndex: 2147483001,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    background: 'rgba(0, 0, 0, 0.35)',
  }

  /** The card itself. */
  const CARD_STYLE = {
    width: 'min(520px, 100%)',
    padding: '22px 24px',
    borderRadius: '14px',
    color: 'var(--dsw-fg, #1f2328)',
    background: 'var(--dsw-bg-elevated, #ffffff)',
    border: '1px solid var(--dsw-border, #d0d7de)',
    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.28)',
  }

  const TITLE_STYLE = { fontSize: '17px', fontWeight: '600', margin: '0 0 10px' }
  const BODY_STYLE = { fontSize: '14px', lineHeight: '1.6', margin: '0 0 10px' }
  const NOTE_STYLE = { fontSize: '13px', lineHeight: '1.6', margin: '0 0 14px', opacity: '0.85' }
  const VERSIONS_STYLE = {
    fontSize: '13px',
    lineHeight: '1.7',
    margin: '0 0 14px',
    padding: '8px 10px',
    borderRadius: '8px',
    background: 'var(--dsw-bg-muted, #f6f8fa)',
  }
  const ACTIONS_STYLE = { display: 'flex', gap: '10px', flexWrap: 'wrap' }
  const MESSAGE_STYLE = { fontSize: '13px', lineHeight: '1.6', marginTop: '12px', opacity: '0.9' }

  const PRIMARY_BUTTON = {
    padding: '7px 14px',
    borderRadius: '8px',
    fontSize: '14px',
    cursor: 'pointer',
    color: '#ffffff',
    background: 'var(--dsw-accent, #247bbf)',
    border: '1px solid transparent',
  }

  const SECONDARY_BUTTON = {
    padding: '7px 14px',
    borderRadius: '8px',
    fontSize: '14px',
    cursor: 'pointer',
    color: 'var(--dsw-fg, #1f2328)',
    background: 'var(--dsw-bg-muted, #f6f8fa)',
    border: '1px solid var(--dsw-border, #d0d7de)',
  }

  window.__ModuleLoader__.load({
    id: 'dsh-cua-driver-indicator',
    factory(require) {
      const React = require('react')
      const h = React.createElement
      const useState = React.useState
      const useEffect = React.useEffect
      const useCallback = React.useCallback

      /** Read the state of the official channel from the host. */
      async function readState() {
        let response
        try {
          response = await fetch(ROUTE, { headers: { accept: 'application/json' } })
        } catch (error) {
          warnRoute('reading the provider state failed', error)
          throw error
        }
        if (!response || response.ok !== true) {
          const status = response ? response.status : 'unknown'
          warnRoute('the host did not answer the state request', 'HTTP ' + status)
          throw new Error('HTTP ' + status)
        }
        const payload = await response.json()
        return payload && payload.ok === true ? payload.state : null
      }

      /** Post one action to the host and return its answer. */
      async function postAction(action) {
        let response
        try {
          response = await fetch(ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action }),
          })
        } catch (error) {
          warnRoute('the action "' + action + '" did not reach the host', error)
          throw error
        }
        if (!response || response.ok !== true) {
          warnRoute('the host rejected the action "' + action + '"', 'HTTP ' + (response ? response.status : 'unknown'))
        }
        const payload = await response.json().catch(() => ({}))
        return payload && typeof payload === 'object' ? payload : {}
      }

      /** The message of a failed action, with its error code. */
      function failureText(answer, fallback) {
        const message = answer && answer.message ? answer.message : fallback
        const code = answer && answer.code ? answer.code : ''
        return code === '' ? message : message + t('text.withCode', { code })
      }

      function ProviderPanel() {
        const [state, setState] = useState(null)
        const [declined, setDeclined] = useState(false)
        const [message, setMessage] = useState('')
        const [busy, setBusy] = useState(false)

        const refresh = useCallback(async () => {
          try {
            const next = await readState()
            setState(next)
            return next
          } catch {
            setState(null)
            return null
          }
        }, [])

        // The state is read FRESH every time, never taken from a start-up
        // reading: the official plugin may register itself later than this
        // one, and a stale reading would be a false alarm. When the channel
        // shows up in the meantime, the panel closes itself.
        useEffect(() => {
          let alive = true
          let timer = null
          const tick = async () => {
            if (!alive) return
            const next = await refresh()
            if (!alive) return
            // Three seconds while the user has something to do, thirty
            // seconds when nobody has to act.
            const fast = next !== null && ACTION_STATUSES.has(next.status)
            timer = setTimeout(tick, fast ? POLL_MS : IDLE_POLL_MS)
          }
          timer = setTimeout(tick, 0)
          return () => {
            alive = false
            if (timer !== null) clearTimeout(timer)
          }
        }, [refresh])

        const onInstall = async () => {
          setBusy(true)
          setMessage('')
          try {
            const answer = await postAction('install')
            // "装上了" is only true when the host says so AND the two
            // official rows are really in place. A half install says what is
            // missing instead of claiming the channel works.
            const done = answer.ok === true && answer.verified !== false
            setMessage(answer.ok === true
              ? (answer.message || (done
                ? t('install.done')
                : t('install.partial')))
              : failureText(answer, t('install.failed')))
            if (answer.state) setState(answer.state)
            else await refresh()
          } catch (error) {
            setMessage(t('install.requestFailed', {
              error: error && error.message ? error.message : String(error),
            }))
          } finally {
            setBusy(false)
          }
        }

        const onDismiss = async () => {
          setBusy(true)
          try {
            await postAction('dismiss')
          } catch {
            // The host may not answer; the panel closes either way.
          }
          setDeclined(true)
          setBusy(false)
        }

        const onEnable = async () => {
          setBusy(true)
          setMessage('')
          try {
            const answer = await postAction('enable')
            setMessage(answer.ok === true
              ? (answer.message || t('enable.done'))
              : failureText(answer, t('enable.failed')))
            if (answer.state) setState(answer.state)
            else await refresh()
          } catch (error) {
            setMessage(t('enable.requestFailed', {
              error: error && error.message ? error.message : String(error),
            }))
          } finally {
            setBusy(false)
          }
        }

        const onRestart = async () => {
          setBusy(true)
          setMessage('')
          try {
            const answer = await postAction('restart')
            setMessage(answer.ok === true
              ? (answer.message || t('restart.done'))
              : failureText(answer, t('restart.failed')))
          } catch (error) {
            setMessage(t('restart.requestFailed', {
              error: error && error.message ? error.message : String(error),
            }))
          } finally {
            setBusy(false)
          }
        }

        // What the panel draws: a card, the declined line, or nothing at all.
        // The host did not answer -> there is nothing to ask about.
        if (!state) {
          return declined ? h('div', { style: DECLINED_STYLE }, t('missing.declined')) : null
        }
        // The channel is there: this plugin renders nothing at all.
        if (state.status === STATUS.AVAILABLE) return null

        if (state.status === STATUS.MISSING) {
          if (declined) return h('div', { style: DECLINED_STYLE }, t('missing.declined'))
          return h('div', { style: OVERLAY_STYLE },
            h('div', { style: CARD_STYLE, role: 'dialog', 'aria-modal': 'true' },
              h('h2', { style: TITLE_STYLE }, t('missing.title')),
              ...[0, 1, 2].map((index) => h('p', { key: index, style: BODY_STYLE }, t('missing.body.' + index))),
              h('div', { style: ACTIONS_STYLE },
                h('button', {
                  type: 'button', style: PRIMARY_BUTTON, disabled: busy, onClick: onInstall,
                }, t('missing.install')),
                h('button', {
                  type: 'button', style: SECONDARY_BUTTON, disabled: busy, onClick: onDismiss,
                }, t('missing.dismiss'))),
              message ? h('div', { style: MESSAGE_STYLE }, message) : null))
        }

        if (state.status === STATUS.DISABLED) {
          return h('div', { style: OVERLAY_STYLE },
            h('div', { style: CARD_STYLE, role: 'dialog', 'aria-modal': 'true' },
              h('h2', { style: TITLE_STYLE }, t('disabled.title')),
              h('p', { style: BODY_STYLE }, t('disabled.body')),
              h('p', { style: NOTE_STYLE }, t('disabled.note')),
              h('div', { style: ACTIONS_STYLE },
                h('button', {
                  type: 'button', style: PRIMARY_BUTTON, disabled: busy, onClick: onEnable,
                }, t('disabled.action'))),
              h('p', { style: NOTE_STYLE }, t('disabled.hint')),
              message ? h('div', { style: MESSAGE_STYLE }, message) : null))
        }

        if (state.status === STATUS.INACTIVE) {
          return h('div', { style: OVERLAY_STYLE },
            h('div', { style: CARD_STYLE, role: 'dialog', 'aria-modal': 'true' },
              h('h2', { style: TITLE_STYLE }, t('inactive.title')),
              h('p', { style: BODY_STYLE }, t('inactive.body')),
              h('div', { style: VERSIONS_STYLE },
                h('div', null, t('version.installed', { version: state.officialPackageVersion || 'unknown' })),
                h('div', null, t('version.host', { version: state.hostVersion || 'unknown' }))),
              h('p', { style: NOTE_STYLE }, t('inactive.note')),
              state.autorestartAvailable === true
                ? h('div', { style: ACTIONS_STYLE },
                  h('button', {
                    type: 'button', style: PRIMARY_BUTTON, disabled: busy, onClick: onRestart,
                  }, t('inactive.restart')))
                : h('p', { style: NOTE_STYLE }, t('inactive.noAutorestart')),
              message ? h('div', { style: MESSAGE_STYLE }, message) : null))
        }

        // unknown: the host did not say, so nothing is claimed.
        return null
      }

      return {
        // 'locale' is the host's language service: it knows which language the
        // user picked, and it is read at call time. The same pair of services
        // `dsh-autorestart` asks for.
        inject: ['slots', 'locale'],
        apply(ctx) {
          localeService = ctx?.locale ?? null
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'cua-driver-indicator-provider',
            order: 50,
          }, ProviderPanel))
        },
      }
    },
  })
})()
