---
name: run-settings-ui
description: Render and screenshot the Bambu Buddy settings window UI (account login / appearance / about) in a headless web session. Use when asked to run the app, screenshot the settings/login UI, or visually verify a change to src/settings/* without a full Electron build.
---

Bambu Buddy is a macOS/Windows Electron desktop app (a desktop panda pet). The
**settings window** — cloud-account login (China SMS/password + overseas browser
login), appearance, about — is pure renderer code: `src/settings/index.html` +
`style.css` + `settings.js`, talking to the main process only through the
`window.bambu` preload bridge (`src/preload-settings.js`).

This skill renders that **exact** renderer in the pre-installed Chromium with a
stubbed `window.bambu`, then screenshots it. Pixel-faithful to the real settings
window. Use it whenever you need to *see* a settings-UI change in a headless
(cloud / web) session.

## Why not the real Electron app

In a cloud web session the Electron binary can't be installed: the repo `.npmrc`
points `electron_mirror` at `npmmirror`, and both that mirror and GitHub releases
are 403'd by the egress proxy; the SessionStart hook also runs
`npm install --ignore-scripts`, skipping the binary download. So there is no
Electron to launch here. The renderer-only path below is the faithful substitute.

**What it does NOT cover:** anything past a button click that hands off to the
main process — most notably the overseas "Sign in with browser" flow actually
popping the official bambulab.com login `BrowserWindow` (needs real Electron + a
real account). It covers every pixel of the settings UI up to that hand-off.

## Prerequisites

Chromium is pre-installed at `$PLAYWRIGHT_BROWSERS_PATH` (`/opt/pw-browsers`).
The driver auto-installs `playwright-core` into the project `node_modules` on
first run (via `registry.npmjs.org`, the only allowed npm host). No `apt-get`
needed — the pre-installed Chromium ships its own libs.

## Run

**Always wrap in `xvfb-run`** — the pre-installed Chromium removed old-headless,
so the driver launches headed and needs a virtual display.

```bash
# The overseas-login feature: overseas (browser login) in EN + ZH, plus the
# China-region form for contrast → 3 PNGs in $SHOT_DIR.
SHOT_DIR=/tmp/shots xvfb-run -a node .claude/skills/run-settings-ui/render.mjs --preset overseas-login

# One-off render, flag-driven:
xvfb-run -a node .claude/skills/run-settings-ui/render.mjs \
  --locale en --section printers --state out --region global --out /tmp/shots/x.png
```

Then **open the PNG and look at it** — a blank frame means the render failed.
Screenshots land in `$SHOT_DIR` (default `/tmp/shots`); the script prints each
`screenshot: <path>`.

### Flags

| flag | values | default | meaning |
|---|---|---|---|
| `--locale` | `en`, `zh-CN` | `en` | UI language |
| `--section` | `printers`, `play`, `appearance`, `about` | `printers` | which settings tab |
| `--state` | `out`, `in` | `out` | account: logged-out (login card) or logged-in (account card) |
| `--region` | `global`, `china` | `global` | login-card region (only matters for `printers` + `state out`) |
| `--out` | path | auto in `$SHOT_DIR` | output PNG |
| `--preset` | `overseas-login` | — | canned multi-shot set; ignores the other flags |

`--region global` shows the overseas browser-login entry + passkey hint;
`--region china` shows the SMS-code / password tabs. That contrast IS the
overseas-login PR: overseas has only the browser entry, no in-app login form.

## Extending

Each render is a fresh page load with injected state — to add a new scenario,
add a `renderOne(...)` call (or a new `--preset`) in `render.mjs`. The
`window.bambu` stub lives in `makeInit()`; add a method there if `settings.js`
starts calling a new preload endpoint (mirror `src/preload-settings.js`).

## Gotchas

- **`--headless=old` removed** — the pre-installed Chromium errors on old
  headless. The driver uses `headless: false`; you must run under `xvfb-run`.
- **playwright-core isn't in package.json** — installed on demand, `--no-save`,
  so it doesn't dirty the repo. Re-installs each fresh container.
- **Not the real Electron app** — see "Why not" above. Don't claim the browser
  login popup itself was exercised; it wasn't.
- **Stale Xvfb locks:** `rm -f /tmp/.X*-lock; pkill Xvfb` if `xvfb-run` hangs.
