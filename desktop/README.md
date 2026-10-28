# PGA 浮窗 (desktop)

A new, separate version of PGA's interface: conversations as floating windows above every other window on the Mac,
while the desktop and the apps beneath them stay usable. It talks to the same PGA server; nothing outside `desktop/`
is changed, and the browser version (`src/pga/web`) goes on as it is.

## Two ways of seeing it (⌥⇧Space switches)

- **工作台 (workbench)**: one ordinary window, like the browser version's stage — every conversation in a list on the
  left, and the conversations and nodes as cards on a dotted ground, wired to each other. Cards move by their head and
  size from their corner.
- **桌面 (desktop)**: each of them a window of its own, floating above every other window, the desktop usable around them.

The same windows move between the two without reloading; each remembers where it was in each.

In both: every window has a dot on either side. Pull a wire from a window's right dot onto a conversation, and what
it holds goes to that conversation's agents with every question (a conversation hands over what was asked in it).
Let a wire go on empty space to pick a node for it. Right-click a window (or empty space in the workbench) for every
node there is — a new conversation, an existing one, a note, a file, a skill, a document, a world-tree topic — which
opens beside it, wired in; the same menu cuts wires.

## The browser version's full pages

A conversation window shows the browser version's own full conversation page (everything it has: tools and steps,
attachments, versions, ratings, translation, voice, / prompts, @ agents, the movable composer, the side panel), served
by the PGA server and connected to the desktop app by `Resources/bridge.js` (its title, right-click, wires). Its code is
not copied, so it is always the current one. `"chat": "light"` in config.json uses the desktop app's own small page
instead. **完整版** (the workbench's title bar, the 视图 menu, the Dock menu) opens the whole browser version in a window.

## What it is

- **Native shell** (`Sources/`, Swift, AppKit + WebKit, no Xcode project): an app in the Dock and the menu bar. A click
  on its Dock icon opens the workbench (gathering the windows back into it); right-click it to switch or start a
  conversation; each floating window's head also has a button back to the workbench.
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
