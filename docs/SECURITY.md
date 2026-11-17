# Security

Identity crosses browser, app, provider, email and agent boundaries. A valid identity subject is not an app role. An agent grant names a person, app resource and scopes; it is not an app API token. App developers must check current workspace membership and role on every resource request. See [Protocol](PROTOCOL.md) for exact requests and errors.

## Threats and controls

| Threat | Implemented control |
|---|---|
| Redirect or client substitution | App callbacks and logout returns must match registered strings exactly. HTTPS is required except exact development loopback. Agent redirects permit HTTPS or HTTP loopback; only the loopback port can vary at authorization. |
| Intercepted authorization code | S256 PKCE is mandatory, except for a confidential app an operator switches to classic OpenID Connect, which then relies on its client secret, `state` and, if it sends one, the nonce, as OpenID Connect Core does. Such an app cannot drop half of PKCE: a code issued with a challenge needs the verifier, and one issued without refuses it. Public clients and agents always use PKCE. App and agent codes live 60 seconds and are atomically single-use. Known human code replay is audited. |
| Login response injection | App login uses browser-bound state and nonce; authorization responses carry `iss`. The client verifies issuer, signature, audience, `azp`, nonce and time. |
| Upstream provider confusion | Upstream state is hashed, provider-scoped, single-use and browser-bound, with PKCE. Google requires a signed RS256 ID token, exact audience, nonce, verified email and, when configured, signed `hd`. Registry providers (Microsoft, Apple, any OIDC issuer) require RS256 or ES256 from the provider's JWKS, the configured issuer (Microsoft: the token's tenant, which a pinned tenant must match), exact audience and nonce. |
| Stolen identity cookie or CSRF | Secure host-only `__Host-` cookies, HttpOnly session, SameSite=Lax, 30-day expiry. Session mutations require exact Origin and matching cookie/submitted CSRF token. Session and CSRF values are hash-stored. |
| Magic link prefetch or reuse | Token stays in URL fragment until an explicit click. The POST checks original browser, expiry, admission and single use. Only its hash is stored. |
| Signing-key disclosure or substitution | AES-256-GCM sealed private ES256 and RS256 JWKs with kid-bound authenticated data. JWKS publishes public keys only. Hints are verified with their key's own algorithm (ES256/P-256 or RS256/RSA 2048); a header naming another algorithm, `none` or HMAC is refused, and token-supplied key URLs are ignored. |
| Hostile branding or logo | Branding is data only: a Fire look from fixed value sets, plain-text name and copy, `https://` links and uploaded asset ids. No CSS, HTML or script; values outside the sets are refused, and text is escaped. SVG uploads outside an element and attribute allowlist are refused; assets are realm-scoped and served sandboxed with `nosniff`. |
| Malicious HTML or agent name | Escaped page text, strict CSP, same-origin forms, no inline script or style, frame denial. Turnstile script/frame origin is allowed only on the configured sign-in page. |
| Email request abuse | Workers per-IP rate bindings, D1 per-email/IP budget, Turnstile validation and accepted-token replay record. Public magic request response is neutral. |
| Metadata SSRF and stale policy | HTTPS-only client ID documents, public A/AAAA DNS checks, bounded body/deadline, no redirects or stale cache, and app-policy rereads. Deployed Workers public-network egress still needs qualification. |
| Refresh theft/replay | Agent refresh hashes rotate atomically. Correctly bound reuse revokes the entire grant, except one retry within 10 seconds of a lost response, which leaves the lost replacement as a reuse trap. Wrong client/resource cannot spend another grant. A replayed code revokes what it issued. |
| Claimed agent identity | A client ID string authenticates nothing, and neither does the allowlist. Device and loopback consents label the host "claimed, not verified" and warn about remote phishing (RFC 8628 §5.4). The device grant must be declared. Agents that publish keys are authenticated with `private_key_jwt` on every token request. |
| Cross-app admission | Admission is per (user, client). An account created through one app is not admitted to an invited app. Domain admission needs mailbox proof (email link, or Google `hd`); GitHub never auto-links by email. |
| Shared egress denial | Discovery and JWKS are unlimited and memoised; `/token`, `/userinfo` and `/v1/invitations` are limited per authenticated client. Address budgets key on the IPv6 /64. |
| Cross-workspace token use | One canonical registered resource per grant; JWT `aud` is exact. The app verifies that audience and local membership on each request. |
| Silent remote logout | Human logout requires confirmation and CSRF POST. Agent revocation uses a distinct signed queue event with stable `jti`; the app deduplicates it. |

Requests and response bodies are bounded, and duplicate query/form parameters are rejected. Missing rate bindings, malformed secrets and failed metadata dependencies fail explicitly. No alternate provider or registration path is selected on failure. A configured Turnstile siteverify outage has one explicit degraded mode: audited email links for existing active users only, under tighter limits. Invalid challenges and rejected secrets still fail. With both keys absent, email sign-in has no Turnstile check; production rollout must configure and test it.

No network call occurs inside a D1 transaction. Revocation, audit and any outbox record are one batch, so queue failure cannot restore a revoked grant. Queue delivery is at least once; the app must verify the signed event and persist `jti` before acknowledging it. The client package's `handleBackchannelLogout` verifies human OIDC logout tokens and `handleAgentRevocation` verifies agent revocation events (`typ=secevent+jwt` from client 0.3.0).

Content Security Policy allows Turnstile's origin only on the sign-in page that renders the widget. Every other page has `script-src 'self'`, `style-src 'self'`, `img-src 'self' data:` and `frame-src 'none'`. Pages that handle credentials load no Fire JavaScript. Console pages use `default-src 'none'` with `font-src 'self'`; only the Branding page adds `script-src 'self'` and `connect-src 'self'` for Fire's Tweaks panel. Fire's static files are served with `nosniff` and `Cross-Origin-Resource-Policy: same-origin`, and its SVGs with a sandboxing CSP (`apps/server/public/_headers`).

## Logs and reporting

Worker errors log structured type/path/code without tokens. Audit records include sign-in, code replay, mail delivery failure, degraded Turnstile, unreadable keys and agent grant activity. Audit has append-only D1 triggers. Wrangler disables invocation logs because OAuth callbacks carry query credentials. Operators should inspect actual Cloudflare log settings and retention before deployment. Do not include tokens, raw email links, client secrets or provider credentials in an issue.

Report a suspected vulnerability privately through GitHub's private vulnerability reporting on the repository (see [SECURITY.md](https://github.com/Vibernt/imprim/blob/main/SECURITY.md)), never in a public issue. Include affected route, time, expected and observed behavior, and redacted request IDs or audit events.

## Not yet verified live

This repository does not record which commit a deployment runs or which clients are registered there; check the
Worker's deployments in Cloudflare before relying on a behaviour described here. Vibernt's deployment, the
reference for these notes, was checked as follows:

- **Production** runs every migration, `0001`–`0023`. On 2026-11-17 a person connected Claude Code to a Vibernt app's
  MCP server through production: Claude Code registered with its client ID metadata document, the person signed in
  and approved a `read-only` grant, the app's read tools answered, the token refreshed after its 60 seconds, and when
  the person revoked the grant from the account page, the signed revocation event reached the app's back-channel
  7 seconds later and the agent lost access. Migration `0023` (agents at scale) and the `AGENT_LIMITER` binding
  were applied and deployed on 2026-11-17 after a backup; an agent token request then got an OAuth error rather than a
  missing-binding failure, and the sign-in page and JWKS were unchanged. Migrations `0020`–`0022` (classic OpenID Connect, languages
  and HTML email, RS256) were applied and deployed on 2026-11-17, after a backup and after the same release passed the
  OpenID conformance suite on staging. That day discovery listed ES256 and RS256, JWKS kept the existing ES256 key
  beside the new RS256 one, every app's sign-in page rendered, and an app without the classic switch was still
  refused a request without PKCE. Migrations `0010`–`0019` and the Fire interface were applied
  and deployed on 2026-11-15, after a backup and a rehearsal of the migrations on a copy of it, and after the same
  release ran on staging. That day: discovery answered with DPoP and the new grant types; JWKS still listed the
  existing key, so tokens issued before the upgrade keep verifying; users, clients, agent grants and refresh tokens
  kept their counts; the Fire files and Imprim's modules are served as static assets; the sign-in page rendered for
  each registered app; and a scheduled run finished without an exception. Not tried there by a person yet: the
  console (its administrators must first add a second factor). Apps on it need client 0.3.0 or later for revocation events.
- **Staging** also runs migrations `0010`–`0018` (passwords, two-factor, account page, passkeys, providers,
  machines, DPoP and exchange, user events, branding), applied on 2026-11-15. There, discovery (client credentials,
  token exchange, introspection, revocation, DPoP and `acr` values), JWKS, the theme and page assets, the branded
  sign-in page, and a logo's byte-for-byte round trip through D1 with its sandbox headers were checked.
- **The Fire interface** (every page rebuilt with Fire, static assets and `_headers`, branding as a Fire look, the
  console's Tweaks panel and logo upload) and migration `0019` were deployed to staging later on 2026-11-15. There,
  the Fire files, fonts and editor module are served as static assets with `nosniff`, same-origin resource policy and
  a sandbox policy on SVG; Worker routes are not shadowed; the sign-in, check-email, signed-out and signed-out account
  pages render in Fire with the page policy unchanged; and discovery lists only the `query` response mode. Signing in,
  the account and two-factor pages, and the console's Branding page with Tweaks and logo upload have not been tried
  there by a person yet.

The [MCP probe](https://github.com/Vibernt/imprim/tree/main/examples/mcp-probe) is built for the agent checks below:
a test MCP server to deploy beside staging, and a scripted agent. Its checks pass against the test harness; it has not
been deployed yet.

Node tests use a real SQLite adapter and controlled provider, mail, rate and queue responses. They do not prove:

- native Safari, Chrome and Firefox cookie flows, or the Fire pages and Tweaks panel in real browsers;
- real Gmail, Outlook and iCloud delivery, and how those clients show the HTML part, its inline logo and dark mode;
- the Spanish, French, German and Portuguese translations, which await native review;
- GitHub, Google, Microsoft and Apple credential acceptance with real apps and tenants;
- Cloudflare rate-limit behaviour, deployed D1 migration and concurrency, or Workers Static Assets headers;
- Worker egress and the DNS-rebinding boundary for metadata and `jwks_uri` fetches;
- Have I Been Pwned range calls from Workers egress;
- passkey ceremonies with platform and roaming authenticators, and authenticator apps reading the built-in QR code;
- DPoP proofs from real agents;
- Queue receipt, retry and deduplication by a real app, for logout, revocation and user events, and block
  propagation to app sessions;
- `/token` regional latency, or OpenID conformance.

See [Control plane](CONTROL_PLANE.md) for delivery and [Operations](OPERATIONS.md#release-gates) for release gates.
