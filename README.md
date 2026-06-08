# AV Readiness

Desktop app port of the **NYC Daily AV-Readiness Checklist**. It's the existing
single-file HTML tool rebuilt as a real `.app` (macOS) / `.exe` (Windows) using
Electron, with native local storage and native file saving in place of the
browser's `localStorage` and download/File-System-Access plumbing.

It is **local-first**: no SharePoint, no OneDrive integration, no cloud sync, no
email automation. Sending the report is a manual action the agent takes.

---

## What it does

A daily checklist of AV/IT readiness tests across the NYC office rooms.

- **Cadence-aware** — auto-detects today's layers (Daily / Monday / Friday /
  Bi-weekly / Monthly / Quarterly) from the date; the agent can override.
- **Room-grouped** — tests render under their room; rooms are reorderable.
- **Pass / Fail per test** — on a fail, the agent writes a note.
- **End-of-walk Ticket Queue** — every failed test becomes a row with an
  "Open in ServiceNow" button (opens a pre-filled catalog form in the default
  browser) plus a paste-back ticket-# field.
- **Save & generate report** — produces one polished light-theme HTML report
  with an embedded CSV and a "Download CSV" button inside it.
- **Cumulative audit log** — every save appends to a local audit log; the
  **📊 CSV** button exports the full log on demand.
- **Multi-agent** — agent dropdown; sessions are keyed by `<date>.<agent-slug>`.
- **Heal / backfill** — pick a prior date to fill in a missed session.

The operator UI is dark theme; the leadership-facing report is light theme.

---

## Architecture

```
main.js               Electron main process — window, IPC handlers, menus
preload.js            contextBridge → exposes window.avAPI to the renderer
src/main/store.js     JSON key/value store under app.getPath('userData')
src/renderer/
  index.html          markup (split out of the original single file)
  styles.css          operator-tool dark theme
  renderer.js         the original tool's logic, with native I/O routed
                      through window.avAPI
.github/workflows/
  build.yml           GitHub Actions — builds unsigned Mac + Windows artifacts
```

### The native bridge (`window.avAPI`)

The original browser tool used `localStorage`, the File System Access API / blob
downloads, `navigator.clipboard`, and `<a target="_blank">` links. In the port
those route through the preload bridge:

| Original (browser)            | Port (Electron)                                  |
|-------------------------------|--------------------------------------------------|
| `localStorage`                | `avAPI.store` → JSON file in `userData`           |
| `showSaveFilePicker` / blob   | `avAPI.saveFile` → native Save dialog + `fs`      |
| `<a target="_blank">`         | `avAPI.openExternal` → default browser            |
| `navigator.clipboard`         | `avAPI.readClipboard` → Electron `clipboard`      |

`LS` in `renderer.js` is a synchronous facade over `avAPI.store`, hydrated once
at startup, so the original synchronous read/write code is preserved unchanged
while writes persist to disk asynchronously.

### Where data lives

- **App state + audit log:** `app.getPath('userData')/av-readiness-data.json`
  - macOS: `~/Library/Application Support/AV Readiness/`
  - Windows: `%APPDATA%\AV Readiness\`
- **Reports / CSV exports:** wherever the agent chooses in the Save dialog.

---

## Building

Builds run in **GitHub Actions** (`.github/workflows/build.yml`) on every push
to a `claude/**` branch, or on manual dispatch. The workflow produces unsigned
artifacts for both platforms and attaches them to the run:

- macOS (arm64): `.dmg` and `.zip`
- Windows (x64): `.exe` (NSIS installer) and `.zip`

Download them from the **Actions → run → Artifacts** section.

### Running locally (if you have Node)

```sh
npm install
npm start          # launch the app
npm run dist       # build installers for the current platform
```

---

## First launch (unsigned app)

The builds are intentionally **unsigned** (internal tool, 2–5 users), so the OS
will warn on first open. This is expected — do it once per machine:

- **macOS:** right-click the app → **Open** → **Open** in the dialog. (Or
  System Settings → Privacy & Security → "Open Anyway".)
- **Windows:** on the SmartScreen prompt, click **More info → Run anyway**.

After the first launch the OS remembers the app and opens it normally.

---

## ServiceNow

Integration is **URL-prefill only**: the Ticket Queue opens the Genpact ESC
catalog item ("IT Administrative Activities") in the default browser with as
many fields pre-populated as URL params allow. The agent submits it in
ServiceNow and pastes the ticket # back. The app never reads or writes
ServiceNow records.
