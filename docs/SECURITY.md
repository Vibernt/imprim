# Security

Identity crosses browser, app, provider, email and agent boundaries. A valid identity subject is not an app role. An agent grant names a person, app resource and scopes; it is not an app API token. App developers must check current workspace membership and role on every resource request. See [Protocol](PROTOCOL.md) for exact requests and errors.

## Threats and controls

| Threat | Implemented control |
|---|---|
| Redirect or client substitution | App callbacks and logout returns must match registered strings exactly. HTTPS is required except exact development loopback. Agent redirects permit HTTPS or HTTP loopback; only the loopback port can vary at authorization. |
| Intercepted authorization code | S256 PKCE is mandatory. App and agent codes live 60 seconds and are atomically single-use. Known human code replay is audited. |
| Login response injection | App login uses browser-bound state and nonce; authorization responses carry `iss`. The client verifies issuer, signature, audience, `azp`, nonce and time. |
| Upstream provider confusion | GitHub/Google state is hashed, provider-scoped and browser-bound. Google requires a signed RS256 ID token, exact audience, nonce, verified email and, when configured, signed `hd`. |
| Stolen identity cookie or CSRF | Secure host-only `__Host-` cookies, HttpOnly session, SameSite=Lax, 30-day expiry. Session mutations require exact Origin and matching cookie/submitted CSRF token. Session and CSRF values are hash-stored. |
| Magic link prefetch or reuse | Token stays in URL fragment until an explicit click. The POST checks original browser, expiry, admission and single use. Only its hash is stored. |
| Signing-key disclosure or substitution | AES-256-GCM sealed private ES256 JWKs with kid-bound authenticated data. JWKS publishes public keys only. Only ES256/P-256 is accepted; token-supplied key URLs are ignored. |
| Hostile branding or logo | Branding is tokens only (no CSS, HTML or script), validated and escaped. SVG uploads with script, handlers, styles, links or external references are refused; assets are realm-scoped and served sandboxed with `nosniff`. |
| Malicious HTML or agent name | Escaped page text, strict CSP, same-origin forms, no inline script, frame denial. Turnstile script/frame origin is allowed only on the configured sign-in page. |
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

Content Security Policy allows Turnstile's origin only on the sign-in page that renders the widget. Every other page has `script-src 'self'` and `frame-src 'none'`.

## Logs and reporting

Worker errors log structured type/path/code without tokens. Audit records include sign-in, code replay, mail delivery failure, degraded Turnstile, unreadable keys and agent grant activity. Audit has append-only D1 triggers. Wrangler disables invocation logs because OAuth callbacks carry query credentials. Operators should inspect actual Cloudflare log settings and retention before deployment. Do not include tokens, raw email links, client secrets or provider credentials in an issue.

Report a suspected vulnerability privately through GitHub's private vulnerability reporting on the repository (see [SECURITY.md](https://github.com/Vibernt/imprim/blob/main/SECURITY.md)), never in a public issue. Include affected route, time, expected and observed behavior, and redacted request IDs or audit events.

## Not yet verified live

A build of this repository serves `https://id.vibernt.ai`: discovery and JWKS answered on 2026-11-15. This repository does not record which commit is deployed or which clients are registered there; check the Worker's deployments in Cloudflare before relying on a behavior described here. On 2026-11-15 migrations `0008` (security pass) and `0009` (realms) were applied to `https://id.vibernt.ai` and that release was deployed there, after the same release passed on staging (`https://id-staging.vibernt.ai`). Apps on it still need client 0.3.0 for revocation events. Node tests use a real SQLite adapter and controlled provider, mail, rate and queue responses. They do not prove native Safari/Chrome cookie flows, real Gmail/Outlook/iCloud delivery, GitHub/Google credential acceptance, Cloudflare rate behavior, deployed D1 migration and concurrency, Worker egress and DNS rebinding boundary, Queue receipt/retry/deduplication, `/token` regional latency or OpenID conformance. The Assay switch and Touchstone integration have not occurred. M4 human back-channel logout and the admin console are implemented locally; deployed block propagation remains unverified.

Migrations `0010`–`0018` (passwords, two-factor, account page, passkeys, providers, machines, DPoP and exchange,
user events, branding) were applied to staging on 2026-11-15 and this code deployed there; production does not
have them yet. On staging, discovery (client credentials, token exchange, introspection, revocation, DPoP and
`acr` values), JWKS, the theme and page assets, the branded sign-in page, and a logo's byte-for-byte round trip
through D1 with its sandbox headers were checked. Not yet proven live: Have I Been Pwned range calls
from Workers egress, passkey ceremonies in Safari, Chrome and Firefox with platform and roaming authenticators,
authenticator apps reading the in-house QR code, Microsoft and Apple sign-in with real tenants, DPoP proofs from
real agents, and user events reaching a real app. See [Control plane](CONTROL_PLANE.md). See [Operations](OPERATIONS.md) for release gates.
