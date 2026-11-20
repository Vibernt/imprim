# Fire in Imprim

Every Imprim page uses **Fire v0.12.1** (commit `e0d58af`), MIT, from the pinned package
`"fire-design": "github:vidhatanand/firedesign#v0.12.1"` (root and `apps/web` `package.json`).
`scripts/build-fire.mjs` copies its CSS, ES modules and other static assets into `apps/server/public/fire/`,
the generated directory served by Workers Static Assets. The package includes SIL OFL notices for the fonts
and the ISC notice for the Lucide icons.

| Read | For |
|---|---|
| [AGENT-RULES.md](AGENT-RULES.md) | The rules an AI agent follows when it builds an interface with Fire; it names the files below |
| [GUIDE.md](GUIDE.md) | Building screens: layout, components, theming, what to do when Fire lacks something |
| [WRITING.md](WRITING.md) | Every word on a screen: labels, buttons, hints, errors, empty states |
| [VOCABULARY.md](VOCABULARY.md) | The common classes and attributes organized by component |
| [CLASSES.md](CLASSES.md) | The complete generated class and attribute reference |
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
  `/assets/theme.css`, using Fire's palette engine (`fire-design/fire/js/palettes.js`), as the Tweaks panel
  does in the browser.
- Pages declare `data-fd-surface="app"`. The page's catalogue supplies Fire's runtime labels in inert JSON in the
  document head. The Content Security Policy allows same-origin scripts and styles. Stopgap classes and tokens use
  the `im-` prefix. Request variants in [REQUESTS.md](REQUESTS.md).

- The README's graphics (`docs/assets/diagrams/`) are drawn in Fire too, by `scripts/diagrams.mjs`: Fire's
  neutrals and ember accent, hairlines, mono eyebrows, the dot grid and corner marks, Geist embedded so GitHub
  shows it, and Imprim's dot-matrix wordmark and numerals (`dotMatrix` in `pages/dots.mjs`). Run
  `node scripts/diagrams.mjs` after changing them, or after a Fire release changes those tokens.

**Upgrading Fire.** Change the tag in the root and `apps/web` `package.json` and run `npm install` in both. Copy `GUIDE.md`, `WRITING.md`,
and `AGENT-RULES.md` from the package and `CLASSES.md` and `VOCABULARY.md` from the tag's `docs/_ref/`.
Record the release here and in [WEB.md](../WEB.md). Run `npm run test:quiet` and `npm run check` to regenerate the assets
and check the upgrade. Review the sign-in, account and console pages in light and dark at desktop and phone widths.

| Fire | In Imprim since | What changed for Imprim |
|---|---|---|
| 0.12.1 | 2026-11-20 | No change to Fire's styles or behaviour since 0.10.2. 0.11.0 took the Facet adapter out of Fire; 0.12.0 changed `render-equal` (Imprim does not run it) and Fire's starters; 0.12.1 changed the rules for agents: templates are references, never starters, and a component Fire lacks is built to Fire's standard and proposed internally, in `REQUESTS.md`. |
| 0.10.2 | 2026-11-20 | Lint and review refuse a field inside a settings row (`wrong-parent`); review refuses a text field wider than 768 px outside a full-width form (`wide-field`). Imprim already passed both. |
| 0.10.1 | 2026-11-19 | Fixes in the review gate and the fieldset reset; one layout system across the account and admin screens. |
| 0.10.0 | 2026-11-19 | Fieldset reset, quiet route focus, structural markup lint and a browser review gate. |
| 0.9.0 | 2026-11-19 | Vendored package, translated control labels, updated palette tokens and new Tweaks settings. |
| 0.5.0 | 2026-11-17 | No Fire module writes a `style` attribute any more, so every component works under Imprim's policy. Tweaks starts from the page's own palette and type set. Also new, not used yet: a pipeline graph, a day strip, a secret entry field. |
| 0.4.0 | 2026-11-15 | The form controls the console uses: lists, names with values, code fields, form sections, radio choices. |
