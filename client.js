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

  /** The wording of the panel, one entry per state. */
  const TEXT = {
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
  }

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
        return code === '' ? message : message + '（' + code + '）'
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
                ? `已经装上了，${RESTART_HINT}`
                : '装上了，但两行官方插件还没都到位，重启后再看。'))
              : failureText(answer, '安装没有成功。'))
            if (answer.state) setState(answer.state)
            else await refresh()
          } catch (error) {
            setMessage('安装请求没有送到宿主：' + (error && error.message ? error.message : String(error)))
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
              ? (answer.message || '已经启用了。')
              : failureText(answer, '启用没有成功。'))
            if (answer.state) setState(answer.state)
            else await refresh()
          } catch (error) {
            setMessage('启用请求没有送到宿主：' + (error && error.message ? error.message : String(error)))
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
              ? (answer.message || '已经排了一次重启。')
              : failureText(answer, '重启没有排上。'))
          } catch (error) {
            setMessage('重启请求没有送到宿主：' + (error && error.message ? error.message : String(error)))
          } finally {
            setBusy(false)
          }
        }

        // What the panel draws: a card, the declined line, or nothing at all.
        // The host did not answer -> there is nothing to ask about.
        if (!state) {
          return declined ? h('div', { style: DECLINED_STYLE }, TEXT.missing.declined) : null
        }
        // The channel is there: this plugin renders nothing at all.
        if (state.status === STATUS.AVAILABLE) return null

        if (state.status === STATUS.MISSING) {
          if (declined) return h('div', { style: DECLINED_STYLE }, TEXT.missing.declined)
          return h('div', { style: OVERLAY_STYLE },
            h('div', { style: CARD_STYLE, role: 'dialog', 'aria-modal': 'true' },
              h('h2', { style: TITLE_STYLE }, TEXT.missing.title),
              ...TEXT.missing.body.map((line, index) => h('p', { key: index, style: BODY_STYLE }, line)),
              h('div', { style: ACTIONS_STYLE },
                h('button', {
                  type: 'button', style: PRIMARY_BUTTON, disabled: busy, onClick: onInstall,
                }, TEXT.missing.install),
                h('button', {
                  type: 'button', style: SECONDARY_BUTTON, disabled: busy, onClick: onDismiss,
                }, TEXT.missing.dismiss)),
              message ? h('div', { style: MESSAGE_STYLE }, message) : null))
        }

        if (state.status === STATUS.DISABLED) {
          return h('div', { style: OVERLAY_STYLE },
            h('div', { style: CARD_STYLE, role: 'dialog', 'aria-modal': 'true' },
              h('h2', { style: TITLE_STYLE }, TEXT.disabled.title),
              h('p', { style: BODY_STYLE }, TEXT.disabled.body),
              h('p', { style: NOTE_STYLE }, TEXT.disabled.note),
              h('div', { style: ACTIONS_STYLE },
                h('button', {
                  type: 'button', style: PRIMARY_BUTTON, disabled: busy, onClick: onEnable,
                }, TEXT.disabled.action)),
              h('p', { style: NOTE_STYLE }, TEXT.disabled.hint),
              message ? h('div', { style: MESSAGE_STYLE }, message) : null))
        }

        if (state.status === STATUS.INACTIVE) {
          return h('div', { style: OVERLAY_STYLE },
            h('div', { style: CARD_STYLE, role: 'dialog', 'aria-modal': 'true' },
              h('h2', { style: TITLE_STYLE }, TEXT.inactive.title),
              h('p', { style: BODY_STYLE }, TEXT.inactive.body),
              h('div', { style: VERSIONS_STYLE },
                h('div', null, '已装官方包版本：' + (state.officialPackageVersion || 'unknown')),
                h('div', null, '宿主版本：' + (state.hostVersion || 'unknown'))),
              h('p', { style: NOTE_STYLE }, TEXT.inactive.note),
              state.autorestartAvailable === true
                ? h('div', { style: ACTIONS_STYLE },
                  h('button', {
                    type: 'button', style: PRIMARY_BUTTON, disabled: busy, onClick: onRestart,
                  }, TEXT.inactive.restart))
                : h('p', { style: NOTE_STYLE }, TEXT.inactive.noAutorestart),
              message ? h('div', { style: MESSAGE_STYLE }, message) : null))
        }

        // unknown: the host did not say, so nothing is claimed.
        return null
      }

      return {
        inject: ['slots'],
        apply(ctx) {
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
