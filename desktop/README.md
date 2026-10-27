# PGA 浮窗 (desktop)

A new, separate version of PGA's interface: conversations as floating windows above every other window on the Mac,
while the desktop and the apps beneath them stay usable. It talks to the same PGA server; nothing outside `desktop/`
is changed, and the browser version (`src/pga/web`) goes on as it is.

## What it is

- **Native shell** (`Sources/`, Swift, AppKit + WebKit, no Xcode project): a menu-bar app.
  - Each floating window is a non-activating panel: above all windows, on every desktop space and over full-screen
    apps, and it does not take the focus from the app you are in. Only its own rectangle is taken, so the desktop
    around it is clicked as usual.
  - ⌥Space anywhere opens a new conversation window (or brings the blank one forward).
  - 📌 in a window's head toggles "above everything"; the windows that are open come back where they were.
  - Files dropped from Finder onto a window are handed over as paths.
  - It serves the interface itself as `pga://app/` and passes `pga://app/v1/…` on to the server (one origin: no CORS,
    no change to the server). If the server is down it starts Docker, the database and the service.
- **Interface** (`ui/`, Svelte 5 + Vite): two pages, compiled to a few small static files.
  - `mode=home`: every conversation; a click floats it out.
  - `mode=float`: one conversation — messages, what the agent is doing right now, the composer.

Its own settings live in `~/Library/Application Support/PGA Desktop/`:

- `config.json`: `server`, `uid` (filled with the installation's owner on first run), and `ui` (a folder to serve the
  interface from while developing, e.g. `~/Documents/PGA/pga/desktop/ui/dist`).
- `floats.json`: the open windows.

## Build and run

```bash
./build.sh            # → build/PGA 浮窗.app
./build.sh --install  # also copy to ~/Applications and start it
```

Working on the interface in a browser: `cd ui && npm run dev`, then open
`http://localhost:5180/?mode=float&uid=<uid>` (or `mode=home`).
