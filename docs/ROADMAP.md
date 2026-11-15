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
Tweaks panel in the console.

Planned, roughly in order. Each item is an issue to discuss before code:

1. **Enterprise.** Per-customer SSO routed by email domain (OIDC and SAML), and SCIM provisioning.
2. **Languages.** Translated page and email strings selected by `branding.locale` and `Accept-Language`, with
   copy overrides per language.
3. **HTML email.** A fixed, branded HTML layout alongside the plain-text body.

Still to verify live: Claude Code, Cursor and Codex against a real MCP resource; device flow from a CLI; Workers
egress and DNS-rebinding behaviour; Safari and Chrome cookie flows; Queue delivery against a real app; the Fire
interface on a deployed Worker ([Security](SECURITY.md#not-yet-verified-live)).
