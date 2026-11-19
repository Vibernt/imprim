# Changelog

Each release lists the migrations it needs. Apply them in order, then deploy, as [Deploying](docs/DEPLOY.md)
describes. The client package's own changes are in [Clients](docs/CLIENTS.md).

## 2026-11-20.3

No migration.

- Layout: a value you type (Profile name, language and email; passkey name; admin merge, workspace name, products and
  invitation) is now a field with its button beside the input, in a form that stops at a readable width. Before, the
  input sat inside a settings row, stretched across the card and left the button aligned with the description.

## 2026-11-20.2

No migration.

- Confidential apps can read an admitted person's current profile with `GET /v1/users?sub=<sub>` or
  `user(sub)` in `imprim-client` 0.10.0 after receiving a value-free `user-updated` event.

## 2026-11-20.1

No migration.

- `POST /v1/workspaces/{id}/products` treats an omitted `add` or `remove` as an empty list, and client 0.9.1 sends
  both. Before, `setWorkspaceProducts(id, { add, actorToken })` without `remove` failed with `400 invalid_request`.
- Docs: the README, integration guide, roadmap and architecture describe sign-up approval, joining an existing
  workspace and the realm-admin close.

## 2026-11-20

Migration `0027`.

- `POST /v1/workspaces/joinable` and client 0.9.0 let an app show workspace owners where they can
  [add the app's product](docs/WORKSPACES.md#adding-a-product-to-an-existing-workspace).
- An app with workspace administration enabled can close a workspace on behalf of a realm admin by confirming
  its current name. Client 0.9.0 accepts `confirm` in `closeWorkspace`.
- Shared apps can enable `join_workspaces` to let a team workspace owner add the app's product during
  [hosted sign-in](docs/WORKSPACES.md#adding-a-product-to-an-existing-workspace).

## 2026-11-19.3

No migration.

- Workspace reads (`GET /v1/workspaces/{id}`, `GET /v1/memberships`, create responses) include `created_via`:
  `"signup"` for a self-serve sign-up workspace, otherwise `null`. Client 0.8.3 adds the type.

## 2026-11-19.2

Migrations `0025` and `0026`.

- Optional [self-serve sign-up](docs/SIGNUP.md) lets a person prove their email on Imprim's hosted pages and
  create a team workspace they own. Each participating app receives the usual workspace membership event.
- Realms can require administrator approval after email verification. The Sign-up requests console records approvals,
  declines and expired requests. The realm's immediate sign-up mode is `open`.

## 2026-11-19.1

No migration.

- Fire v0.10.1: its fieldset reset and `focusQuiet` replace Imprim's two stopgaps; its agent rules and class
  reference are in `docs/fire`.
- Every account and admin screen follows one Fire page template ([Interface](docs/WEB.md#layout)): one compact page
  head, lists as a table with row actions, forms in one column, detail screens as stacked cards.
- Fixed: the page title no longer shows a focus ring after navigating; callouts carry their icon; a screen that shows
  a code block no longer stops updating after an action (Fire's code block rewrites its text, so the block is
  re-created when the value changes).
- `fire review` gates the app: every screen at 1440 and 375, light and dark, with Fire's structural and composition
  rules, in `npm --prefix apps/web run check`.

## 2026-11-19

No migration.

- Pinned Fire 0.9.1 from its public repository, shipping its LICENSE and NOTICE; filed the fieldset reset with Fire.
- Built the account area and admin console as a Lit app using `GET /v1/me`, `GET /v1/i18n/<locale>.json`, `/v1/account/*` and `/admin/api/*` JSON APIs.
- Kept the account sign-in message on signed-out `/account`.
- Added a build step and the `ASSETS` binding for deploys ([Deploying](docs/DEPLOY.md)).
- Translated Fire interface labels and checked icons.

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
