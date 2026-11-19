# Account and admin interface

Status: built. This page is the specification for Fire 0.9.1 and the Lit account and admin interface; the code matches it.

## What changes and what does not

- **The Worker stays dependency-free.** It imports nothing from npm at run time. It serves the protocol, the APIs, the
  screens that handle credentials, and the built interface as static files.
- **Server-rendered, unchanged in kind:** sign-in, check email, signed in and signed out, sign-in stopped, magic-link
  confirm, the second-factor challenge, device-code entry and result, agent consent, logout confirm and result, the
  signed-out account page, every OIDC endpoint and every email. These handle credentials, post forms that work
  without JavaScript, carry a per-page `form-action`, take the brand per request and run mid-protocol.
- **Built with Lit and Vite:** the account area (`/account/*`) and the admin console (`/admin/*`). They form one
  single-page app with two areas, talking to JSON APIs.

## Fire

- Fire v0.9.1 (commit `7bca159`), MIT, from its public repository: both the root `package.json` (a dev dependency, for
  the Worker, scripts and tests) and `apps/web/package.json` pin `"fire-design": "github:vidhatanand/firedesign#v0.9.1"`.
  Upgrading Fire means changing that tag in both and recording it here and in `docs/fire/README.md`.
- The Worker imports Fire's modules (`icons.js`, `palettes.js`, `typefaces.js`) as `fire-design/fire/js/…`; Wrangler
  bundles them. They are the only imports outside `apps/server/src` that `npm run check` allows.
- `apps/server/public/fire/` is build output: `scripts/build-fire.mjs` copies `node_modules/fire-design/fire/` into it,
  with Fire's `LICENSE` and `NOTICE`. It is not committed. Run `npm ci` once before `npm test`.
- Fire's interface labels (menu, sidebar, show and hide, copied) come from the page: server pages and the app emit
  `<script type="application/json" data-fd-labels>` from the catalogues, before Fire's first label.
- Stopgaps follow Fire's rule 10: never restyle an `fd-` class; ask for a variant in `docs/fire/REQUESTS.md`. Own
  tokens and classes carry the prefix `im-` (set as `"fire": { "prefix": "im" }` in the app's `package.json`).
- Fire's lints read only `html`-tagged templates, `.html` files, JSX and Vue. The app's templates are Lit `html`.

## The app (`apps/web`)

- Started from Fire's `starters/lit-vite`: Lit in light DOM (`FireLight`), the starter's router and route
  table, its `AppShell`, `fire slim` in the build, size budgets and its `npm run check`. TypeScript.
- `vite build` with `base: '/'` and `build.assetsDir: 'ui'`, output in `apps/web/dist/`. `npm run build` copies
  `dist/ui/` to `apps/server/public/ui/` (hashed files, cached immutable) and `dist/index.html` to
  `apps/server/public/ui/index.html` (never cached). The router's base is `/`.
- **Serving.** The Worker answers every `GET` for `/account` and `/account/*` and for `/admin` and `/admin/*` that asks
  for HTML, after its own JSON and protocol routes. It reads `index.html` through the static-assets binding (`ASSETS`)
  and, with `HTMLRewriter`, sets per request: `lang`, the brand's `<html>` attributes, the brand stylesheet link
  (`/assets/theme.css?v=…`) in `<head>`, the brand name and logo (`data-fd-brand`), and the `data-fd-labels` JSON for
  the person's language. It sends the shell's Content-Security-Policy as a header: `default-src 'self'; script-src
  'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none';
  base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. A signed-out request for `/account` shows the account sign-in message. Other protected account and admin routes
  redirect to `/login?next=…`.
- **Areas and roles.** Two route groups: account (every signed-in person) and admin (realm admins; the Platform group
  for platform admins). Guards read `/v1/me`. A person who is not an admin never receives admin routes in the
  navigation, and the server refuses every admin API call regardless.
- **Language.** The account area is translated; admin is English. The app's own strings are English message ids
  through `t()` and `tPlural()`, the same ids and catalogues as the server. The Worker serves the person's catalogue at
  `GET /v1/i18n/<locale>.json` (cached by catalogue hash), and `scripts/i18n.mjs` also scans `apps/web/src` for ids,
  so a missing translation fails `npm run check`.
- **Branding page** keeps Fire's Tweaks panel with every palette, type set and dial, loaded with that route only. The
  stored look maps to and from Fire's theme record with `expandTheme`.

## APIs

- `GET /v1/me`: `{ sub, email, initials, locale, admin: null | 'realm' | 'platform', mfa: bool, fresh_until,
  realm: { id, display_name } }`. Signed out: 401 `login_required`.
- Account: `/v1/account/*` JSON for every account screen (profile and email change, sessions and apps, agents and
  their revocation, security: factors, passkeys, recovery codes, password set and change, deletion). Admin:
  `/admin/api/*` extended to cover every console screen. Each handler reuses the service functions the HTML pages
  call today; no rule moves into the client.
- Session cookie as today. Every `POST`, `PUT`, `PATCH` and `DELETE` needs the CSRF header `x-csrf-token` equal to the
  `__Host-vi_csrf` cookie, and a same-origin `Origin`. Errors are `{ error, error_description }`. The client maps
  401 `login_required` to `/login?next=`, 403 `mfa_required` to the second-factor screen, and 403 `reauth_required`
  (the admin freshness rule) to a fresh sign-in, exactly as the HTML console does now.
- Every API gets negative tests: no session, wrong CSRF, cross-origin, wrong role, stale freshness.

## Screens

- Lit screens: account Profile, Sessions and apps, Agents; admin Clients list, Users list, User
  detail, Audit, Signing keys, Realms, Settings, Services, Workspaces list, result and failure notices (as toasts).
- Built from Fire templates or parts: the client editor (`templates/form.html`); Branding (`templates/settings.html`,
  `fd-dropzone`, Tweaks); account Security (`fd-codes`, `fd-secret`), set and change password
  (`fd-secret data-mode="entry"`); workspace create, detail and close (`fd-confirm-inline`); user merge.

## Rules for the codebase

`AGENTS.md` and `CLAUDE.md` say: the Worker uses native ESM with no runtime dependencies and no build step; the
account and admin interface in `apps/web` is Lit and Vite, built by `npm run build`; Fire comes from
the pinned `fire-design` package and never edited.

## Checks

- Server: `npm run test:quiet` and `npm run check` (unchanged commands; `check` also runs the app's typecheck and
  `fire lint --surface app` on `apps/web/src`).
- App: `npm --prefix apps/web run check` (the starter's build, budgets, lints and browser smoke checks).
- Deploy: `npm ci`, `npm --prefix apps/web ci` and `npm run build`, then `wrangler deploy --config wrangler.local.jsonc --env …`.
