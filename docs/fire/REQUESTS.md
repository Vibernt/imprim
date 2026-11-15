# Fire requests from Imprim

Gaps found while building Imprim's screens with Fire v0.2.0 (GUIDE.md section 7). Each has a stopgap in
`localCss` (`apps/server/src/pages/layout.mjs`), served as `/assets/local.css`, with `x-` classes and Fire tokens only.
Delete the stopgap when Fire ships the request.

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
- **What you were building:** the header of every sign-in page, showing a brand's uploaded logo.
- **What is missing:** `fd-brand-mark` is a square icon box; a logo is often wide.
- **What you tried:** `fd-brand-mark` (crops wide logos), `fd-tile` (square).
- **Proposed shape:** `<img class="fd-brand-logo">` inside `fd-brand`, height `--fd-brand-mark`, width auto, capped.
- **Where else it applies:** any product that lets customers brand Fire screens.
- **Stopgap in use:** `.x-logo`.

## 1. Wordmark beside the brand name

- **Kind:** new variant
- **What you were building:** the default IMPRIM dot-matrix logo, shown before a brand uploads its own.
- **What is missing:** a wide SVG wordmark in `fd-brand`, coloured like the brand name.
- **What you tried:** `fd-brand-mark` (square, accent colour).
- **Proposed shape:** `<svg class="fd-brand-wordmark">` in `fd-brand`, height `--fd-icon-lg`, `currentColor`.
- **Where else it applies:** Fire's own templates for products with a wordmark rather than a mark.
- **Stopgap in use:** `.x-wordmark`.
