# PGA 浮窗 (desktop)

A new, separate version of PGA's interface: conversations as floating windows above every other window on the Mac,
while the desktop and the apps beneath them stay usable. It talks to the same PGA server; nothing outside `desktop/`
is changed, and the browser version (`src/pga/web`) goes on as it is.

## Desktop windows

Every window has a dot on either side. Pull a wire from a window's right dot onto a conversation, and what
it holds goes to that conversation's agents with every question (a conversation hands over what was asked in it).
Let a wire go on empty space to pick a node for it. Right-click a window for every
node there is — a new conversation, an existing one, a note, a file, a skill, a document, a world-tree topic — which
opens beside it, wired in; the same menu cuts wires.

## The browser version's full pages

A conversation window shows the browser version's own full conversation page (everything it has: tools and steps,
attachments, versions, ratings, translation, voice, / prompts, @ agents, the movable composer, the side panel), served
by the PGA server and connected to the desktop app by `Resources/bridge.js` (its title, right-click, wires). Its code is
not copied, so it is always the current one. `"chat": "light"` in config.json opens only the category manager at startup. Choose **打开完整页面** in its header to expand it. **完整版** (the 视图 menu or the Dock menu) opens the whole browser version in a window.

## Web pages inside PGA

In 完整版, choose **更多工具 → 打开网页**, or click a web link in a conversation. The page opens in the existing
page/file workspace beside the conversation. Its address bar supports Return to navigate, back/forward, refresh/stop,
and an external-browser button. **＋** opens another page; **⛶** expands the workspace. ⌘L focuses the address,
⌘W closes the current page, and Ctrl+Tab switches workspace tabs. PDF and office-file links keep their document viewers.

The desktop uses isolated WebKit views with persistent site data inside PGA. Chrome's profile, extensions, and login
cookies are not imported. Websites do not receive PGA's native bridge or local-file access. Pages that require a
full external browser can still be opened there using the arrow next to the address.

At most two unedited website renderers per PGA window stay loaded. Inactive pages pause media; hiding the workspace
releases unedited website renderers after 30 seconds. Pages where the user has entered text are retained to protect
unfinished forms. Returning to a released page reloads its last address (site cookies remain, but its in-memory
back/forward history is not retained). An isolated script reports field-edit activity only, never field contents.

## Reminders and the 管理员小窗

- **When an agent has finished**: the app asks the server every 2.5 s what its agents are doing (`GET /v1/agents/live`,
  nothing on the server changes). When the last run of a conversation ends, a notification pops up (its title, the
  category and agent, the start of the answer); an agent that failed, or one waiting for your approval, is told too.
  The Dock icon gets a red badge with how many conversations have news, and the menu-bar icon a red dot. Nothing pops up
  for a conversation that finished in front of you (its window, its category's manager, its page in view on 完整版's stage).
  If macOS does not let the app post notifications, it shows a banner of its own at the top right.
- **A click** on the notification — or on the Dock icon while it has a badge — opens that category's manager in a small
  window of its own, not the whole of PGA (an approval opens the conversation that asks). Right-click the Dock icon (or
  the menu-bar icon) for the list of news, 全部标为已读, and 管理员小窗 → any category.
- **The 管理员小窗**: just the manager's page. 📌 in its head keeps it above every other window and on every desktop space;
  the window button next to it opens the same manager on 完整版's stage. A task's 查看处理对话 (or a title in its list)
  floats that conversation out beside it, at that input; a double-click edit is done on 完整版's stage, which it needs.
  Each category's window remembers where it was and whether it was pinned.
- What has news is cleared when you look at it, and kept in `alerts.json` until then; the menu-bar menu turns reminders off.

## Desktop cat companion

The cat can be dragged directly. Its head turns and its front paw scratches its cheek on an idle loop;
three cloud layers continuously move right to left. Reduce Motion stops these animations.
The rounded conversation inbox stays horizontally centered over the cat when opened or collapsed.

Clicking the cat or its new-message label opens the newest unread conversation in the main PGA stage.
Clicking an inbox row opens that specific conversation there. Successful navigation clears the native
badge and the stage's unread marker; failed navigation retains the reminder. Read state survives restart,
and duplicate delivery of the same event stays read. A new reply in that conversation can notify again.
With no unread messages, clicking the cat toggles its recent-conversation list.

Mouse interaction: moving within about 100 points of the cat makes its head and both independent pupils look toward the pointer. Pupils move horizontally and vertically inside clipped eye openings, return to center when the pointer leaves, and stay underneath the blinking/petting eyelids.
Sweep back and forth over the head without holding a button to pet it: it tilts its head, gently returns to neutral, closes its eyes and shows
one small heart (with a cooldown). Dragging adds a bounded tilt, then settles at the dropped position.
Right-click for **摸摸头** or **查看会话列表**. These gestures preserve the normal unread-message click;
Reduce Motion also disables mouse-driven animation. Pointer sampling only reads the cursor position,
without a global event tap, and its timer is released when the companion view leaves its window.

Interaction references: [Neco](https://github.com/winebarrel/Neco) (cursor response) and
[VS Code Pets](https://github.com/tonybaloney/vscode-pets/blob/main/docs/pets.md) (hover/play interaction).
The implementation uses PGA's existing native artwork and layers.


## What it is

- **Native shell** (`Sources/`, Swift, AppKit + WebKit, no Xcode project): an app in the Dock and the menu bar. Click the Dock icon to open the latest alert or the full interface. Right-click it to start a conversation.
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

## 桌宠音乐响应

右键猫猫 →「音乐响应（系统声音）」开启，再点关闭。每次启动默认关闭。
首次需要在 macOS「隐私与安全性 → 屏幕与系统音频录制」允许 PGA；如果系统要求重启 App，重启后再开启。
通过 ScreenCaptureKit 在本机提取系统音量与突发节拍，只注册音频输出，不接收屏幕图像、不使用麦克风、不保存或上传音频。
猫猫随音量轻轻起伏，节拍触发跳动与金色光晕；静音恢复、拖动暂停跳动。系统开启“减少动态效果”时只保留淡淡的静态光晕。

验证：`tests/test_pet_music.swift` 使用合成音频幅度验证起音、静音与重复触发抑制；`tests/test_pet_companion.swift` 验证菜单、视觉状态与减少动态效果。
