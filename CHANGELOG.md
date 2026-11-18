# Changelog

Each release lists the migrations it needs. Apply them in order, then deploy, as [Deploying](docs/DEPLOY.md)
describes. The client package's own changes are in [Clients](docs/CLIENTS.md).

## Unreleased

Nothing yet.

## 2026-11-18

Migration `0024`.

- Added opt-in [shared and personal workspaces](docs/WORKSPACES.md), with base roles, invitations in five languages
  and signed workspace events. Client `0.8.0` adds the workspace API and event verification.
- Limited each app to managing its own product through the app API.
- Made resource registration idempotent: the same app registering a resource to the same workspace gets `200` with no change.
- Let an app with `workspace_admin` invite an owner, revoke invitations and close a team workspace with no members
  when the workspace uses its product.
- Client `0.8.1` lets `handleCallback` return the verified ID token for `actor_token`.
- Client `0.8.2` refuses redirects on every request with `redirect: 'manual'`; `0.8.1` used `redirect: 'error'` for
  workspace calls, which Cloudflare Workers reject.
- Made `apps/server/wrangler.jsonc` a template with placeholder hosts and ids. Keep deployment values in the ignored
  `wrangler.local.jsonc` and pass `--config wrangler.local.jsonc` to every `wrangler` command ([Deploying](docs/DEPLOY.md)).
- Changed tests and examples to use `example.com` hosts.
- A test that revoking one of an agent's two grants leaves the other working, and that the event names only the
  revoked grant.
- [Integrating](docs/INTEGRATE.md): why a missed revocation is still safe, how an app catches up with the grants API,
  and how agents choose scopes (Claude Code pins them with `oauth.scopes`).
- Claude Code was verified live against a production MCP server: read-only consent, refresh, and revocation delivered
  to the app in 7 seconds.

## 2026-11-17

Migrations `0020`–`0023`.

- **Agents at scale:**
  - token budgets that suit hosted agents behind shared addresses (`AGENT_LIMITER`, a budget per grant, and a
    per-app `agent_token_rate`);
  - paging and a `sub` filter on the grants API;
  - `agent_assurance` on tokens, introspection and the grant list;
  - registrations kept while a grant is live;
  - client `0.7.0` with `listGrants`, `revokeGrant` and `introspect`.
- **Languages:** pages and emails in English, Spanish, French, German and Portuguese (Brazil), and a branded HTML
  part, light and dark, beside the plain text of every email.
- **OpenID conformance:**
  - classic OpenID Connect per app, `id_token_hint`, `POST /authorize`, `client_secret_post`, UserInfo body tokens
    and RS256 ID tokens per app;
  - the fixes the suite found;
  - no failures in the Basic, Config, RP-Initiated Logout and Back-Channel Logout profiles
    ([OpenID certification](docs/CERTIFICATION.md)).

## 2026-11-15

Migrations up to `0019`.

- The security pass, with client `0.3.0` ([Security pass](docs/SECURITY_PASS.md)).
- Realms: many brands, one deployment.
- Passwords, two-factor and step-up, the account pages and passkeys.
- The provider registry.
- Machines: service clients, introspection, revocation, DPoP and token exchange.
- User lifecycle events.
- Branding as a Fire look, and every page rebuilt with the Fire design system.
