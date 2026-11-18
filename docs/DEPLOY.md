# Deploying on Cloudflare

The service is one Worker with D1, a Queue with a dead-letter queue, three rate-limit bindings, the Email sending
binding, a cron trigger and static assets (the [Fire](fire/README.md) design system in `apps/server/public/`). It
has no build step and no runtime dependencies. `apps/server/wrangler.jsonc` is a template: a top level for
`wrangler dev`, and `staging` and `production` environments with placeholder hosts, ids and names. Copy it to
`apps/server/wrangler.local.jsonc`, which git ignores, and put your own values there, so your deployment's details
never land in a commit. Every command below passes `--config wrangler.local.jsonc`. Run every command from
`apps/server`.

## New deployment

1. **Resources.** Create the database and queues, and note the database id:

   ```bash
   wrangler d1 create imprim-staging
   ```

   ```bash
   wrangler queues create imprim-staging-logout
   ```

   ```bash
   wrangler queues create imprim-staging-logout-dlq
   ```

   Copy `wrangler.jsonc` to `wrangler.local.jsonc`. Put the database id, queue names and three unused rate-limit
   namespace ids into its `env.staging` (or a new environment). Add each realm host under `routes` as `{ "pattern": "<host>", "custom_domain": true }`. Keep the
   top-level `"assets": { "directory": "public" }`: `wrangler deploy` uploads `public/` with the Worker.
2. **Email.** Enable Cloudflare Email sending for each sender domain a realm uses (for example `signin@example.com`).
3. **Sealing secret.** Generate 32 random bytes as hex and keep an offline copy: `openssl rand -hex 32`. Then:

   ```bash
   wrangler secret put SEALING_KEY --config wrangler.local.jsonc --env staging
   ```

   Losing it makes every signing key unreadable. Changing it needs an offline reseal migration.
4. **Realm secrets.** Store each secret that a realm config names, for example `wrangler secret put TURNSTILE_SECRET --config wrangler.local.jsonc --env staging`.
5. **Schema.**

   ```bash
   wrangler d1 migrations apply imprim-staging --remote --config wrangler.local.jsonc --env staging
   ```

6. **Realms and admins.** Write a realm file (see [Realms](REALMS.md)). For the first deployment, reuse the
   `default` realm with `"update": true`, and include at least one `platform` admin. Then:

   ```bash
   node ../../scripts/realm.mjs realm.json > realm.sql
   ```

   ```bash
   wrangler d1 execute imprim-staging --remote --config wrangler.local.jsonc --env staging --file realm.sql
   ```

7. **Deploy.**

   ```bash
   wrangler deploy --config wrangler.local.jsonc --env staging
   ```

8. **Check.** Fetch `https://<host>/.well-known/openid-configuration`, `/.well-known/jwks.json` and
   `/fire/fire.css` (static assets, with `X-Content-Type-Options: nosniff`). Then sign in at `https://<host>/login`
   as the platform admin, add a second factor at `/account/mfa` when asked, and open `/admin`.
9. **Register apps** in the console or with `scripts/seed-client.mjs`. See [Integrating](INTEGRATE.md).

## Releases

Every release goes through staging first:

1. `npm run check` and `npm run test:quiet` pass on the release commit.
2. Back up staging, apply migrations, deploy to staging.
3. Smoke-test staging: email-link, GitHub and Google sign-in for one app; an agent connection by code flow and by
   device code; a revocation reaching the app's back-channel; an admin block ending the app session.
4. Run the OpenID conformance basic profile against staging.
5. Back up production (`wrangler d1 export <db> --remote --config wrangler.local.jsonc --env production --output backup.sql`), apply
   migrations, deploy production, and repeat the smoke test.

Rollback: `wrangler rollback --config wrangler.local.jsonc --env production` returns to the previous Worker version. Migrations are not rolled
back automatically. Restore the backup only if a migration itself is wrong, and treat that as an incident.

## Upgrading an existing deployment

Migrations run in order, `0001` to `0024`, and each one is applied once. A Worker built from this repository expects
every migration in it, and an older Worker cannot always run against a newer schema, so apply, configure and deploy
**back to back**, in a quiet minute. Rehearse the whole sequence on staging first.

1. **Back up** the database:

   ```bash
   wrangler d1 export <database> --remote --config wrangler.local.jsonc --env production --output pre-upgrade.sql
   ```

2. **Prepare the realm**, if the database predates realms (migration `0009`). That migration moves existing users,
   clients and keys into a realm called `default`, whose config reads the earlier variable and secret names
   (`EMAIL_FROM`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`). Its issuer is empty, so no host answers until you set it. Write
   `default.json` with your live issuer and at least one platform admin:

   ```json
   { "id": "default", "issuer": "https://id.example.com", "display_name": "Acme", "update": true,
     "config": {
       "email": { "from": { "env": "EMAIL_FROM" } },
       "turnstile": { "site_key": { "env": "TURNSTILE_SITE_KEY" }, "secret": { "env": "TURNSTILE_SECRET" } },
       "providers": {
         "github": { "client_id": { "env": "GITHUB_CLIENT_ID" }, "client_secret": { "env": "GITHUB_CLIENT_SECRET" } },
         "google": { "client_id": { "env": "GOOGLE_CLIENT_ID" }, "client_secret": { "env": "GOOGLE_CLIENT_SECRET" } } } },
     "admins": [{ "email": "ops@example.com", "role": "platform" }] }
   ```

   Generate the SQL and review it:

   ```bash
   node ../../scripts/realm.mjs default.json > default.sql
   ```

3. **Apply** the migrations, then the realm SQL if you wrote one, then deploy:

   ```bash
   wrangler d1 migrations apply <database> --remote --config wrangler.local.jsonc --env production
   ```

   ```bash
   wrangler d1 execute <database> --remote --config wrangler.local.jsonc --env production --file default.sql
   ```

   ```bash
   wrangler deploy --config wrangler.local.jsonc --env production
   ```

4. **Check** discovery, JWKS (the existing `kid` must still be listed), `/fire/fire.css`, an admin sign-in and one
   app sign-in.
5. **Clean up.** Earlier releases read an `ADMIN_EMAILS` variable; admins now come from the realm roster, so remove
   it if the dashboard still shows it. Upgrade each app to client `0.3.0` or later
   ([Security pass](SECURITY_PASS.md#rollout)).

Without `--config wrangler.local.jsonc --env production`, `wrangler deploy` creates a separate Worker named after the top-level `name`, with no
routes. It does not replace production.

## Upgrading to migrations 0010–0019

These add passwords, two-factor, the account page, passkeys, the provider registry, service clients, DPoP and token
exchange, user events and branding, and `0019` moves branding to Fire looks. They need no new bindings or secrets, and every new feature is off until an app
or realm turns it on: existing apps keep their `sign_in_methods`, `mfa` is `off`, `user_events` is `off`. The same
release serves every page with Fire, so the Worker now needs its static assets (`"assets"` in `wrangler.jsonc`,
uploaded by `wrangler deploy`).

Follow [Releases](#releases): staging first, then production with a backup. Three things change on the day:

- **Administrators need a second factor.** The console refuses an admin without one
  (`mfa_enrolment_required`). Before deploying production, have each admin add an authenticator app or passkey at
  `/account/mfa` on staging to try it, then on production straight after the deploy.
- **Branding is a Fire look.** Branding saved before Fire may hold `theme` or `theme_dark` colour tokens.
  Migration `0019` removes them from realm and client branding, and leaves every other branding field as it was.
  Choose a `look` on the console's Branding page afterwards ([Branding](BRANDING.md)); until then pages use Fire's
  default look.
- **Apps** can stay on client `0.3.0`. Upgrade to `0.6.0` to use step-up (`acrValues`, `maxAge`), DPoP
  verification or user events. An app still on `identity-client` `0.2.0` keeps signing people in, but refuses agent
  revocation events until it upgrades ([Clients](CLIENTS.md#upgrading-from-identity-client-020)).

## Upgrading to migration 0024

`0024` adds workspace tables, five per-app settings and an admission source column. It needs no new binding or secret.
Nothing changes until a realm sets `"workspaces": "on"` and an app opts in with `workspaces='shared'` and a product.
Use client `0.8.2`. See [Shared workspaces](WORKSPACES.md) and use
[`scripts/import-workspaces.mjs`](../scripts/import-workspaces.mjs) to move an app's own workspaces in; run a dry run first.

## Upgrading to migration 0023

`0023` adds the per-app `agent_token_rate` (3,000 a minute per agent), the assurance each new agent grant records, and
two indexes for the grants API. The Worker also needs a third rate-limit binding, `AGENT_LIMITER` (1,200 per 60
seconds, an unused `namespace_id`), in each environment's `ratelimits`; without it agent token requests fail with
`rate_limit_config`. Agents connected before the upgrade keep working; their tokens carry no `agent_assurance` until
the person connects again.

## Upgrading to migrations 0020 and 0022

`0020` adds the per-app `classic_oidc` switch (off) and the `id_token_hint` record on pending requests. `0022` gives
each realm a second signing ring for RS256: it rebuilds `signing_keys` with an `alg` column, keeping every existing
key, its `kid` and its windows as ES256, and adds the per-app `id_token_signed_response_alg` (ES256). Tokens issued
before the upgrade keep verifying, and apps see no change until they choose otherwise. The RS256 ring is created on
the first JWKS request after the deploy. Neither needs a new binding or secret.

## Upgrading to migration 0021

`0021` adds languages and HTML email: `auth_requests.ui_locales` and `users.locale`, both optional. It needs no new
binding or secret. On the day:

- **Pages follow the browser's language.** People whose browser asks for Spanish, French, German or Portuguese see
  those languages straight away; everyone else sees English as before. A realm or app that should stay English sets
  `"locales": ["en"]` in its branding first ([Branding](BRANDING.md#languages)).
- **Emails gain an HTML part.** The English text part is unchanged. Upload a PNG logo to have it in emails
  ([Branding](BRANDING.md#emails)).
- **The translations are drafts** awaiting native review ([Languages](TRANSLATING.md)).

Follow [Releases](#releases): staging first. On staging, send each email kind to Gmail, Outlook and Apple Mail and
look at it in light and dark mode before production.

## Bindings reference

| Binding | Kind | Notes |
|---|---|---|
| `DB` | D1 | All state. Migrations in `apps/server/migrations`. |
| `LOGOUT_QUEUE` | Queue producer and consumer | Back-channel logout, agent revocation and user events. Dead-letter queue after 5 retries. |
| `AUTH_LIMITER` | Rate limit | Sign-in routes, per address (IPv6 /64). |
| `API_LIMITER` | Rate limit | Other routes per address; `/token`, `/userinfo` and invitations per authenticated client; refused agent token requests per address. |
| `AGENT_LIMITER` | Rate limit, 1,200 per 60 seconds | Agent requests to `/token`, per address. Required from migration `0023`. |
| `EMAIL` | Email sending | Sign-in links and security notices. |
| Static assets | `"assets": { "directory": "public" }` | Fire's CSS, modules and fonts at `/fire/*`, and the branding editor at `/imprim/*`, served before the Worker runs. Headers in `public/_headers`. No binding name; other paths reach the Worker. |
| Cron `* * * * *` | Trigger | Outbox dispatch, expiry sweeps, key rotation per realm, retention. |
| `SEALING_KEY` | Secret | AES-256-GCM key for every realm's signing keys. |
| Realm secrets | Secrets | Whatever each realm's config names. |
