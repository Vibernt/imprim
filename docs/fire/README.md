# Fire in Imprim

Every Imprim page is built with **Fire**, a design system of plain CSS and ES modules with no build step. Fire
v0.2.0 is vendored at `apps/server/public/fire/` and served as static files (Workers Static Assets, see
`apps/server/wrangler.jsonc`). It is MIT licensed (`apps/server/public/fire/LICENSE`); its fonts are SIL OFL 1.1 and
its icons are Lucide (ISC).

| Read | For |
|---|---|
| [GUIDE.md](GUIDE.md) | Building screens: layout, components, theming, what to do when Fire lacks something |
| [WRITING.md](WRITING.md) | Every word on a screen: labels, buttons, hints, errors, empty states |
| [VOCABULARY.md](VOCABULARY.md) | Every class and attribute Fire defines |
| [REQUESTS.md](REQUESTS.md) | Gaps Imprim fills with stopgaps until Fire has them |

How Imprim uses it:

- Pages are rendered on the server. `apps/server/src/pages/ui.mjs` renders Fire components (fields, buttons,
  callouts, lists, tables, settings rows, icons) with every text escaped. Pages handling credentials load no Fire
  JavaScript; only the admin Branding page loads `fire.js`, for the Tweaks panel.
- A brand's **look** is Fire's tweak state (palette, tone, type set, density, corners, lines, text size, contrast,
  motion, texture, theme). `apps/server/src/branding/look.mjs` applies it as `<html>` attributes plus
  `/assets/theme.css`, using Fire's own palette engine (`public/fire/js/palettes.js`), exactly as the Tweaks panel
  does in the browser.
- The Content Security Policy stays strict: `style-src 'self'`, no inline styles or scripts. Markup never carries a
  `style` attribute; stopgaps live in `/assets/local.css` (`localCss` in `apps/server/src/pages/layout.mjs`).

**Upgrading Fire.** Replace `apps/server/public/fire/` with the new release's `fire/` folder (keep `LICENSE`), copy
its `GUIDE.md`, `WRITING.md` and `docs/_ref/VOCABULARY.md` here, then run the tests: `tests/branding.test.mjs`
checks looks against Fire's palettes and type sets. Never edit files inside `public/fire/`.
