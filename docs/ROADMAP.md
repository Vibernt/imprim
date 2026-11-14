# Roadmap

Done: email-link, GitHub and Google sign-in per app; per-app admission; agent access (client ID metadata documents,
dynamic registration, PKCE, resource indicators, device flow, 60-second tokens, rotating refresh tokens with reuse
detection, `private_key_jwt` agents); signed back-channel logout and revocation events; an admin console;
per-realm issuers, keys, users, providers, email and admins; passwords (breach-checked, lockout, reset by email link).

Planned, roughly in order. Each item is an issue to discuss before code:

1. **Branding.** Realm defaults and per-client overrides: logo, mark, colours and fonts from an allowlist (checked
   for WCAG AA on save), copy overrides with i18n keys, privacy and terms links, email templates (text plus a fixed
   HTML layout). Assets go through R2 with SVG sanitising. No custom CSS or JS, ever.
2. **Account security.** TOTP, recovery codes, trusted devices, a per-client MFA policy with step-up (`acr_values`, `max_age`,
   `prompt=login`), and correct `amr`/`acr` claims. Account page for factors, sessions, connected apps, profile,
   email change and deletion.
3. **Passkeys** (WebAuthn) as a primary method and as a second factor.
4. **Provider registry.** Microsoft/Entra, Apple and generic OIDC upstreams, with per-realm credentials.
5. **Machines and delegation.** `client_credentials` with `private_key_jwt` for service clients; token exchange
   (RFC 8693) with `act` chains; DPoP (RFC 9449); introspection (RFC 7662) and revocation (RFC 7009); an app-side
   API for workspace admins to list and revoke agents.
6. **Platform.** Back-channel events for user updates, blocks, deletions and MFA resets; audit export; rate limits
   keyed by realm and account; OpenID conformance in CI against staging.
7. **Enterprise.** Per-customer SSO routed by email domain (OIDC and SAML), and SCIM provisioning.

Still owed from earlier milestones: live qualification with Claude Code, Cursor and Codex against a real MCP
resource; device flow from a CLI; Workers egress and DNS-rebinding behaviour; Safari and Chrome cookie flows; Queue
delivery against a real app.
