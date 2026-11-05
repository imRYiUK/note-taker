# note-taker — Implementation Plan

Use the Samsung S23 Ultra + S Pen as the writing surface ("paper") and render the ink
live on the PC, where notes are read, organized, and exported.

---

## 0. Decisions (defaults — change any of them before starting)

| Topic | Decision | Why |
|---|---|---|
| Phone client | **Web page** (Chrome on Android), installable as PWA | No app to build/install; Pointer Events give pressure, tilt, hover, coalesced samples |
| PC viewer | **Browser page** (Chromium `--app` window) | Fastest to build; can be wrapped natively later |
| Server | **Bun + TypeScript** (`Bun.serve` HTTP + WebSocket, `bun:sqlite`) | One language end-to-end, shared protocol types, built-in SQLite, already installed |
| Transport | **WebSocket** over **USB (`adb reverse`)** by default, Wi-Fi as fallback | USB = lowest latency + `localhost` is a secure context (wake lock, PWA, fullscreen) |
| Data | **Vector strokes** in page units, not pixels/video | Tiny bandwidth, crisp at any zoom, editable, exportable, OCR-able later |
| Ink rendering | **perfect-freehand** → filled `Path2D` | Natural pressure-sensitive ink with minimal code |
| Phone display | **Shows ink** by default, toggle "blank pad" mode | Paper feel by default; blank saves battery / tablet feel |
| Storage | **SQLite** at `~/.local/share/note-taker/notes.db` | Durable, crash-safe, single file, easy backups |
| Platform | Linux first (Omarchy/Hyprland) | Your machine; nothing in the design is Linux-only |

---

## 1. Architecture

```
 S23 Ultra — Chrome (fullscreen, landscape)               PC (Linux)
 ┌──────────────────────────────────────┐            ┌────────────────────────────────────┐
 │ /pad                                  │            │ Bun server :7777                   │
 │  • Pointer Events (pen only draws)    │  WebSocket │  • serves /pad and /viewer         │
 │  • local low-latency canvas           │ ─────────▶ │  • WS hub: validates + broadcasts  │
 │  • zoom-strip / tablet mapping        │  strokes,  │  • authoritative notebook state    │
 │  • auto-advance logic                 │  hover,    │  • undo/redo op stack              │
 │  • finger = pan / gestures            │  viewport  │  • SQLite persistence              │
 └──────────────────────────────────────┘ ◀───────── │  • export (SVG / PDF)              │
                                          snapshots, └──────────────┬─────────────────────┘
                                          ops, viewport             │ WebSocket
                                                       ┌────────────▼─────────────────────┐
                                                       │ /viewer (Chromium --app window)  │
                                                       │  • full page(s), zoom & scroll   │
                                                       │  • live stroke + hover cursor    │
                                                       │  • strip rectangle overlay       │
                                                       │  • notebooks, pages, export UI   │
                                                       └──────────────────────────────────┘
```

**Principles**
- The phone renders its own ink immediately (never waits for the network).
- The server is the single source of truth; every client can resync from a snapshot.
- All geometry is in **page units** so phone/PC resolution and zoom don't matter.

---

## 2. Repository layout

```
note-taker/
├─ package.json            # bun workspace scripts
├─ bunfig.toml
├─ tsconfig.json
├─ src/
│  ├─ shared/
│  │  ├─ protocol.ts       # message types + runtime validation (zod or hand-rolled)
│  │  ├─ geometry.ts       # Rect, page units, screen<->page transforms
│  │  ├─ ink.ts            # perfect-freehand wrapper → Path2D / SVG path string
│  │  ├─ templates.ts      # blank / lined / grid / dotted page backgrounds
│  │  └─ strip.ts          # zoom-strip auto-advance state machine (pure, testable)
│  ├─ server/
│  │  ├─ main.ts           # Bun.serve: routes, WS upgrade, auth token
│  │  ├─ hub.ts            # connection registry, broadcast, per-role routing
│  │  ├─ store.ts          # SQLite schema + queries
│  │  ├─ notebook.ts       # in-memory state, apply ops, undo/redo
│  │  ├─ export.ts         # SVG + PDF (pdf-lib) export
│  │  ├─ adb.ts            # auto `adb reverse` when a device appears
│  │  └─ net.ts            # LAN IP discovery, QR pairing URL
│  ├─ pad/                 # phone client
│  │  ├─ index.html
│  │  ├─ pad.ts            # input pipeline, modes, WS client
│  │  ├─ canvas.ts         # desynchronized canvas, live + committed layers
│  │  ├─ gestures.ts       # finger pan / two-finger tap undo / pinch
│  │  ├─ toolbar.ts        # pen/highlighter/eraser, colors, mode switch
│  │  └─ manifest.webmanifest
│  └─ viewer/              # PC client
│     ├─ index.html
│     ├─ viewer.ts         # WS client, state, routing UI
│     ├─ renderer.ts       # page canvases, stroke cache, live layer
│     ├─ camera.ts         # zoom/pan of the PC view
│     ├─ overlay.ts        # strip rectangle, hover cursor, latency HUD
│     └─ sidebar.ts        # notebooks, pages, export
├─ scripts/
│  └─ note-taker           # launcher: start server, adb reverse, open viewer window
└─ test/
   ├─ strip.test.ts
   ├─ geometry.test.ts
   ├─ notebook.test.ts
   └─ protocol.test.ts
```

Dependencies (kept minimal): `perfect-freehand`, `pdf-lib`, `qrcode`, (optional) `zod`.

---

## 3. Coordinate system & data model

### Page units
- 1 unit = 0.1 mm. A4 page = **2100 × 2970** units (portrait).
- "Infinite" page type: fixed width 2100, height grows as you write.
- Every point: `[x, y, pressure, t]`. `x,y` page units (float, rounded to 0.1),
  `pressure` 0–1, `t` ms since stroke start. Tilt kept optional (`tiltX, tiltY`) for v2 brushes.

### Entities
```ts
Notebook { id, title, createdAt, updatedAt, template }   // template: blank|lined|grid|dotted
Page     { id, notebookId, index, kind: 'a4'|'infinite', height }
Stroke   { id (uuid from client), pageId, tool: 'pen'|'highlighter',
           color, width, points: Float32Array, createdAt, deletedAt? }
Op       { seq, notebookId, kind: 'add'|'erase'|'move', strokeIds, payload, undone }
```

### SQLite schema
```sql
CREATE TABLE notebooks (id TEXT PRIMARY KEY, title TEXT, template TEXT,
                        created_at INTEGER, updated_at INTEGER);
CREATE TABLE pages     (id TEXT PRIMARY KEY, notebook_id TEXT, idx INTEGER,
                        kind TEXT, height REAL);
CREATE TABLE strokes   (id TEXT PRIMARY KEY, page_id TEXT, tool TEXT, color TEXT,
                        width REAL, points BLOB, created_at INTEGER, deleted_at INTEGER);
CREATE TABLE ops       (seq INTEGER PRIMARY KEY AUTOINCREMENT, notebook_id TEXT,
                        kind TEXT, payload TEXT, undone INTEGER DEFAULT 0);
CREATE INDEX strokes_page ON strokes(page_id) WHERE deleted_at IS NULL;
```
- Points stored as packed `Float32Array` (4 floats/point) → ~16 bytes/point.
- Erase = soft delete (`deleted_at`) so undo is trivial.
- WAL mode on; write each finished stroke in one transaction.

---

## 4. Wire protocol (JSON over WebSocket, v1)

Every message: `{ "type": string, ...payload }`. Client→server messages carry a `cseq`
(client sequence) for acks/dedupe.

### Client → server
| type | payload | sent by |
|---|---|---|
| `hello` | `{ role: 'pad'\|'viewer', token, deviceId, protocol: 1 }` | both |
| `stroke.begin` | `{ id, pageId, tool, color, width }` | pad |
| `stroke.points` | `{ id, pts: number[] }` (flat `[x,y,p,t,...]`, batched per frame) | pad |
| `stroke.end` | `{ id }` | pad |
| `stroke.cancel` | `{ id }` (e.g. palm/accidental) | pad |
| `erase` | `{ pageId, strokeIds }` | pad, viewer |
| `undo` / `redo` | `{ notebookId }` | pad, viewer |
| `hover` | `{ pageId, x, y }` or `{ leave: true }` (throttled 60 Hz) | pad |
| `viewport` | `{ pageId, rect }` (strip position in page units) | pad, viewer |
| `page.new` / `page.goto` | `{ notebookId, afterPageId? }` / `{ pageId }` | both |
| `notebook.open` / `notebook.new` | `{ id }` / `{ title, template }` | viewer |
| `ping` | `{ t }` | both |

### Server → clients
| type | payload |
|---|---|
| `welcome` | `{ serverTime, snapshot }` — current notebook, page list, strokes of active page(s), strip rect |
| `stroke.*` | rebroadcast of live stroke messages to viewers (and other pads) |
| `op.applied` | `{ seq, op }` — committed add/erase/undo/redo, for all clients |
| `viewport` | strip rect broadcast (viewer draws rectangle; pad follows if moved from PC) |
| `hover` | forwarded to viewers |
| `page.changed` | `{ pageId, pages }` |
| `ack` | `{ cseq }` |
| `pong` | `{ t, serverTime }` — used for clock offset + latency HUD |
| `error` | `{ code, message }` |

**Reliability**
- Pad keeps an outbox of un-acked finished strokes; on reconnect it resends them
  (server dedupes by stroke `id`), then requests a snapshot.
- Live `stroke.points` are fire-and-forget; `stroke.end` carries the final point count
  and the server requests a full resend (`stroke.resync`) if counts mismatch.
- v2 option: switch hot-path messages to a compact binary frame if JSON shows up in profiles.

---

## 5. Phone client (`/pad`) — details

### Input pipeline
1. One `<canvas>` covering the screen, CSS `touch-action: none`, context
   `getContext('2d', { desynchronized: true, alpha: false })` for low-latency ink.
2. `pointerdown/move/up/cancel` listeners:
   - `pointerType === 'pen'` → drawing.
   - `pointerType === 'touch'` → gestures only (never ink) — this is palm rejection.
   - While a pen pointer is active or hovering, ignore all touch except two-finger gestures.
3. On `pointermove` use `getCoalescedEvents()` to get every hardware sample (S Pen ≈ 240 Hz);
   use `getPredictedEvents()` only for the *local* live stroke tail (not sent, not saved).
4. Hover: pen `pointermove` with `buttons === 0` → send throttled `hover`.
5. S Pen side button: `buttons & 2` while touching → temporary eraser.
   Fallback: on-screen eraser toggle (Samsung's Air Command may intercept the button).
6. Convert screen px → page units via the current mode's transform; send batched
   points once per animation frame.

### Rendering on the phone
- Two layers: **committed** (offscreen bitmap of finished strokes in the visible area)
  and **live** (current stroke, redrawn each frame with perfect-freehand).
- On stroke end, draw the final stroke into the committed bitmap.
- Page template (lines/grid) drawn under the ink, scaled to the strip.
- "Blank pad" toggle: black background, no ink drawn (saves battery, tablet feel).

### Modes
**Zoom-strip mode (default)**
- The phone shows a rectangular window (`rect` in page units) of the current page,
  magnified so that one writing line ≈ comfortable phone height.
- Magnification adjustable (pinch with two fingers), default ~3×.
- Auto-advance (implemented as a pure state machine in `shared/strip.ts`):
  - Advance zone = right 20 % of the strip.
  - Pen-up in the advance zone → after 350 ms with no new pen-down nearby, shift the strip
    right by 60 % of its width (animated 120 ms).
  - At the right page margin → wrap to the left margin and move down one line height.
  - Pen-down while a shift is pending → cancel the shift (you were still writing).
- Manual control: one-finger drag pans the strip; viewer can click/drag the rectangle
  to move it; buttons for "new line" and "back".
- Left-side "margin handle" (narrow vertical bar) to jump to next line quickly.

**Tablet mode**
- The phone surface maps onto the viewer's visible page area (viewer reports its
  viewport); aspect-ratio letterboxed.
- Phone can go blank; PC shows the hover cursor so eyes stay on the monitor.

### Toolbar (auto-hides while writing, edge-swipe to reveal)
Pen / highlighter / eraser · 4 colors + custom · 3 widths · undo/redo ·
mode switch (strip/tablet) · blank-pad toggle · page prev/next/new · connection status dot.

### Screen & app behavior
- `navigator.wakeLock.request('screen')` (works on `localhost` via adb reverse).
- Fullscreen + `screen.orientation.lock('landscape')` on first tap.
- PWA manifest (`display: fullscreen`) so it launches like an app from the home screen.
- Gestures: two-finger tap = undo, three-finger tap = redo.

---

## 6. PC viewer (`/viewer`) — details

- Opened as a Chromium app window: `chromium --app=http://localhost:7777/viewer`.
- **Renderer**
  - Pages laid out vertically (continuous scroll), each with its template background.
  - Per-page offscreen cache of committed strokes; re-rasterized only when zoom changes
    by a threshold or strokes change (debounced).
  - Live layer on top for in-progress strokes from the pad (smooth, rAF-driven).
- **Camera:** scroll/zoom with mouse & keyboard (`Ctrl+wheel`, `Ctrl+0` fit width,
  `Space`+drag pan). Auto-follow: keeps the strip rectangle in view while you write
  (toggle).
- **Overlay:** strip rectangle (draggable to reposition), hover cursor dot,
  optional latency HUD (`Ctrl+Shift+L`).
- **Sidebar:** notebooks list, page thumbnails, new notebook (with template), rename,
  delete, export.
- **Keyboard:** `Ctrl+Z` / `Ctrl+Shift+Z` undo/redo, `PageUp/Down` change page,
  `Ctrl+E` export.
- **Pairing panel:** shows connection status, USB vs Wi-Fi, and a QR code for Wi-Fi pairing.

---

## 7. Server — details

- `Bun.serve` on `0.0.0.0:7777` (Wi-Fi) — bind to `127.0.0.1` only when `--usb-only`.
- Routes: `/pad`, `/viewer` (Bun HTML bundling), `/api/export/:pageId.svg`,
  `/api/export/:notebookId.pdf`, `/ws`.
- **Auth:** random token generated on first run (stored in config); pad URL / QR contains
  `?token=…`; WebSocket `hello` must present it. Localhost connections still need it
  (cheap and safe).
- **Hub:** tracks clients by role; rebroadcasts live stroke messages to viewers instantly;
  commits strokes to the notebook on `stroke.end`.
- **Notebook state:** active notebook + page in memory; op stack for undo/redo shared by
  all clients (undo from PC or phone does the same thing).
- **adb helper:** every 2 s run `adb devices`; when the phone appears, run
  `adb reverse tcp:7777 tcp:7777` and log "USB connected". Re-run after reconnects.
- **Config:** `~/.config/note-taker/config.json` (port, token, defaults).
- **Logs:** structured console logs; `--debug` adds per-message timing.

---

## 8. Connectivity

**USB (recommended)**
1. Enable Developer options → USB debugging on the phone (one time).
2. Plug in; `scripts/note-taker` auto-runs `adb reverse tcp:7777 tcp:7777`.
3. Phone opens `http://localhost:7777/pad?token=…` (bookmark / PWA icon).

**Wi-Fi**
1. Viewer shows a QR code for `http://<lan-ip>:7777/pad?token=…`.
2. Scan with the phone camera.
3. Limitation: plain `http://` on a LAN IP is not a secure context → no wake lock / PWA.
   Fixes (pick later): local self-signed cert (`mkcert`) or Chrome flag
   `unsafely-treat-insecure-origin-as-secure` for that origin.

---

## 9. Latency budget & strategy

| Stage | Target |
|---|---|
| Pen → phone local ink | < 10 ms (desynchronized canvas + predicted events) |
| Phone → server (USB) | < 5 ms |
| Phone → server (Wi-Fi) | < 20 ms typical |
| Server → viewer → paint | < 16 ms (next frame) |
| **End-to-end pen → PC pixel** | **< 30 ms USB, < 50 ms Wi-Fi** |

- Batch points per animation frame (~16 ms) — don't send per event.
- Ensure TCP_NODELAY behavior (measure; Bun WS should not Nagle-batch).
- Clock sync via `ping/pong` → HUD shows real end-to-end latency (pad timestamp vs viewer paint).
- If Wi-Fi jitter is bad: viewer interpolates the live stroke slightly behind real time.

---

## 10. Export

- **SVG per page:** perfect-freehand outline → `<path d=…>`, template as background group.
- **PDF per notebook:** `pdf-lib`, one page per note page, `drawSvgPath` for each stroke
  (vector, small files). Page size A4; infinite pages split or scaled (option).
- **PNG** (quick share): render page canvas → `toBlob`.
- v3: Markdown export for Obsidian (`note.md` + `page-N.svg` embeds).

---

## 11. Milestones

Each milestone ends with a working, usable state. Estimates assume part-time work.

### M0 — Skeleton (½ day)
- [x] `bun init`, tsconfig, `bun test` wired. *(lint/format deferred)*
- [x] `Bun.serve` serving `/pad`, `/viewer` and `/probe`.
- [x] `hello/welcome` handshake, token check for LAN (loopback/USB trusted), ping/pong RTT, auto-reconnect.
- [x] `scripts/note-taker` launcher: start server, open viewer window; server keeps `adb reverse` alive.
- [x] S Pen probe page (first-day checklist step 2) + viewer shows the report.
- [x] **On device:** phone connects over USB, probe report sent (2026-11-05, see §15).
- **Done when:** phone over USB shows "connected" and the viewer lists it.

### M1 — Live ink MVP (1–2 days)
- [x] Pad: pen-only input, coalesced samples, pressure, desynchronized canvas, predicted tail.
- [x] Shared `ink.ts` (perfect-freehand) used by both clients.
- [x] Protocol: `stroke.begin/points/end/cancel`, batched per frame; `snapshot`, `stroke.added`,
      `page.clear`, `settings`. Stroke begun on an older connection is re-sent on reconnect.
- [x] Viewer: single A4 page, live layer + committed cache, fit-to-width (`F` toggles fit-page),
      follow-pen scroll; M0 dashboard moved to a side panel.
- [x] Pad uses **tablet mapping** of the whole page (simplest mapping) for now — hold the phone
      in portrait for the biggest page.
- [x] **Pressure curve** (see §15): normalize raw pressure (`p / pMax`, default `pMax = 0.45`,
      clamp, gamma ≈ 0.8), adjustable in the viewer's Ink panel (with a "use my measured
      pressure" button), persisted in config.json; *raw* pressure stored, curve applied at render.
- [x] Touch ignored for ink (palm rejection).
- [x] **On device:** strokes from the S23 over USB appear live on the PC (2026-11-05).
- **Done when:** writing on the phone appears on the PC in real time, pressure visible,
  palm doesn't draw.

### M2 — Persistence & reliability (1 day)
- [x] SQLite store, schema, WAL (`~/.local/share/note-taker/notes.db`; points packed Float32,
      strictly increasing `created_at` = paint order).
- [x] Commit strokes on `stroke.end` (stroke + undo op in one transaction); snapshot on connect.
- [x] Pad outbox (also in localStorage) + resend on reconnect; server dedupes by stroke id and
      acks (`stroke.ack`); point-count mismatch → `stroke.resync`. A reconnecting pad takes over
      its stroke still live on the dead socket. Client silence watchdog (6 s) + server
      `idleTimeout` detect dead sockets after Wi-Fi drops.
- [x] Undo/redo (server op stack shared by all clients, persisted) from pad buttons, two-/three-finger
      tap and viewer `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y`. Clear page is one undoable step.
- [x] Stroke eraser (capsule hit-test against the stroke centerline + half width, `shared/hit.ts`)
      via **toolbar toggle** (side button not delivered to Chrome — see §15); one eraser gesture
      = one undo step.
- [ ] **On device:** kill/restart server and toggle Wi-Fi mid-writing on the S23.
- **Done when:** kill/restart server or toggle Wi-Fi mid-writing → nothing lost,
  both sides show identical pages.

### M3 — Zoom-strip mode (2 days) ← *the core feature*
- [ ] `shared/strip.ts` state machine + unit tests (advance, wrap, cancel).
- [ ] Pad renders the strip region magnified with template lines.
- [ ] Auto-advance with animation; manual finger pan; "new line" button.
- [ ] `viewport` messages; viewer draws the draggable strip rectangle; viewer drag moves strip.
- [ ] Pinch to change magnification; settings persisted.
- **Done when:** you can write a full A4 page of normal-sized handwriting from the phone
  without ever manually moving the strip in normal use.

### M4 — Notebooks, pages, templates (1–2 days)
- [ ] Multiple notebooks, multiple pages, infinite page kind.
- [ ] Templates: blank / lined / grid / dotted.
- [ ] Viewer sidebar: notebooks, thumbnails, rename/delete.
- [ ] Page prev/next/new from phone toolbar.
- **Done when:** you can keep a real class/meeting notebook across days.

### M5 — Polish of the writing experience (1–2 days)
- [ ] Toolbar (auto-hide), colors, widths, highlighter (multiply blend, under ink).
- [ ] Hover → PC cursor; tablet mode with blank-pad toggle.
- [ ] Wake lock, fullscreen, landscape lock, PWA install.
- [ ] Latency HUD + measured numbers recorded in README.
- **Done when:** it feels like a product, not a prototype.

### M6 — Export & Wi-Fi pairing (1 day)
- [ ] SVG / PDF / PNG export.
- [ ] QR pairing for Wi-Fi; LAN IP detection; optional mkcert HTTPS.
- **Done when:** a notebook exports to a clean vector PDF; phone pairs by QR.

### Later (v2/v3 backlog)
- Lasso select → move / recolor / delete.
- Partial (pixel-precise) eraser that splits strokes.
- Typed text boxes on the PC mixed with handwriting.
- Image/PDF import to annotate (lecture slides!).
- Handwriting search/OCR — options: Google ML Kit Digital Ink Recognition (on-device,
  stroke-based, needs a native Android companion) or a local server-side model.
- Markdown/Obsidian export.
- Native wrappers: Kotlin pad app (lower latency, S Pen SDK button events);
  native viewer window if the browser becomes limiting.
- Multi-pad (two phones/tablets on one notebook) — protocol already allows it.

---

## 12. Testing

- **Unit (`bun test`):** geometry transforms, strip state machine, notebook op/undo logic,
  protocol validation, packing/unpacking of points, eraser hit-testing.
- **Integration:** spin up server in-process, connect fake pad + fake viewer WS clients,
  replay a recorded stroke session, assert DB contents and broadcasts.
- **Recorded sessions:** pad has a hidden "record" toggle that saves raw input events to
  JSON → reused as fixtures for regression tests and latency benchmarks.
- **Manual device checklist (per milestone):** pressure range, palm on screen while
  writing, side-button erase, hover, rotate phone, lock/unlock phone, unplug/replug USB,
  server restart, 30-minute writing session (battery, memory).

---

## 13. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Samsung intercepts the S Pen side button (Air Command / Air actions) | **Confirmed on device (§15).** On-screen eraser/undo + finger gestures; retest with Air actions off; native app later |
| Chrome hover events not delivered for S Pen | Verify in M0 on the device; tablet mode still works without hover, just no cursor |
| Wi-Fi latency/jitter | USB is the default; interpolation on viewer; measure with HUD |
| Insecure context over LAN | USB/localhost by default; mkcert option for Wi-Fi |
| Perf with thousands of strokes per page | Cached committed bitmaps; spatial index (grid buckets) for eraser hit-tests |
| Phone battery/heat during long sessions | Blank-pad mode, only redraw dirty regions, no idle rAF loop |
| Data loss | SQLite WAL, commit per stroke, pad outbox, periodic DB backup copy |

---

## 14. First-day checklist

1. M0 skeleton + launcher.
2. On the phone, open a tiny test page that logs `pointerType`, `pressure`, `buttons`,
   hover moves, and coalesced-event counts — confirms the S Pen capabilities everything
   else depends on.
3. Start M1.

---

## 15. Device findings — S23 Ultra, Chrome 156 (probe 2026-11-05, USB)

| Capability | Result | Consequence |
|---|---|---|
| Pen vs. touch separation | ✓ pen = `pen`, palm/finger = `touch` | Palm rejection = ignore `touch` for ink. Done. |
| Pressure | ✓ 334 distinct levels, but **max 0.37** in normal writing | Needs a pressure curve (normalize to ~0.45 max), otherwise ink looks thin |
| Tilt / altitude | ✓ ±25° seen | Available for future brushes |
| Hover | ✓ reported (few events in this run) | PC cursor feasible; measure hover rate in M5 |
| Side button | ✗ `buttons` only ever 0/1, no contextmenu | Samsung consumes it → on-screen eraser/undo + gestures |
| Sample rate | ✓ ~240–480 Hz, ~1 sample per `pointermove` | Must batch per animation frame before sending |
| Predicted events | ✓ ~7 per event | Use for local ink tail → lower perceived latency |
| Low-latency canvas | ✓ `desynchronized` | Use it on the pad |
| Secure context / wake lock | ✓ over USB (`localhost`) | Screen stays on |
| Screen (CSS px) | 824×384 @3.75x landscape (790×298 with browser UI) | Fullscreen matters: +29 % height. Strip ≈ 384 px tall |
| User agent | reduced (`Android 10; K`) | Can't detect the model from the UA; adb provides it |
