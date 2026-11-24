# Fire requests from Imprim

Imprim uses Fire v0.12.3 (commit `d484380`).

Gaps found while building Imprim's screens with Fire ([GUIDE.md](GUIDE.md) section 7). Own classes and tokens use
the `im-` prefix. Request a Fire variant when an existing component needs a change.

## Open

| Request | Where and why | Proposed interface | What Imprim uses today |
|---|---|---|---|
| Refuse a field inside a settings row, and a text field wider than a form | 0.10.2 | `wrong-parent` (lint and review) and `wide-field` (review) guard `fieldWithAction` in `apps/web/src/screens/page-layout.ts`, used for every value someone types beside its button |
| Fieldset reset | 0.10.0 | Native disabled fieldsets use Fire layout classes. Fire resets the border, margin, padding and minimum inline size. |
| Starter focus ring on page titles | 0.10.0 | The router calls `focusQuiet()` for page headings and regions. |
| Structural markup lint | 0.10.0 | Fire checks required parts, elements and parents in Lit templates. The browser review gate checks rendered markup and layout. |
| Extend `renderEmail` with inline branding | Sign-in and security emails carry their branding inside the message. The recipient can read them with remote images disabled. | Accept an inline `cid:` logo and a dark logo swap, and draw the brand's dot-matrix initial when no logo is present. | Its own renderer and attachment handling in [services/email](../../apps/server/src/services/email/). |
| Document a palette subset for Tweaks | Products with a curated palette set need the Tweaks panel to offer only palettes shipped in their CSS. | Document an allowlist that also governs what preset looks can apply. | [Branding](../BRANDING.md) ships the full Fire palette set. |
| Read plain template strings in `fire lint` and `fire slim` | The Worker renders sign-in and consent without a template framework. Its HTML is in plain JavaScript template strings. | Add a documented opt-in or source marker to discover plain templates for linting and slimming. | Imprim's Node smoke tests inspect the rendered HTML, and the server ships all Fire CSS. See [pages.test.mjs](../../tests/pages.test.mjs). |

## Shipped

| Request | Fire | What Imprim uses now |
|---|---|---|
| Fieldset reset | 0.10.0 | Native disabled fieldsets use Fire layout classes. Fire resets the border, margin, padding and minimum inline size. |
| Starter focus ring on page titles | 0.10.0 | The router calls `focusQuiet()` for page headings and regions. |
| Structural markup lint | 0.10.0 | Fire checks required parts, elements and parents in Lit templates. The browser review gate checks rendered markup and layout. |
| Fire's scripts take their interface labels from the page | 0.5.1 | The shared document layout emits a translated `data-fd-labels` JSON dictionary before Fire runs |
| No component writes a `style` attribute (skeletons, file list, chat, charts, agent blocks did) | 0.5.0 | Any Fire component can be used under Imprim's Content Security Policy |
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
