> **Historical.** This is the plan approved on 2026-11-04 for the first (Vibernt) deployment. Imprim is now a generic,
> multi-realm platform: see [README](README.md), [Realms](docs/REALMS.md) and the [Roadmap](docs/ROADMAP.md). Decisions
> of 2026-11-15: realms per brand, admins in D1, MIT licence, public repository `Vibernt/imprim`.

# Imprim: shared sign-in for Vibernt apps

Status: approved, 2026-11-04. Owner decisions: repository `Vibernt/imprim`, private, licence decided before any
public release; domain `id.vibernt.ai`; built on Assay's own auth code (not Better Auth); milestone 1 starts now.

**What it is.** One open-source OIDC provider at `https://id.vibernt.ai`, extracted from Assay's own auth and running on
Cloudflare (Workers, D1, KV, Queues). It has magic links and GitHub sign-in, and its own small control plane.

**Owner direction.**
- Extract Assay's auth into a separate repository and package, with its own control plane.
- Assay and Touchstone sign in through it. Touchstone's human sign-in is still to be built, and it will use this
  service, which replaces the WorkOS AuthKit choice (decision D3 in Touchstone's PRODUCTION_ARCHITECTURE.md).
- Cupel has no accounts and needs no integration.

## What moves and what stays

| Moves to identity | Stays in each app |
|---|---|
| Users (`sub` = today's `principals.id`) | Workspaces and tenants |
| Verified emails | Memberships, roles and project scopes |
| Linked GitHub and Google identities | Registration policy (who may create a workspace, platform invites) |
| Magic links | The app's own session and CSRF |
| GitHub and Google sign-in, configurable per app | A local `principals` projection keyed by `sub`, so existing foreign keys survive |
| Turnstile | API tokens and agent tokens (workspace-scoped, sponsor-bound, admitted at the edge by one local D1 read) |
| Auth rate limits | Agent-connect approval (only the human sign-in moves) |
| Identity sessions | Assay's own operator roster |
| Signing keys | |
| Client registry | |
| Audit log | |
| Block, merge and delete | |
| Passkeys and MFA (later) | |

Identity proves who someone is. Each app decides what they may do. A person known to identity but not admitted by an
app's policy gets a "no access" page.

## Protocol

- **Discovery and authorization code flow.**
  - Discovery, JWKS, `/authorize`, `/token`, `/userinfo` and `/logout`, plus back-channel logout delivered through a
    Queue with retries.
  - PKCE S256 is mandatory, and `state` and `nonce` are required.
  - Redirect URIs must match exactly, over https; localhost is allowed for development clients only.
  - A code lives 60 seconds and can be used once (`DELETE … RETURNING`). Responses carry `iss` (RFC 9207).
  - Confidential clients use `client_secret_basic`.
- **Tokens.**
  - ID tokens are ES256, valid for 10 minutes, with these claims: `sub`, `email`, `email_verified`, `amr`,
    `auth_time`, `sid`, `nonce` and `azp`.
  - Access tokens are short-lived and used only for `/userinfo`.
  - Apps get no refresh tokens, because they keep their own sessions. Agents are the exception (see Agent access).
- **Keys.** The design of Assay's `oidc-keys.mjs`: sealed ES256 keys, a new generation every 90 days, each published
  one hour before use and retired 24 hours after.
- **Cookies.** Every cookie is host-only and none is shared across domains:
  - `__Host-` on `id.vibernt.ai`, with a 30-day identity session.
  - Each app keeps its own cookie. Assay's stays at 7 days.
  - Single sign-on happens through top-level redirects; `prompt=none` re-authenticates silently.
- **Sign-in inside `/authorize`.**
  - The magic link and GitHub sign-in are the existing Assay logic, served from the identity host.
  - The emailed link opens `id.vibernt.ai/login#token=…`, which still needs an explicit Sign in click, so link
    prefetchers cannot use it.
- **Invitations.**
  - An app calls `POST /v1/invitations {email}` with its client credentials.
  - A client's `signup_policy` is either `invited` (the default) or `open`. This keeps Assay's protection against
    sign-up abuse.

## Sign-in methods per app (owner request, 2026-11-04)

Identity supports three sign-in methods: **email magic link**, **GitHub** and **Google**. Each registered app
(client) chooses which methods it offers, and the order they are shown in.

- **Client setting.** `sign_in_methods: ["email", "github", "google"]`, an ordered list with at least one method. It is
  edited in the control plane and seeded by configuration in M1. The sign-in page for a request shows only that
  client's methods.
- **Enforcement.** A method the client doesn't allow is refused at the server, not only hidden. That covers a direct
  POST to the magic-link endpoint and a GitHub or Google callback for a request from that client. The ID token's `amr`
  names the method used (`email`, `github`, `google`).
- **Google.**
  - Google is an upstream OIDC provider: authorization code with PKCE S256, `state` and `nonce`, and a browser-bound
    cookie, the same pattern as GitHub sign-in.
  - Google's ID token is verified against Google's JWKS (issuer `https://accounts.google.com`, audience = our Google
    client ID), and `email_verified` must be true.
  - The account is linked by Google `sub` in `user_identities` (provider `google`).
  - Optional per-client restriction: `google_hosted_domains` lists allowed Google Workspace domains (the `hd` claim).
  - Secrets: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- **Linking.**
  - A GitHub or Google sign-in whose verified email matches an existing user links to that user.
  - A provider account already linked to another user is refused.
  - An email that isn't verified at the provider never links.
- **Signup policy.** Applies to every method alike. Under `invited`, a first sign-in by any method needs an existing
  user, an invitation or an allowlisted domain.
- **Exit test (M1).**
  - A client set to `["google"]` shows only Google, and refuses a magic-link POST.
  - A client set to `["email", "github"]` refuses a Google callback.
  - An unverified Google email is refused.

## Agent access (owner decision, 2026-11-04)

Coding agents (Claude Code, Cursor, Codex, the `cri` CLI) connect to an app **for a person, never as one**. The person
gives the agent only the app's MCP address. The agent finds identity, registers itself, and opens a browser. The
person signs in, sees which agent wants which access to which workspace, and approves. Today the person copies a token
out of the console; this replaces that step.

Out of scope:
- **Agents signing up by themselves, with no accountable person.** It opens a path to abuse and billing has no owner.
- **Machines in CI.** These keep app API tokens and GitHub OIDC, inside the apps.

**Standards.** Identity follows the MCP authorization specification (OAuth 2.1):
- **Discovery.** The app serves Protected Resource Metadata (RFC 9728) and answers an unauthenticated MCP call with
  `401` and `WWW-Authenticate: Bearer resource_metadata=…`. Identity serves Authorization Server Metadata (RFC 8414)
  next to OIDC discovery.
- **Registration.** Client ID Metadata Documents are the default: the `client_id` is an https URL that serves the
  agent's name and redirect URIs. Dynamic Client Registration (RFC 7591) is for agents that support only that.
  - Registered clients are public, with mandatory PKCE.
  - Redirect URIs are loopback (any port, RFC 8252) or exact https only.
  - Registration is rate limited, and a dynamically registered client unused for 30 days is removed.
- **Audience.** Resource Indicators (RFC 8707) are required.
  - The resource is the workspace's MCP address, for example `https://ci.vibernt.ai/w/<workspace>/mcp`, so a grant
    names one workspace.
  - Identity accepts only resources under a prefix that the app registered.
- **Device flow.** The device authorization grant (RFC 8628) serves headless agents and `cri login`: the agent prints a
  code, and the person approves on any device.

**Tokens and grants.**
- The access token is an ES256 JWT, valid 60 seconds (M4 owner-approved choice, 2026-11-06), with these claims:
  - `aud` = the resource;
  - `sub` = the person;
  - `client_id` = the agent;
  - `grant_id` = the approved grant (for precise back-channel denial);
  - `scope`.
- Refresh tokens rotate, and a reused refresh token revokes the whole grant.
- Each app declares its scope catalogue in its client settings. The app still intersects a scope with the person's
  role on every call, so a grant can never exceed the person.
- **The consent screen** names:
  - the agent: the metadata document's name and its host;
  - the app;
  - the workspace;
  - the scopes.

  A dynamically registered client is marked "unverified".

**Per app (client settings, next to sign-in methods).**
- `agent_access`: `off` (the default) or `on`.
- Registration methods allowed: metadata documents, dynamic registration, or both.
- An optional allowlist of agent `client_id` URLs or hosts.
- The scope catalogue.
- The longest grant (90 days by default).

**For the person.**
- "Connected agents" on `id.vibernt.ai/account` lists each grant: agent, app, workspace, scopes, created and last used.
- Revoke ends the refresh token at once. The access token then expires within 60 seconds.
- Grants, refreshes and revocations go to the audit log. A revocation also reaches the app through the back-channel
  queue.

**Client package additions.**
- `verifyAccessToken(token, { audience })`.
- `protectedResourceMetadata({ resource, scopes })`.
- The `WWW-Authenticate` challenge helper.

**Assay changes** (made in the Assay switch):
- `/w/<id>/mcp` returns the 401 challenge and accepts identity access tokens for its own audience.
- The connect prompt becomes the MCP address alone.
- The pasted agent token path is removed, with no compatibility layer. App API tokens stay for CI and scripts.

## Control plane

A small console served by the identity Worker at `/admin`, which signs in through identity itself.

M4 implementation and integration gates: [docs/CONTROL_PLANE.md](docs/CONTROL_PLANE.md).

- **Admins.** (Superseded 2026-11-15: admins are a per-realm D1 roster, see docs/REALMS.md.) Admins sign in by magic
  link only.
- **v1 screens.**
  - **Clients:** redirect and logout URIs, back-channel URI, signup policy, branding, secret rotation.
  - **Users:** search, block, merge, delete.
  - **Audit log.**
  - **Keys:** rotate now.
  - **Settings:** Turnstile and rate limits.

## Packaging

The repository is `Vibernt/imprim`, an npm workspace with Assay's conventions (checks, quiet tests, generated docs).

| Part | Contents |
|---|---|
| `apps/server` | The Worker, its migrations and `wrangler.jsonc` (D1, KV, Queue, rate limiting, `send_email`). |
| `apps/console` | The admin console. |
| `packages/imprim-client` | `imprim-client`, zero-dependency ESM: `createClient`, `startLogin`, `handleCallback`, `verifyIdToken` (JWKS cached for 24 h), `handleBackchannelLogout`, `logoutUrl`, `inviteEmail`; from M2, `verifyAccessToken` and `protectedResourceMetadata` for agent access. |
| Docs | Protocol, operations, conformance (the OpenID conformance basic profile). |

Assay has no runtime dependencies, so it vendors the built client file as `src/auth/imprim-client.mjs`. A check
verifies the copy's version and SHA. Touchstone installs the npm package.

## Migration (Assay)

**Approach.**
- `sub` keeps `principals.id`, so tenant stores and every `principalId` reference are untouched.
- A one-time, idempotent import copies `principals` and `principal_identities` into identity. Deleted principals come
  over as deleted.
- Everyone signs in once more at cut-over (`DELETE FROM sessions`). There is no compatibility layer.

**Assay has no staging environment (owner decision), so the order is:**
1. Deploy identity to production with no client yet.
2. Import the users.
3. Check counts and unique emails, and check that an operator can sign in at identity.
4. Register the Assay client.
5. Deploy the Assay Worker that uses the client package. It deletes the old auth routes and adds negative tests:
   - wrong `state`;
   - replayed code;
   - wrong `aud`;
   - swapped `nonce`.
6. Smoke-test as:
   - an operator;
   - a member;
   - an invited email;
   - an agent-connect approval;
   - an account deletion.
7. Drop the old auth tables after a week.

**Rollback.** Roll back the Assay Worker version. The old tables and principal ids are still there until the drop
migration.

## Risks to settle first (spikes)

1. **Email delivery.** Whether Cloudflare `send_email` delivers sign-in links to Gmail, Outlook and iCloud, and how
   quickly.
2. **Browser round trip.** The `id.vibernt.ai` → `assay.vibernt.ai` → `ci.vibernt.ai` round trip on Safari and Chrome,
   including `prompt=none`.
3. **`/token` latency.** p95 of `/token` on D1 at 50 requests per second from several regions. The fallback is a
   Durable Object per code.
4. **Identity outage.** Existing app sessions keep working, and the JWKS cache covers verification.
5. **Block propagation.** It needs back-channel logout; until then a block takes effect when the app session expires.

## Milestones

Re-ordered on 2026-11-04: agent access is built before Assay switches, so Assay launches with it.

- **M1: identity server and client package.** The server (magic link, GitHub and Google, sign-in methods per app,
  Turnstile, key recovery) is on branch `m1-server`.
  - Exit:
    - `imprim-client` with tests against the server;
    - replayed codes and wrong-state requests refused;
    - the OpenID conformance basic profile passes locally.
- **M2 (about 5–7 days): agent access.**
  - Exit:
    - Claude Code, Cursor and Codex connect to a local Assay MCP with only its address;
    - `cri login` works by device code;
    - a revoked grant stops refreshing at once;
    - negative tests: wrong audience, another workspace, missing PKCE, redirect mismatch, unregistered resource,
      reused refresh token.
- **M3: Assay switches.** Deploy identity, import users, register Assay, deploy Assay on the client package (see
  Migration).
  - Exit:
    - production sign-in to Assay by every enabled method, and an agent connect;
    - the old Assay routes are gone;
    - a rollback rehearsed.
- **M4 (about 5–6 days): control plane, back-channel logout, block.**
  - Exit:
    - blocking a user ends their Assay session and agent grants within a minute;
    - a key rotation causes no failed verification;
    - every admin action is in the audit log.
- **M5 (about 5 days): Touchstone's console sign-in over OIDC, with agent access.**
  - Exit: the login mints Touchstone's human session, and API clients keep their tenant tokens.

## Why build on Assay's code and not Better Auth

- **Assay already has the hard parts:**
  - browser-bound `state` with PKCE;
  - hashed single-use links;
  - a sealed ES256 key ring with rotation;
  - Turnstile with a degraded mode;
  - admission rules.

  The missing protocol surface is about six endpoints we can read end to end.
- **Better Auth's `oidcProvider` is being replaced** by `@better-auth/oauth-provider` and has recent advisories:
  - refresh-token replay without client authentication;
  - `alg=none` advertised and plain PKCE accepted;
  - a `javascript:` redirect_uri leading to stored XSS.
- **It would also add a runtime dependency,** which Assay's rules forbid.
- **Revisit** if passkeys or MFA become urgent, for example `@simplewebauthn/server` for that one feature.
