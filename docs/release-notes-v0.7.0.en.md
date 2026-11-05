# dsh-cua-driver-indicator v0.7.0

> Ready to paste into the GitHub Release editor. The Chinese version of the same notes is in
> `CHANGELOG.md`.

## What this release does

This release adds the thing people kept running into: **the plugin draws the banner for DSH's
official computer-control channel, and that channel is not part of the default composition.**
Before this release, installing the plugin and seeing no banner was indistinguishable from a
broken plugin. Now the plugin asks.

- **Five states of the official channel** (`lib/provider.mjs`, pure logic, unit-testable):
  `available` / `installed-disabled` / `installed-inactive` / `missing` / `unknown`. The state
  is **re-read live** on every start - it is never a value cached at start-up, so the popup
  closes itself as soon as the official channel shows up.
- **A popup asks you** when the state is `missing`: a title saying this plugin needs DSH's
  official "computer control" plugin, three sentences of body text, and the buttons
  "Install the official computer-control plugin" / "Not now". Choosing "Not now" leaves one
  line in the corner - the plugin is unavailable for now and will ask again on the next start.
- **One-click install**: it goes through **the host's own plugin pipeline** and pulls whatever
  the official packages currently publish. **No fixed version of an official package appears
  in this repository** - the official packages move with the host, so a pinned version would
  be wrong twice a year.
- **The install is verified for real**: after the install, the host's own plugin list is read
  again, and only **both official rows being there AND both being enabled** counts as
  installed. One row alone does not, and that case says so instead of claiming it worked.
- **Four different answers**: installed / half-installed (one row only) / overridden by
  another configuration layer / failed. Each one has its own wording instead of one vague
  "it worked".
- **The restart is the user's call**: the plugin only says that DSH has to be restarted once.
  When the host has the auto-restart plugin, the `installed-inactive` card also offers a
  "Restart now" button.
- **Windows only**: the native implementation of the official channel is the Windows Cua
  Driver. **A hosted instance inside WSL, macOS and Linux are not supported, and this plugin
  is not tested there.**

## Two fixes found on a real machine

Both of them made the new feature **completely non-functional** on a real machine - the popup
never appeared at all. They are fixed now, and the fix was verified on a real machine.

- **The route was not under `/api/`.** The host only hands paths under `/api/` to plugins, and
  the plugin registered its state route as `/__dsh_cua_indicator/provider` - without the
  `/api` prefix. The browser request therefore got a **401**, the panel treated the state as
  "unknown" and drew nothing. (A control reading from the same host: a path that does not
  exist at all returns the same **401**, so "401" alone does not tell you the route is
  missing.) The route is now `/api/__dsh_cua_indicator/provider`.
- **The route was registered before the web server was up.** When a plugin mounts, the host's
  web server often does not exist yet; the plugin used to grab the service synchronously and
  give up when it was not there - so the route was **never registered**. The route is now
  registered **when the web server becomes ready** (the same shape `dsh-goal-board` uses for
  its own state route).

**Real-machine reading after the fix**: `GET /api/__dsh_cua_indicator/provider` returns
**200** with `status: "installed-disabled"`, and the screen shows the
"the official computer-control plugin is installed, but not enabled" card.

## Also in this release

- The **readme is English by default** now (GitHub and npm both show `README.md`); the
  Chinese one is kept as `README.zh.md`, and the two link to each other at the top.
- The **install package is published on its own**:
  `dsh-cua-driver-indicator-provider` - a provider bundle that inserts the two official rows.
  It is not shipped inside this package, and it has no code of its own: just a patch file
  and a readme.

## Install

```powershell
dsh plugin --profile <profile> add dsh-cua-driver-indicator
```

Restart DSH afterwards - plugins and their configuration are loaded at start-up.

## Notes

- The official channel is a **precondition** for this plugin: without it there is no banner
  and no way to stop a takeover with Esc. The plugin now says so instead of looking broken.
- Uninstalling this plugin does **not** remove the two official rows - they belong to the
  provider bundle.
