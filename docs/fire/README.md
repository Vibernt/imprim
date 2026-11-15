# Fire in Imprim

Every Imprim page is built with **Fire**, a design system of plain CSS and ES modules with no build step. Fire
v0.4.0 is vendored at `apps/server/public/fire/` and served as static files (Workers Static Assets, see
`apps/server/wrangler.jsonc`). It is MIT licensed (`apps/server/public/fire/LICENSE`); its fonts are SIL OFL 1.1 and
its icons are Lucide (ISC).

| Read | For |
|---|---|
| [AGENT-RULES.md](AGENT-RULES.md) | The rules an AI agent follows when it builds an interface with Fire; it names the files below |
| [GUIDE.md](GUIDE.md) | Building screens: layout, components, theming, what to do when Fire lacks something |
| [WRITING.md](WRITING.md) | Every word on a screen: labels, buttons, hints, errors, empty states |
| [VOCABULARY.md](VOCABULARY.md) | Every class and attribute Fire defines |
| [REQUESTS.md](REQUESTS.md) | Gaps found in Fire while building Imprim, and what shipped for each |

How Imprim uses it:

- Pages are rendered on the server. `apps/server/src/pages/ui.mjs` renders Fire components (fields, buttons,
  callouts, lists, tables, settings rows, icons) with every text escaped. There are two layouts: a centred screen
  for sign-in, consent and results (`pages/layout.mjs`), and Fire's app shell for the console and the account pages
  (`pages/shell.mjs`).
- Sign-in and consent screens load no Fire JavaScript. Shell pages load `/imprim/shell.js`, which brings in Fire's
  shell and texture modules for the sidebar, the phone menu and the hero texture. A screen with a 6-digit code, and a console page with a list, a name-and-value editor or a code field, loads
  `/imprim/forms.js`, which brings in Fire's forms module; each control is an ordinary input or text area until then,
  so the form works without it. Only the admin Branding page loads all of `fire.js`, for the Tweaks
  panel.
- Form controls are chosen by the kind of value (GUIDE.md section 5, "Forms") and rendered by
  `apps/server/src/pages/forms.mjs`: a list, names with values, a choice, a switch, a number with a unit, raw JSON.
  Nobody types JSON, `0` or `1`, or an option's name.
- A brand's **look** is Fire's tweak state (palette, tone, type set, density, corners, lines, text size, contrast,
  motion, texture, theme). `apps/server/src/branding/look.mjs` applies it as `<html>` attributes plus
  `/assets/theme.css`, using Fire's own palette engine (`public/fire/js/palettes.js`), exactly as the Tweaks panel
  does in the browser.
- The Content Security Policy stays strict: `style-src 'self'`, no inline styles or scripts. Markup never carries a
  `style` attribute. A stopgap for something Fire lacks goes in `/assets/local.css` (`localCss` in
  `apps/server/src/pages/layout.mjs`); there are none now, so no page links it.

**Upgrading Fire.** Replace `apps/server/public/fire/` with the new release's `fire/` folder (keep `LICENSE`), copy
its `GUIDE.md`, `WRITING.md` and `docs/_ref/VOCABULARY.md` here, then run the tests: `tests/branding.test.mjs`
checks looks against Fire's palettes and type sets. Never edit files inside `public/fire/`.
