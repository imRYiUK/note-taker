# note-taker

Write with the S Pen on your phone, see it live on your PC. See [PLAN.md](PLAN.md).

## Status: M1 — live ink

- Write on the phone (**pad**), ink appears live on the PC (**viewer**) — single A4 page, whole
  page mapped onto the phone screen (portrait gives the biggest page)
- Pressure-sensitive ink (perfect-freehand); pressure curve tunable in the viewer's **Panel → Ink**
- Only the S Pen draws (mouse too, for desktop testing); fingers/palm never do
- Viewer: fit width / fit page (`F`), follow pen, clear page
- Strokes live in server memory only — persistence arrives in M2

From M0: USB with automatic `adb reverse`, "Open pad / Open probe" from the viewer,
token-protected Wi-Fi URL, auto-reconnect, round-trip latency.

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
- Data (probe reports, later notebooks): `~/.local/share/note-taker/`

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
