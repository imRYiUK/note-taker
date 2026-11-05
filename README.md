# note-taker

Write with the S Pen on your phone, see it live on your PC. See [PLAN.md](PLAN.md).

## Status: M4 — notebooks, pages, templates

- Several notebooks, each with many pages; A4 or **endless** pages (grow as you write)
- Backgrounds per notebook: lined, grid, dotted, blank
- Viewer sidebar (☰ or `B`): open / create / rename / delete notebooks, change the template, page
  thumbnails (click to go, ＋ to add, × twice to delete). `PageUp` / `PageDown` change page
- Pad toolbar: ‹ n/N › ＋ — phone and PC always show the same page
- Each notebook reopens on the page you left it on, also after a server restart

From M3: zoom-strip mode (magnified window that advances as you write). From M2: SQLite storage,
pad outbox, shared undo/redo (two-finger tap = undo, three-finger tap = redo), stroke eraser.
From M1: live pressure-sensitive ink on a single A4 page (whole page mapped onto the phone), pressure
curve in **Panel → Ink**, only the S Pen draws (palm rejection). From M0: USB with automatic
`adb reverse`, "Open pad / Open probe" from the viewer, token-protected Wi-Fi URL.

## Run

```sh
bun install
scripts/note-taker            # server + viewer window
scripts/note-taker --server   # server only
bun run dev                   # server with auto-restart + browser console in the terminal
```

Flags (server): `--usb-only` (listen on 127.0.0.1 only), `--no-adb`.
Env: `NOTE_TAKER_PORT`, `NOTE_TAKER_CONFIG_DIR`, `NOTE_TAKER_DATA_DIR`.

- Config (port, LAN token, ink pressure curve): `~/.config/note-taker/config.json`
- Data: `~/.local/share/note-taker/` — `notes.db` (notebooks, strokes, undo history) and probe reports

## Phone setup (once)

1. Settings → About phone → Software information → tap **Build number** 7× → Developer options.
2. Developer options → **USB debugging** on.
3. Plug into the PC, accept the "Allow USB debugging" prompt.
4. In the viewer, the phone appears under **USB devices** → **Open probe** first, then **Open pad**.

Tip: disable Air command (Settings → Advanced features → S Pen) if it hijacks the side button.

## Test

```sh
bun test
bun run typecheck
```
