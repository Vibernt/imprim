# Deploying on Cloudflare

The service is one Worker with D1, a Queue with a dead-letter queue, two rate-limit bindings, the Email sending
binding and a cron trigger. It has no build step and no runtime dependencies. `apps/server/wrangler.jsonc` holds a
neutral template plus a `staging` and a `production` environment. Run every command from `apps/server`.

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

   Put the database id, queue names and two unused rate-limit namespace ids into `env.staging` (or a new
   environment). Add each realm host under `routes` as `{ "pattern": "<host>", "custom_domain": true }`.
2. **Email.** Enable Cloudflare Email sending for each sender domain a realm uses (for example `signin@example.com`).
3. **Sealing secret.** Generate 32 random bytes as hex and keep an offline copy: `openssl rand -hex 32`. Then:

   ```bash
   wrangler secret put SEALING_KEY --env staging
   ```

   Losing it makes every signing key unreadable. Changing it needs an offline reseal migration.
4. **Realm secrets.** Store each secret that a realm config names, for example `wrangler secret put TURNSTILE_SECRET --env staging`.
5. **Schema.**

   ```bash
   wrangler d1 migrations apply imprim-staging --remote --env staging
   ```

6. **Realms and admins.** Write a realm file (see [Realms](REALMS.md)). For the first deployment, reuse the
   `default` realm with `"update": true`, and include at least one `platform` admin. Then:

   ```bash
   node ../../scripts/realm.mjs realm.json > realm.sql
   ```

   ```bash
   wrangler d1 execute imprim-staging --remote --env staging --file realm.sql
   ```

7. **Deploy.**

   ```bash
   wrangler deploy --env staging
   ```

8. **Check.** Fetch `https://<host>/.well-known/openid-configuration` and `/.well-known/jwks.json`. Then sign in at
   `https://<host>/login` as the platform admin and open `/admin`.
9. **Register apps** in the console or with `scripts/seed-client.mjs`. See [Integrating](INTEGRATE.md).

## Releases

Every release goes through staging first:

1. `npm run check` and `npm run test:quiet` pass on the release commit.
2. Back up staging, apply migrations, deploy to staging.
3. Smoke-test staging: email-link, GitHub and Google sign-in for one app; an agent connection by code flow and by
   device code; a revocation reaching the app's back-channel; an admin block ending the app session.
4. Run the OpenID conformance basic profile against staging.
5. Back up production (`wrangler d1 export <db> --remote --env production --output backup.sql`), apply
   migrations, deploy production, and repeat the smoke test.

Rollback: `wrangler rollback --env production` returns to the previous Worker version. Migrations are not rolled
back automatically. Restore the backup only if a migration itself is wrong, and treat that as an incident.

## Upgrading the existing Vibernt deployment to realms

The live deployment predates migrations `0008` (security pass) and `0009` (realms). It uses the `production`
environment, which keeps the deployed names (`vibernt-identity`).

The old Worker cannot run against the new schema. After `0009`, its GitHub, Google and new-user sign-ins fail,
because their conflict targets no longer exist. Apply, configure and deploy back to back, in a quiet minute:

1. Back up production:

   ```bash
   wrangler d1 export vibernt-identity --remote --env production --output pre-realms.sql
   ```

2. Write `default.json` with the live issuer, the Vibernt name and the owner as platform admin:

   ```json
   { "id": "default", "issuer": "https://id.vibernt.ai", "display_name": "Vibernt", "update": true,
     "config": {
       "email": { "from": { "env": "EMAIL_FROM" } },
       "turnstile": { "site_key": { "env": "TURNSTILE_SITE_KEY" }, "secret": { "env": "TURNSTILE_SECRET" } },
       "providers": {
         "github": { "client_id": { "env": "GITHUB_CLIENT_ID" }, "client_secret": { "env": "GITHUB_CLIENT_SECRET" } },
         "google": { "client_id": { "env": "GOOGLE_CLIENT_ID" }, "client_secret": { "env": "GOOGLE_CLIENT_SECRET" } } } },
     "admins": [{ "email": "<owner email>", "role": "platform" }] }
   ```

   Then `node ../../scripts/realm.mjs default.json > default.sql`, and review it.
3. Apply the migrations, the realm SQL, then deploy:

   ```bash
   wrangler d1 migrations apply vibernt-identity --remote --env production
   ```

   ```bash
   wrangler d1 execute vibernt-identity --remote --env production --file default.sql
   ```

   ```bash
   wrangler deploy --env production
   ```

4. Check discovery, JWKS (the existing `kid` must still be listed), an admin sign-in, and one app sign-in.
5. Remove the `ADMIN_EMAILS` variable from the Worker if the dashboard still shows it. The code no longer reads it.
6. Upgrade each app to client `0.3.0` (see [Security pass](SECURITY_PASS.md#rollout)).

Without `--env production`, `wrangler deploy` creates a separate Worker called `identity` with no routes. It does
not replace production.

## Upgrading to migrations 0010–0018

These add passwords, two-factor, the account page, passkeys, the provider registry, service clients, DPoP and token
exchange, user events and branding. They need no new bindings or secrets, and every new feature is off until an app
or realm turns it on: existing apps keep their `sign_in_methods`, `mfa` is `off`, `user_events` is `off`.

Follow [Releases](#releases): staging first, then production with a backup. Two things change on the day:

- **Administrators need a second factor.** The console refuses an admin without one
  (`mfa_enrolment_required`). Before deploying production, have each admin add an authenticator app or passkey at
  `/account/mfa` on staging to try it, then on production straight after the deploy.
- **Apps** can stay on client `0.3.0`. Upgrade to `0.6.0` to use step-up (`acrValues`, `maxAge`), DPoP
  verification or user events ([Clients](CLIENTS.md)).

## Bindings reference

| Binding | Kind | Notes |
|---|---|---|
| `DB` | D1 | All state. Migrations in `apps/server/migrations`. |
| `LOGOUT_QUEUE` | Queue producer and consumer | Back-channel logout and agent revocation events. Dead-letter queue after 5 retries. |
| `AUTH_LIMITER` | Rate limit | Sign-in routes, per address (IPv6 /64). |
| `API_LIMITER` | Rate limit | Other routes per address; `/token`, `/userinfo` and invitations per authenticated client. |
| `EMAIL` | Email sending | Magic links. |
| Cron `* * * * *` | Trigger | Outbox dispatch, expiry sweeps, key rotation per realm, retention. |
| `SEALING_KEY` | Secret | AES-256-GCM key for every realm's signing keys. |
| Realm secrets | Secrets | Whatever each realm's config names. |
