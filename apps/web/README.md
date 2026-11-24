# Imprim account and admin interface

This app uses Fire 0.12.4, Lit light DOM, Vite and TypeScript. [The Web specification](../../docs/WEB.md) defines the interface and API conventions.

## Current migration

The Worker's [`WEB_PATHS`](../server/src/web/serve.mjs) serves the Lit shell for HTML requests to Profile (`/account`),
Security (`/account/security`), Sessions and apps (`/account/sessions`), and Agents (`/account/agents`). The MFA
and password flows under `/account/mfa` and `/account/password` keep their server-rendered forms for sign-in
continuations. `/mfa` continues to handle the second-factor challenge. Remaining placeholders link to their
server-rendered screens with `data-im-document` so the router allows a full document navigation.

[Profile](src/screens/account/profile.ts) is the pattern for the next screens. Its JSON endpoints share mutations with the legacy forms. The emailed link still opens the server-rendered confirmation page and requires a POST to change the address.

- `GET /v1/me` supplies the role, locale, realm and session summary. `fresh_until` is the ten-minute primary authentication deadline in Unix milliseconds. `mfa` reports whether the session's second factor is within the admin MFA window.
- `GET /v1/account/profile` returns the profile and the realm's available languages. `POST /v1/account/profile`, `/v1/account/language`, `/v1/account/email` and `/v1/account/delete` use JSON and the session's CSRF header.
- `GET /v1/account/security`, `/v1/account/sessions` and `/v1/account/agents` supply the remaining account screens.
  Security posts under `/v1/account/mfa/`, `/v1/account/passkeys/` and `/v1/account/password`. Access changes
  post to `/v1/account/sessions`, `/v1/account/apps`, `/v1/account/devices` and `/v1/account/agents/revoke`.
- `t()` and `tPlural()` take literal English message IDs. Add new IDs to all shipped catalogues. Admin screens use English.
- Screens extend `FireLight` and are loaded from the route table. Render Fire markup through Lit's `html` templates so the Fire lint and slim build can see it.

## Build and verify

From the repository root:

```sh
npm ci --prefix apps/web
npm run build
npm --prefix apps/web run typecheck
npm --prefix apps/web run check
```

The root build copies the Worker assets into `apps/server/public/fire` and `apps/server/public/ui`. Vite keeps the default Fire look in the build. The Worker injects the realm's look and labels into the HTML on each request.

The app check builds, verifies Fire slim output, enforces size budgets, runs markup and CSS lints, and launches Playwright Chromium against the production build and the SQLite-backed Worker harness. Chromium must be installed and the test process must be able to start it and bind a loopback port. The root server tests run without an app install or build.
