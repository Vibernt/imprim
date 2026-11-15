# Imprim

**Identity for people and the agents that act for them.** Imprim is an open-source OpenID Connect provider and
OAuth 2.1 authorization server that runs on Cloudflare Workers with D1. It has no runtime dependencies and no build
step.

- **People sign in once** per brand, with an email link, a password (breach-checked), a passkey, GitHub, Google,
  Microsoft, Apple or any OpenID Connect provider, chosen per app. SSO across that brand's apps.
- **Two-factor where it matters:** authenticator apps, passkeys and recovery codes; per-app MFA policy, step-up
  (`acr_values`, `max_age`) and MFA for admins and for approving agents. An account page covers sessions, apps,
  agents, email change and deletion.
- **Agents connect for a person, never as one.** A person gives their agent (Claude Code, Cursor, Codex, a CLI) an
  app's MCP address. The agent discovers Imprim, the person approves one workspace and named scopes, and the agent
  gets 60-second, audience-bound tokens that the person can revoke at any time.
- **Apps keep authorisation.** Imprim proves who someone is and what they consented to. Your app keeps workspaces,
  memberships, roles and its own sessions, and checks them on every request.
- **Many brands, one deployment.** Each realm has its own issuer host, signing keys, users, provider credentials,
  email sender, admins and branding. Branding is a look (palette, tone, type set and other tweaks) plus a name,
  copy, links and logos, and each app can override it.
- **Machines too.** Service clients (`client_credentials` with `private_key_jwt`), introspection, revocation,
  DPoP-bound tokens, token exchange between apps, and signed user lifecycle events.
- **An admin console** for apps, users, sessions, service clients, branding, audit, keys and realms.

Docs: **https://vibernt.github.io/imprim/**. Start with [Getting started](docs/GETTING_STARTED.md).

## How it fits together

```text
Person ── browser ───────────┐                         ┌── D1: realms, users, clients, sessions, grants, keys, audit
Agent ─── code / device ─────┼──> Imprim (Worker) ─────┼── Queue: logout, revocation and user events
App ───── OIDC / OAuth ──────┤        │                ├── Email: sign-in links and security notices
Service ── private_key_jwt ──┘        │                ├── GitHub, Google, Microsoft, Apple, OIDC, Turnstile
                                      │                └── Static assets: the Fire design system
App MCP server <── signed access tokens ── verified with imprim-client, intersected with the person's role
```

Standards: OIDC Core with PKCE S256 and `iss` in responses (RFC 9207); OAuth 2.0 Authorization Server Metadata
(RFC 8414); Protected Resource Metadata (RFC 9728); Resource Indicators (RFC 8707); Client ID Metadata Documents and
Dynamic Client Registration (RFC 7591); Device Authorization (RFC 8628); `private_key_jwt` (RFC 7523); Back-Channel
Logout; Security Event Tokens (RFC 8417); Token Introspection (RFC 7662) and Revocation (RFC 7009); Token Exchange
(RFC 8693); DPoP (RFC 9449); WebAuthn Level 2 passkeys; TOTP (RFC 6238).

## Get started

| I want to | Read | Or tell my coding agent |
|---|---|---|
| Run Imprim | [Deploying](docs/DEPLOY.md) | *"Deploy Imprim to my Cloudflare account as staging, following docs/DEPLOY.md. Show me every command and SQL file first and ask me for each secret."* |
| Add sign-in to my app | [Integrating](docs/INTEGRATE.md) | *"Add sign-in with Imprim (issuer https://id.example.com, client my-app) to this app using imprim-client. Keep our sessions and roles, key users on (iss, sub), and add negative tests."* |
| Let agents use my app | [Integrating §4](docs/INTEGRATE.md#4-accept-agents-on-your-mcp-server) | *"Protect our MCP endpoint with Imprim: serve resource metadata, return the challenge, verify each token's exact audience, and check the person's role on every call."* |
| Connect my agent | Nothing to set up | *"Connect to the MCP server at https://app.example.com/w/team-one/mcp."* |

The full prompts are in [Getting started](docs/GETTING_STARTED.md).

Run the checks locally (Node 22.13 or later):

```bash
npm run test:quiet
```

```bash
npm run check
```

## Repository

| Path | Contents |
|---|---|
| `apps/server/src/` | The Worker: routes, sign-in, OIDC, agents, realms, admin console, pages, maintenance |
| `apps/server/public/` | Static assets: the vendored Fire design system (`fire/`), the branding editor (`imprim/`) and `_headers` |
| `apps/server/migrations/` | D1 schema, `0001` to `0019` |
| `packages/imprim-client/` | Zero-dependency client for apps and MCP servers |
| `scripts/` | Offline SQL generators for realms, clients and user imports; checks; client build |
| `tests/` | `node:test` suites on a real SQLite harness, including negative tests at every trust boundary |
| `docs/` | Guides, protocol, security and operations ([index](docs/README.md)) |
| `docs/fire/` | Fire's guide, writing rules and class vocabulary, and how Imprim uses Fire |

## Built with

Every page uses the [Fire design system](docs/fire/README.md) (MIT), vendored in `apps/server/public/fire/`, with
fonts under the SIL Open Font License and [Lucide](https://lucide.dev) icons (ISC).

## Status

Vibernt runs Imprim in production at `https://id.vibernt.ai`, with staging at `https://id-staging.vibernt.ai`.
Production runs the 2026-11-15 release (the security pass, realms and the rename; see
[Security pass](docs/SECURITY_PASS.md)). Staging also runs passwords, two-factor, the account page, passkeys, the
provider registry, machines, DPoP, user events, branding and the Fire interface (migrations `0010`–`0019`), deployed
on 2026-11-15; production follows after the staging checks ([Deploying](docs/DEPLOY.md)).
What has not been verified against live Cloudflare is listed in [Security](docs/SECURITY.md#not-yet-verified-live).
What comes next is in the [Roadmap](docs/ROADMAP.md).

## Contributing

Contributions are welcome. Open an issue to agree the design, then send a pull request with tests: negative tests
at every trust boundary, plus `npm run test:quiet` and `npm run check` passing. See [CONTRIBUTING.md](CONTRIBUTING.md).
Report vulnerabilities privately ([SECURITY.md](SECURITY.md)), never in a public issue.

## Licence

[MIT](LICENSE) © 2026 Vibernt
