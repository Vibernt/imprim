# Security pass, 2026-11-15

Developed on 2026-11-15 on top of the first production release. It fixes the findings of a review brief of 2026-11-15
(section 8). Migration `0008_security_pass.sql` and client `0.3.0` go together. Deployed to staging and production on 2026-11-15 (see Live checks owed).

## Findings and fixes

| # | Fix | Where | Tests |
|---|---|---|---|
| S1 | The device grant is never a default; a document must declare it. Device and loopback consents say "Agent calling itself …", label the host "claimed, not verified" and carry RFC 8628 §5.4 wording. An HTTPS callback or a signing key shows the host as verified. Agents may publish keys (`jwks` or same-host `jwks_uri`) and then must send a single-use `private_key_jwt` assertion to `/device_authorization` and every `/token` call. The allowlist is documented as not authenticating. | `agents/registration.mjs`, `agents/client-auth.mjs`, `agents/consent.mjs` | `security-pass.test.mjs` S1 |
| S2 | Discovery, JWKS and assets have no per-address limit; JWKS is memoised per isolate for 60 s. `/token`, `/userinfo` and `/v1/invitations` spend a per-client budget after authentication; failed authentication spends the address budget. Agent `/token` stays per address. | `worker.mjs`, `oidc/token.mjs`, `oidc/keys.mjs` | S2 |
| S3 | `client_admissions` records admission per (user, client), backfilled from app sessions, agent grants and `token_issued` audit rows. SSO, agent consent and `/token` check it; refused SSO returns `error=access_denied`. | `services/admission.mjs`, `oidc/requests.mjs`, `oidc/token.mjs` | `magic.test.mjs`, `google.test.mjs` |
| S4 | Domain admission and auto-linking need mailbox proof: an email link, or Google with `hd` equal to the domain (or `gmail.com`). GitHub never auto-links by email; linking works from a browser already signed in to the account. | `services/admission.mjs`, `auth/provider-identity.mjs` | `github.test.mjs`, `google.test.mjs` |
| S5 | Spent refresh tokens are kept 7 days, ended grants 30 days, audit 400 days (the trigger refuses younger deletes). A refresh writes no audit row. Each grant has 3,000 refreshes a day; a person has at most 50 live grants. `/account` is paged. | `services/maintenance.mjs`, `agents/token.mjs`, `agents/account.mjs`, migration | S5 |
| S6 | Only proven corruption (AES-GCM failure, unreadable envelope, public-key mismatch) retires a key. D1 errors and missing rows are rethrown. An unreadable active key stays verifiable 24 h; an unreadable pre-published key leaves at once. | `oidc/keys.mjs` | `keys.test.mjs` |
| S7 | User codes use all 20 letters (20⁸ ≈ 2³⁴·⁶). Address budgets key on the IPv6 /64. | `agents/device.mjs`, `auth/rate-limit.mjs` | S7 |
| S8 | A recipient gets at most 5 sign-in emails an hour (3 when degraded), whatever the source address. | `auth/rate-limit.mjs` | S8 |
| S9 | Host allowlist entries match the full host. | `agents/policy.mjs` | S9 |
| S10 | Metadata URLs must use port 443. Agent `/authorize` has a 60-per-hour address budget. Documents are cached at least 5 minutes. | `agents/metadata-http.mjs`, `agents/authorize.mjs` | S10, `agents-metadata.test.mjs` |
| S11 | Agent names lose bidi, zero-width and control characters; unverified headings say "Unverified agent calling itself …". | `agents/registration.mjs`, `agents/consent.mjs` | S11 |
| S12 | Turning `agent_access` off revokes and notifies every live grant in the same transaction; turning it on revives none. | `admin/clients.mjs` | S12 |
| S13 | `/account/revoke` and reuse handling queue only their own event, in `waitUntil`; the cron handles the backlog. | `services/outbox.mjs`, `agents/revocation.mjs` | `agents-boundaries.test.mjs` |
| S14 | Every admin write, including client create and edit, needs a sign-in within ten minutes. | `admin/routes.mjs` | S14 |
| S15 | `POST /admin/keys/<kid>/revoke` drops a key from JWKS at once and signs with a replacement. Client 0.3.0 refetches JWKS after 10 minutes, with a 24-hour fallback only while identity is unreachable. | `oidc/keys.mjs`, client `index.mjs` | `keys.test.mjs` |
| S16 | A replayed human code deletes the access token it issued; a replayed agent code revokes its grant. | `oidc/token.mjs`, `agents/token.mjs` | `agents-flow.test.mjs` |
| S17 | Revocation outbox rows are written even without a back-channel URI, so they show as `missing_uri`. | `agents/revocation.mjs`, `admin/users.mjs` | `agents-boundaries.test.mjs` |
| S18 | Client 0.3.0 requires `iss` on callbacks. | client `index.mjs` | S18 |
| S19 | Duplicate cookies are refused only for `__Host-vi_*` names. | `auth/session.mjs` | S19 |

Hygiene, also done: Turnstile's CSP origin only on the sign-in page; `email` claims only with the `email` scope;
failed discovery not cached; `error_description` kept out of `IdentityError.message`; late `prompt=none` failures
redirect with an OAuth error; revocation events are `secevent+jwt` with an issuer-relative type; resources have one
canonical form; refresh can narrow scope; a 10-second refresh grace that cannot be chained; expiry indexes for
every swept table; `/register` no longer runs a full-table delete; stale "not deployed" docs corrected.

Not changed, on purpose: `localhost` stays an accepted loopback redirect host, because common agents register
`http://localhost:<port>/callback` (RFC 8252 prefers literal addresses; refusing would break them).

## Independent review of this branch

A separate read-only review of the diff found no authentication bypass and confirmed the bind order, grace window
and single-use claims. It found six issues, all fixed in a follow-up commit, each with a negative test
(`security-pass.test.mjs`, "review N"):

1. A public client is named by a bare `client_id`, so its `/token` calls spent the app's shared budget. They now
   spend the caller's address budget; only a client secret spends the app's.
2. The refresh admission fence used an unqualified `user_id`, which resolved inside its own subquery and so checked
   nothing. It is now `agent_grants.user_id`.
3. A provider could create an account on a stale "verified" email that the mailbox owner later signs in to. Such
   accounts are now `email_verified=0`. The first mailbox proof (an email link, or authoritative Google) removes the
   provider links and ends every session and grant made on the provider's word (`claimMailbox`, audited as
   `mailbox_claimed`).
4. A leaked code or spent refresh token could revoke a key-bound agent's grant. Revocation on replay now requires
   the agent's assertion.
5. A replay could land between code consumption and recording the issued access token. The replay now marks the
   code, and the issuance refuses to insert behind that marker.
6. A `{version:1}` envelope with a malformed `iv` blocked signing. The envelope is validated, and a bad one is
   treated as corruption.

## Rollout

1. Back up D1. Apply `0008_security_pass.sql` (`wrangler d1 migrations apply`), then deploy the Worker.
2. Upgrade each app to client `0.3.0` in the same window. Revocation events are re-signed on each retry for 24
   hours, so a short gap converges. Apps that relied on `email` in the ID token must request the `email` scope.
3. Tell agent authors that the device grant must be declared in their metadata document.
4. People whose existing account is not linked to GitHub must sign in once by email link before GitHub links.
   Accounts created by GitHub (or by Google without `hd`) are unverified until their first email link.
5. Watch audit for `agent_code_replay`, `agent_refresh_reuse` and `code_replay`.
6. The per-client `/token` budget uses `API_LIMITER` (120 a minute). An app above about two sign-ins a second
   needs a higher limit or its own binding.

## Live checks owed

Deployed 2026-11-15: on staging and production, migrations applied cleanly, discovery, JWKS (unchanged key), sign-in pages, `/authorize` redirect validation, cross-origin refusal, magic-link delivery and the scheduled handler were checked. Still to prove: per-client rate limits from a deployed app Worker (S2),
egress and DNS rebinding for metadata and `jwks_uri` fetches (S10), Queue delivery of `secevent+jwt` events to a
real app, the D1 migration's backfill on production data, and the trigger's `strftime('now')` on D1.
