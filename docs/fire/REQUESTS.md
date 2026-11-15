# Fire requests from Imprim

Gaps found while building Imprim's screens with Fire v0.2.0 (GUIDE.md section 7). Each has a stopgap in
`localCss` (`apps/server/src/pages/layout.mjs`), served as `/assets/local.css`, with `x-` classes and Fire tokens only.
Delete the stopgap when Fire ships the request.

## 7. The app shell without the demo's script (new pattern)

- **Kind:** new pattern
- **What you were building:** the admin console and the account pages, rendered on the server in Fire's app shell.
- **What is missing:** the shell exists only as `templates/shell.js`, written for the Ember demo and run in the
  browser. A product has to re-derive the sidebar, top bar, hero and phone-menu markup from it. The phone menu's
  close icon also draws from the icon sprite, which only `fire.js` injects, so a page that loads `js/shell.js` alone
  gets an empty button until it also calls `initIcons()`.
- **Proposed shape:** a documented shell specimen in `docs/` with copyable markup for each part, a
  `templates/shell.html` with no script, and `js/shell.js` injecting the sprite it needs.
- **Where else it applies:** every product that renders pages on a server.
- **Stopgap in use:** `apps/server/src/pages/shell.mjs` renders the markup; `public/imprim/shell.js` loads Fire's
  `icons.js`, `shell.js` and `texture.js` and calls `initIcons()`. No CSS.

## 6. A centred screen (new pattern)

- **Kind:** new pattern
- **What you were building:** sign-in, second factor, consent and result screens: the brand, then one card, centred
  on the page.
- **What is missing:** `templates/auth.html` is a split layout. Nothing centres a band's content top to bottom, and
  nothing centres a heading's text (`fd-stack[data-align="center"]` centres boxes, not wrapped lines).
- **What you tried:** `fd-empty` (centres, but is an empty state with its own padding), `fd-row` with `fd-grow`
  spacers (side to side only).
- **Proposed shape:** `fd-band[data-align="center"]` to centre its content in a grown band, and a text-alignment
  attribute such as `data-text="center"`; a `templates/auth-centered.html` built from them.
- **Where else it applies:** onboarding steps, not-found and error pages, any single-task screen.
- **Stopgap in use:** `.x-screen` and `.x-center`.

## 5. Tweaks panel under a strict CSP (bug)

- **Kind:** bug
- **What you were building:** the admin Branding page, which opens the Tweaks panel under `style-src 'self'`.
- **What is missing:** `js/tweaks.js` builds `<span class="fd-tweaks-rule" style="--_tw-w: …px">` with `innerHTML`; a
  strict CSP blocks the attribute, so the panel's rules lose their widths and the console logs violations.
- **Proposed shape:** set the width with `element.style.setProperty` (CSSOM, allowed by CSP) or a `data-w` attribute.
- **Where else it applies:** any product with a strict CSP that offers the panel.
- **Stopgap in use:** none; the rules show at their default width.

## 4. `fd-divider` cannot grow in a row (bug)

- **Kind:** bug
- **What you were building:** the "or" separator between provider buttons and the email form on the sign-in page.
- **What is missing:** `.fd-divider { flex: none }` comes after `.fd-grow` in `base.css`, so `<hr class="fd-divider fd-grow">`
  collapses to zero width. Fire's own `templates/auth.html` uses that markup and shows no rules.
- **Proposed shape:** `.fd-divider.fd-grow { flex: 1 1 0 }`, or move the `flex` reset before `.fd-grow`.
- **Where else it applies:** every "or" separator.
- **Stopgap in use:** each rule wrapped in a `div.fd-grow` (`orDivider` in `apps/server/src/pages/ui.mjs`). No CSS.

## 3. QR code figure

- **Kind:** new component
- **What you were building:** authenticator setup on `/account/mfa`. The person scans a QR code with their phone.
- **What is missing:** a figure that keeps a QR code dark on light in both themes, at a scannable size.
- **What you tried:** `fd-card`, `fd-tile`. Both follow the theme, so the code turns light on dark in dark mode.
- **Proposed shape:** `<figure class="fd-qr">svg</figure>`, fixed light surface, padding, radius, max width `--fd-size-md`.
- **Where else it applies:** device sign-in, sharing links to phones.
- **Stopgap in use:** `.x-qr`.

## 2. Uploaded logo in `fd-brand`

- **Kind:** new variant
- **What you were building:** the brand at the top of every sign-in screen and in the shell's sidebar, showing a
  brand's uploaded logo or square mark.
- **What is missing:** `fd-brand-mark` is a square icon box that sizes an inline SVG; a logo is often wide, and an
  uploaded mark is an `<img>`.
- **What you tried:** `fd-brand-mark` (crops wide logos), `fd-tile` (square).
- **Proposed shape:** `<img class="fd-brand-logo">` inside `fd-brand`, height `--fd-brand-mark`, width auto, capped.
- **Where else it applies:** any product that lets customers brand Fire screens.
- **Stopgap in use:** `.x-logo` and `.x-mark`.

## 1. Wordmark beside the brand name

- **Kind:** new variant
- **What you were building:** the IMPRIM dot-matrix wordmark in the "Powered by" line at the foot of every page.
- **What is missing:** a wide SVG wordmark, in `fd-brand` or in a line of caption text, coloured like the text.
- **What you tried:** `fd-brand-mark` (square, accent colour).
- **Proposed shape:** `<svg class="fd-brand-wordmark">` in `fd-brand`, height `--fd-icon-lg`, `currentColor`.
- **Where else it applies:** Fire's own templates for products with a wordmark rather than a mark.
- **Stopgap in use:** `.x-wordmark`.
