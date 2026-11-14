# Assay extraction provenance

Source repository: the Assay repository, read-only during this task. Inspected source HEAD:
`dfd12b6abeb5173563b5a3ac4d3d5b398d26b393`. This is an adaptation to a separate
identity service, not a byte-for-byte copy or a runtime dependency. No Assay workspace policy or memberships moved.

| Assay source | Identity destination / adaptation |
|---|---|
| `src/auth/magic.mjs` | `auth/magic.mjs`, `auth/session.mjs`, `services/admission.mjs`: neutral email request, fragment token, hash storage, single-use verification, session issuance. Added original-browser authorization binding. |
| `src/auth/session.mjs` | `auth/session.mjs`: hashed session/CSRF, Origin and double submit. Mandatory Origin, Secure `__Host-` cookies, 30 days; no bearer app tokens or insecure dev mode. |
| `src/auth/github-sign-in.mjs` | `auth/github-sign-in.mjs`, `github-profile.mjs`, `github-identity.mjs`: state DELETE RETURNING, nonce cookie, S256, numeric id linking, verified primary email, operator email-only. |
| `src/auth/github-identity.mjs` | Reviewed advisory GitHub-login lookup/cache; not copied because identity has no “your CI runs” view. Durable provider id mapping comes from github-sign-in. |
| `src/auth/rate-limit.mjs`, magic's D1 budget | `auth/rate-limit.mjs`: Workers binding limits plus separate email/IP budget. Missing-binding D1 fallback removed. |
| `src/auth/turnstile.mjs` | `auth/turnstile.mjs`, `auth/magic.mjs`, `pages/sign-in.mjs`: widget and siteverify action/host validation, timeout and replay record. Both keys absent means Turnstile is off. On siteverify outage, only active existing users can receive links, under stricter limits with an audit event. Dummy production keys and automatic retry remain excluded. |
| `src/services/registration.mjs` | Only sign-in admission: existing identity, client invitation/domain, invited/open. Workspace creation, platform membership and Assay operator policy stay in Assay. |
| `src/services/oidc-keys.mjs`, `oidc-seal.mjs` | `oidc/keys.mjs`, `lib/crypto.mjs`: generation convergence, sealed ES256, kid AAD, prepublication/retirement. An unreadable active key is retired and replaced with an audited new generation; unreadable retired keys are excluded from JWKS; M4 healthy retired keys remain for their verification window. One SEALING_KEY rather than a general KEK ring. |
| `src/services/workload-identity.mjs` | `oidc/jwt.mjs`: ES256 compact signing and public JWKS pattern, with human OIDC claims instead of workload claims. |
| `src/lib/crypto.mjs` | Narrowed WebCrypto random token, SHA-256, base64url, AES-GCM primitives. |
| `migrations/0001_catalog.sql`, `0026_oidc_signing_keys.sql`, `0048_github_sign_in.sql` | `migrations/0001_identity.sql`: renamed users/provider subjects, separate identity sessions and new OIDC/client/audit records. |
| `tests/support/sqlite.mjs` | `tests/support/sqlite.mjs`: real node:sqlite D1 adapter and atomic batch rollback, without tenant/DO infrastructure. |
| `tests/github-sign-in.test.mjs`, `turnstile.test.mjs`, `workload-identity.test.mjs` | Adapted state/nonce/PKCE/profile/admission, challenge and key concurrency/rotation negative scenarios. CI/provider/workload-only tests are intentionally excluded. |
| `AGENTS.md`, `CLAUDE.md` | Short rules: ESM/no runtime dependencies, modular layout, transaction I/O separation, negative tests, explicit failures and reporting. |

New protocol work: OIDC discovery/authorization/token/UserInfo/logout, exact redirect validation, code replay audit,
client-scoped invitations, stable-subject offline import, standalone operator bootstrap, and their negative tests.

Differences requiring release review: the Turnstile script/frame exception is now approved and pinned in the HTML CSP;
RP logout requires confirmation. The client SDK and agent revocation delivery are implemented; the M4 admin console and human back-channel logout are implemented locally. Hosted M4 integration remains unverified. Turnstile's existing-user outage mode was explicitly approved for this service.
