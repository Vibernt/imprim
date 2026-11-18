# Roadmap

Done: email-link, GitHub and Google sign-in per app; per-app admission; agent access (client ID metadata documents,
dynamic registration, PKCE, resource indicators, device flow, 60-second tokens, rotating refresh tokens with reuse
detection, `private_key_jwt` agents); signed back-channel logout and revocation events; an admin console;
per-realm issuers, keys, users, providers, email and admins; passwords (breach-checked, lockout, reset by email link); TOTP, recovery codes, trusted browsers, per-app MFA
policy, step-up (`acr_values`, `max_age`) and MFA for admins and agent consent; the account page (profile, email change, sessions, apps, agents, deletion),
security notices and admin MFA reset; passkeys (WebAuthn) for passwordless sign-in and as a second factor; a provider registry (any OIDC issuer,
Microsoft/Entra ID, Sign in with Apple) with per-realm credentials and `trusted_domains`; service clients (`client_credentials` with `private_key_jwt`),
introspection, revocation, an app grant API, DPoP-bound tokens and token exchange between apps; user lifecycle events to apps and audit export;
every page built with the Fire design system; branding per realm and per app as a Fire look (palette, tone, type set
and other tweaks) with name, copy, links and sandboxed logo uploads, branded pages and email footers, and Fire's
Tweaks panel in the console; pages and emails in English, Spanish, French, German and Portuguese (Brazil), chosen by
`ui_locales`, the person's saved language, `Accept-Language` and the brand, with per-language brand words
([Languages](TRANSLATING.md)); a branded HTML part, light and dark, beside the plain text of every email;
`id_token_hint`, `POST /authorize`, `client_secret_post`, UserInfo body tokens, per-app classic OpenID Connect and
RS256 ID tokens; agents at scale (token budgets per grant and per agent, grants API paging, `listGrants`, `revokeGrant`
and `introspect` in `imprim-client`, `agent_assurance`, registrations kept while a grant is live);
opt-in shared and personal workspaces for a family of products (members, base roles, invitations in five languages,
signed versioned events, agent resources revoked on removal; [Shared workspaces](WORKSPACES.md)).
The OpenID conformance suite passed ([OpenID certification](CERTIFICATION.md)).

Planned, roughly in order. Each item is an issue to discuss before code:

1. **Enterprise.** Per-customer SSO routed by email domain (OIDC and SAML), and SCIM provisioning.
2. **Native review of the translations.** The Spanish, French, German and Portuguese catalogues are drafts until
   native speakers have read them. Then more languages, and the admin console.

Certification: the conformance suite's Basic, Config, RP-Initiated Logout and Back-Channel Logout plans passed on
staging on 2026-11-17 with no failures; what remains is submitting them to self-certify
([OpenID certification](CERTIFICATION.md)). Dynamic OP would need open registration for web apps.

Verified live on 2026-11-17: Claude Code against a real MCP resource in production, from consent through refresh to
revocation delivered to the app. Still to verify live: Cursor and Codex; device flow from a CLI; Workers egress and
DNS-rebinding behaviour; Safari and Chrome cookie flows; retry and deduplication by a real app; the Fire interface on
a deployed Worker ([Security](SECURITY.md#not-yet-verified-live)). The
[MCP probe](https://github.com/Vibernt/imprim/tree/main/examples/mcp-probe) is the target for the agent and device
checks: a test MCP server for staging, and a scripted agent that runs the device flow, refresh, reuse detection and
revocation delivery end to end.
