# note-taker — Design System (Master)

Source of truth for UI work (ui-ux-pro-max skill, Master + Overrides pattern). Page-specific
deviations go in `pages/<page>.md` and override this file. Implemented in `src/shared/base.css`.

**Style:** "Educational Platform" claymorphism — <https://uupm.cc/demo/educational-platform>
(skill style id `claymorphism`). Pastel fills, thick ink outlines, hard offset shadows, chunky
radii, controls that press down into their shadow. **Light only**: the style avoids dark mode;
`[data-theme="dark"]` exists solely for the S Pen probe (light ink on a dark canvas).

## Colour tokens

| Token | Value | Use |
|---|---|---|
| `--peach` / `--brand` | `#fdbcb4` | logo tile, active notebook |
| `--sky` / `--toggle` | `#add8e6` | pressed toggles, selection, badges |
| `--lilac` | `#e6e6fa` | value chips, palette selection, pad surround (`#e8e4f8`) |
| `--mint` | `#98ff98` | decorative accents |
| `--green` / `--cta` | `#22c55e` | the one primary action per surface |
| `--on-cta` | `#2d3748` | text on `--cta` (white is only 2.3:1; ink is 5.3:1) |
| `--accent` | `#16a34a` | non-text emphasis on white: strip overlay, active thumb, curve |
| `--accent-text` | `#15803d` | green text on white (5:1) |
| `--bg` / `--well` | `#fff9f5` | app background, inset areas inside cards |
| `--surface` | `#ffffff` | cards, controls |
| `--text` / `--line` | `#2d3748` | text, outlines, hard shadows |
| `--muted` | `#64748b` | secondary text (4.8:1 white, 4.6:1 cream) |
| `--border` | `#e2e8f0` | hairline dividers, chart grid |
| `--ok` / `--warn` / `--bad` | `#16a34a` / `#d97706` / `#dc2626` | status dots (always with text) |
| `--focus` | `#2563eb` | focus ring |

Paper is always white; ink and template colours are unaffected by the theme.

## Typography

- Headings, brand: **Fredoka** 600 (`--display`); body and controls: **Nunito** (`--sans`), 700 on buttons.
- Self-hosted variable woff2, latin subset (`src/shared/fonts/`, OFL), `font-display: swap`. No CDN.
- Numbers in data: `--mono` with tabular figures.

## Shape, depth, motion

- Outlines: `--bw` 3px (cards, header, dialogs, primary surfaces), `--bw-sm` 2px (compact controls).
- Radii: 10px controls, 14–16px rows/toasts, 20px cards, 24px dialogs, 99px chips.
- Shadows: cards `6px 6px 0 var(--line)` + `inset 0 -4px 0 rgb(0 0 0 / .1)`; controls `3px 3px 0`.
  The page uses box-shadow (outline + offset) so its box — and overlay coordinates — never change.
- Press: hover `translate(1px,1px)` + 2px shadow (pointer devices only, `@media (hover: hover)`);
  active `translate(3px,3px)` + no shadow. 150ms, `cubic-bezier(0.34, 1.56, 0.64, 1)`.
- `prefers-reduced-motion` disables transitions globally.

## Components

- **Buttons:** white clay by default; `.primary` = green CTA; `[aria-pressed="true"]` = sky.
  Disabled = 45% opacity, `not-allowed`.
- **Icons:** Phosphor **bold**, inline SVG via `src/shared/icons.ts` (`<i data-icon>` + `hydrateIcons()`,
  or `icon(name)`). Never emoji or text glyphs. Decorative icons are `aria-hidden`; icon-only
  buttons carry `aria-label`.
- **Cards:** `section` = white, 3px outline, 20px radius, card shadow. Panel headings get a pastel tile.
- **Chips:** 2px outline, 99px radius, cream fill (status) or lilac (values).
- **Pad toolbar:** white clay bar; borderless 44×44 buttons inside; pressed = sky with outline.

## Rules

- Contrast ≥ 4.5:1 for text, ≥ 3:1 for meaningful non-text. Check new pairs before using them.
- Visible focus ring on every control (`:focus-visible`, 3px `--focus`, offset 3px).
- Touch targets on the pad ≥ 44px.
- One primary (green) action per surface.
- Use tokens, never raw hex in components (exceptions: paper white, fixed tints like `#dcfce7` / `#fee2e2`).
- Nothing on the pad may slow ink: no backdrop-filter or animated effects over the canvas.

## Avoid

Dark mode, emoji icons, gradients on text, soft blurred shadows (shadows are hard and offset),
white text on `--green`.
