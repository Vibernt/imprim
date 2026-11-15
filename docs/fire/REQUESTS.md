# Fire requests from Imprim

Gaps found while building Imprim's screens with Fire (GUIDE.md section 7). An open request has a stopgap in
`localCss` (`apps/server/src/pages/layout.mjs`), served as `/assets/local.css`, with `x-` classes and Fire tokens
only. Delete the stopgap when Fire ships the request.

## Open

None. `localCss` is empty, so no page links the stopgap stylesheet.

One thing to know, though Imprim does not use it: Fire's skeleton presets, file-upload list, chat, charts and agent
blocks still write inline `style` attributes, which Imprim's Content Security Policy blocks. Use them here only
after Fire converts them.

## Shipped

| Request | Fire | What Imprim uses now |
|---|---|---|
| A list and a name-and-value editor that post in a plain form; a long-form pattern; a JSON code field | 0.4.0 | `fd-tag-input`, `fd-pairs`, `fd-codefield`, `fd-form-section` and radio `fd-segmented` in the client editor (`admin/client-editor.mjs`, `pages/forms.mjs`) |
| A button that lines up with a labelled field; a card title above setting rows; a value in a field's shape | 0.4.0 | `fd-row[data-align="end"]` on the search rows; `fd-title` card titles; the sample email on Branding |
| A one-time code field that posts in a plain form | 0.3.1 | `fd-otp` holding one named input; `/imprim/forms.js` loads Fire's forms module |
| The app shell without the demo's script | 0.3.0 | `templates/shell-static.html` as the reference for `pages/shell.mjs`; `icon()` injects its own sprite, so `/imprim/shell.js` loads only Fire's shell and texture modules |
| A centred screen | 0.3.0 | `fd-screen`, `fd-screen-head`, `fd-screen-note`, `fd-band[data-align="center"]` |
| Tweaks panel under a strict CSP | 0.3.0 | The Branding page's Tweaks panel, with no blocked styles |
| `fd-divider` cannot grow in a row | 0.3.0 | `<hr class="fd-divider fd-grow">` either side of "or" |
| QR code figure | 0.3.0 | `fd-qr` for authenticator setup |
| Uploaded logo and mark in `fd-brand` | 0.3.0 | `fd-brand-logo`; an `img` inside `fd-brand-mark` |
| Wordmark | 0.3.0 | `fd-wordmark` for "Powered by IMPRIM" |
