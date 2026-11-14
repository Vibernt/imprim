# Roadmap

Done: email-link, GitHub and Google sign-in per app; per-app admission; agent access (client ID metadata documents,
dynamic registration, PKCE, resource indicators, device flow, 60-second tokens, rotating refresh tokens with reuse
detection, `private_key_jwt` agents); signed back-channel logout and revocation events; an admin console;
per-realm issuers, keys, users, providers, email and admins; passwords (breach-checked, lockout, reset by email link); TOTP, recovery codes, trusted browsers, per-app MFA
policy, step-up (`acr_values`, `max_age`) and MFA for admins and agent consent; the account page (profile, email change, sessions, apps, agents, deletion),
security notices and admin MFA reset; passkeys (WebAuthn) for passwordless sign-in and as a second factor; a provider registry (any OIDC issuer,
Microsoft/Entra ID, Sign in with Apple) with per-realm credentials and `trusted_domains`.

Planned, roughly in order. Each item is an issue to discuss before code:

1. **Branding.** Realm defaults and per-client overrides: logo, mark, colours and fonts from an allowlist (checked
   for WCAG AA on save), copy overrides with i18n keys, privacy and terms links, email templates (text plus a fixed
   HTML layout). Assets go through R2 with SVG sanitising. No custom CSS or JS, ever.
5. **Machines and delegation.** `client_credentials` with `private_key_jwt` for service clients; token exchange
   (RFC 8693) with `act` chains; DPoP (RFC 9449); introspection (RFC 7662) and revocation (RFC 7009); an app-side
   API for workspace admins to list and revoke agents.
6. **Platform.** Back-channel events for user updates, blocks, deletions and MFA resets; audit export; rate limits
   keyed by realm and account; OpenID conformance in CI against staging.
7. **Enterprise.** Per-customer SSO routed by email domain (OIDC and SAML), and SCIM provisioning.

Still owed from earlier milestones: live qualification with Claude Code, Cursor and Codex against a real MCP
resource; device flow from a CLI; Workers egress and DNS-rebinding behaviour; Safari and Chrome cookie flows; Queue
delivery against a real app.
