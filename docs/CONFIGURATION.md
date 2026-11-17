# Configuration

`apps/server/wrangler.jsonc` declares the Worker. Its top level is a neutral template for `wrangler dev`, with a
placeholder D1 id, `workers_dev: false` and `preview_urls: false`. Real deployments are environments (`staging`,
`production`) with their own database, queues, rate-limit namespaces and custom-domain routes. Brands, provider
credentials and admins are not in Wrangler: they live in D1 as [realms](REALMS.md). See [Deploying](DEPLOY.md) for
setup and [Operations](OPERATIONS.md) for running it. Nothing below is a browser secret unless marked public.

## Worker bindings and values

| Name | Kind | Notes |
|---|---|---|
| `DB` | D1 | All state, migrations `0001`–`0021` in `apps/server/migrations`. |
| `EMAIL` | Cloudflare `send_email` binding | Sign-in links and security notices. Each realm's sender domain must be enabled for Email sending. |
| `AUTH_LIMITER` | Rate limit, 20 per 60 seconds | Sign-in routes, per address (IPv6 /64). A missing binding fails the request. |
| `API_LIMITER` | Rate limit, 120 per 60 seconds | Other routes per address; `/token`, `/userinfo` and `/v1/invitations` per authenticated client. Missing fails. |
| `LOGOUT_QUEUE` | Queue producer | Back-channel logout, agent revocation and user events. |
| Queue consumer | Same queue, batches of 10, 5 retries, then a dead-letter queue | Each environment names its own queue and dead-letter queue. |
| Cron | `* * * * *` | Delivery, key rotation per realm, expiry and retention ([Operations](OPERATIONS.md#retention-and-the-scheduled-handler)). |
| Static assets | `"assets": { "directory": "public" }` | The [Fire](fire/README.md) design system at `/fire/*` and the branding editor module at `/imprim/*`, served before the Worker runs, with headers from `public/_headers`. No binding name. |
| Routes | One `{ "pattern": "<host>", "custom_domain": true }` per realm host, per environment | An unknown host gets `404 unknown_realm`. |
| `compatibility_flags` | `global_fetch_strictly_public` | Back-channel deliveries and metadata fetches go over the public internet. |
| Observability | On; invocation logs off | Invocation logs would record OAuth callback query credentials. Application logs are structured and redacted. |
| `SEALING_KEY` | Secret, 64 hex characters | Seals every realm's signing keys and TOTP secrets. Set before first use and back up separately. Not a rotation toggle. |
| Realm secrets and vars | Secrets (or public vars) | Whatever names a realm's config references as `{"env":"NAME"}`. The `default` realm created by migration `0009` reads `EMAIL_FROM`, `TURNSTILE_SITE_KEY` (public), `TURNSTILE_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. |

Turnstile: both keys absent turns the challenge off (for development); one without the other fails with
`turnstile_config`. Provider credentials are needed only for apps that enable that provider. Provider callbacks are
listed in [Operations](OPERATIONS.md#provider-apps-per-realm).

## App client settings (`clients`)

A realm admin creates and edits clients in the console or with `POST /admin/api/clients`
([Control plane](CONTROL_PLANE.md)). `scripts/seed-client.mjs` turns a JSON file into reviewed insert SQL offline
and never writes D1. JSON columns are shown decoded.

| Setting | Default | Notes |
|---|---|---|
| `id` | Required, unique | Stable client id; cannot change. |
| `secret_hash` | Generated | The console generates the secret, shows it once and stores its SHA-256. The seed script needs a hash or explicit `null` (a public PKCE client). |
| `redirect_uris` | Required, nonempty | Exact HTTPS callback URLs. |
| `post_logout_uris` | `[]` | Exact return URLs after sign-out. |
| `backchannel_uri` | Required in the console | HTTPS receiver for `logout_token`, `revocation_token` and `event_token` POSTs. |
| `signup_policy` | `invited` | `invited` or `open`. |
| `allowed_domains` | `[]` | Exact email domains admitted under `invited`, with mailbox proof. |
| `sign_in_methods` | `["email"]` (the column default); the seed script requires an explicit list | Ordered, distinct: `email`, `password`, `passkey`, `github`, `google`, or a provider id from the realm's config such as `microsoft`. |
| `google_hosted_domains` | `[]` | Signed Google `hd` values this app accepts. |
| `mfa` | `off` | `off`, `optional` (required once the person has a factor) or `required`. |
| `mfa_trusted_device_days` | `0` | 0 to 90 days a browser may skip this app's second factor; 0 means never. |
| `agent_consent_mfa` | `off` | `required` asks for a second factor within 15 minutes before approving an agent. |
| `branding` | `{}` | Name, Fire `look`, copy, links and logo asset ids over the realm's ([Branding](BRANDING.md)). |
| `dev` | `0` | `1` allows exact HTTP loopback redirects. |
| `agent_access` | `off` | `on` enables agent grants after resource and scope review. Turning it off revokes every live grant. |
| `agent_registration_methods` | `["metadata_document"]` | Add `dynamic` to allow RFC 7591 registration. |
| `agent_allowlist` | `[]` | Optional client ID URLs or hosts. It narrows; it does not authenticate. |
| `agent_scope_catalogue` | `{}` | Scope descriptions; required when agent access is on. |
| `agent_resource_prefixes` | `[]` | Canonical HTTPS resource ownership; required when agent access is on. |
| `agent_max_grant_days` | `90` | Caps consent in whole days. |
| `agent_dpop` | `optional` | `required` refuses agent tokens that are not DPoP-bound. |
| `token_exchange_from` | `{}` | Other client ids that may exchange tokens into this app, each with the scopes it may obtain. |
| `user_events` | `off` | `on` sends signed user lifecycle events to `backchannel_uri`. |
| `version` | `0` | Incremented on every edit; an edit must send the current version. |

The seed script accepts the original sign-in, branding and agent settings. Set `mfa`, `mfa_trusted_device_days`,
`agent_consent_mfa`, `agent_dpop`, `token_exchange_from` and `user_events` in the console or the admin API. The seed
script never overwrites an existing client. Rotating a secret (console or `rotate-secret`) invalidates the old one
at once; there is no overlap, so switch the app's secret in the same window.

## Runtime limits

D1 `rate_limits` holds email, address, degraded-Turnstile and agent-action budgets. They are code constants, not
Wrangler vars ([Architecture](ARCHITECTURE.md#limits-challenge-and-records)). Agent metadata documents are cached in
D1 (`agent_metadata_cache`).
