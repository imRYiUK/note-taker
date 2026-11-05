# note-taker

Write with the S Pen on your phone, see it live on your PC. See [PLAN.md](PLAN.md).

## Status: M6 — export & Wi-Fi pairing

- **Export** (`Ctrl+E` or the *Export* button): the notebook as a **vector PDF** (endless pages as one tall
  page, or cut into A4 sheets for printing), the current page as **PDF**, **SVG** or **PNG** (100–300 dpi).
  Same ink, template and highlighter as on screen. Also by URL: `/api/export/<notebookId>.pdf[?split=1]`,
  `/api/export/<pageId>.{svg,pdf}` (`?download=1` names the file after the notebook)
- **Pair over Wi-Fi by QR**: Panel → *Connect your phone* shows a QR code for the PC's Wi-Fi address
  (Wi-Fi interfaces first, Docker/VM bridges ignored; follows address changes). Pick another interface
  with its button. `--qr` also prints it in the terminal
- **HTTPS over Wi-Fi** (optional): `scripts/note-taker mkcert` creates a [mkcert](https://github.com/FiloSottile/mkcert)
  certificate; the server then also listens on HTTPS at port + 1 (7778) and the QR uses it — wake lock and
  app install work over Wi-Fi too. The phone has to trust mkcert's root CA once (the command explains how)

From M5: pen / highlighter / eraser toolbar with colours and widths, blank pad (◐), pen cursor on the PC,
fullscreen + wake lock + installable app, latency HUD (`Ctrl+Shift+L`).

Pad tips: tap the active tool (or the colour dot) for colours and widths; the toolbar hides when the pen
touches down — tap the handle or swipe down from the top edge to get it back. **Install as an app** from
Chrome's ⋮ menu → *Add to Home screen* / *Install app*.

From M4: notebooks, pages (A4 or endless), lined / grid / dotted / blank, viewer sidebar (☰ or `B`),
`PageUp` / `PageDown`. From M3: zoom-strip mode (magnified window that advances as you write). From
M2: SQLite storage, pad outbox, shared undo/redo (two-finger tap = undo, three-finger tap = redo),
stroke eraser. From M1: live pressure-sensitive ink, pressure curve in **Panel → Ink**, only the S Pen
draws (palm rejection). From M0: USB with automatic `adb reverse`, "Open pad / Open probe" from the
viewer, token-protected Wi-Fi URL.

## Latency

Measured with the HUD (write for a minute, press **Copy**, paste here). Stages: pen event → phone ink
drawn, pen event → server, server → PC frame, end-to-end. "Frame" is the animation frame that draws the
points; the display adds about one more frame. Numbers are good to ± the "clock" value the HUD shows.

| Link | pen → phone ink | pen → server | server → PC frame | end-to-end (median / p95) |
|---|---|---|---|---|
| USB | *not measured yet* | | | |
| Wi-Fi | *not measured yet* | | | |

Targets (PLAN.md §9): < 30 ms end-to-end over USB, < 50 ms over Wi-Fi.

## Run

```sh
bun install
scripts/note-taker            # server + viewer window
scripts/note-taker --server   # server only
bun run dev                   # server with auto-restart + browser console in the terminal
```

Flags (server): `--usb-only` (listen on 127.0.0.1 only), `--no-adb`, `--no-https` (ignore the
certificate), `--qr` (print the Wi-Fi pairing QR code).
Env: `NOTE_TAKER_PORT`, `NOTE_TAKER_CONFIG_DIR`, `NOTE_TAKER_DATA_DIR`, `NOTE_TAKER_TLS_CERT` / `NOTE_TAKER_TLS_KEY`.

- Config (port, LAN token, ink pressure curve): `~/.config/note-taker/config.json`; HTTPS certificate:
  `~/.config/note-taker/tls/{cert,key}.pem`
- Data: `~/.local/share/note-taker/` — `notes.db` (notebooks, strokes, undo history) and probe reports

## Phone setup (once)

1. Settings → About phone → Software information → tap **Build number** 7× → Developer options.
2. Developer options → **USB debugging** on.
3. Plug into the PC, accept the "Allow USB debugging" prompt.
4. In the viewer, the phone appears under **USB devices** → **Open probe** first, then **Open pad**.

Wi-Fi instead of USB: same network as the PC, then scan the QR code in the viewer's Panel with the camera.
For a secure context over Wi-Fi (wake lock, app install), run `scripts/note-taker mkcert` once.

Tip: disable Air command (Settings → Advanced features → S Pen) if it hijacks the side button.

## Test

```sh
bun test
bun run typecheck
```
