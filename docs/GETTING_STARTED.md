# Getting started

Imprim proves who a person is, and records which agents they allowed to act for them. Your apps keep their own
users' roles, workspaces and sessions. There are three ways in, depending on what you are doing.

## 1. Run Imprim on Cloudflare

You need a Cloudflare account with Workers, D1, Queues and Email sending, and a domain for the issuer (for example
`id.example.com`). Then:

```bash
git clone https://github.com/Vibernt/imprim.git
```

```bash
cd imprim && npm run test:quiet
```

Follow [Deploying](DEPLOY.md): create the D1 database and queues, set `SEALING_KEY`, apply the migrations, create
your realm and first admin with `scripts/realm.mjs`, and deploy with `wrangler deploy --env staging`. Check
`https://id.example.com/.well-known/openid-configuration`, then sign in to `/admin` and register your first app.

**Or ask your coding agent** (Claude Code, Cursor, Codex) from the repository root:

> Deploy Imprim to my Cloudflare account as a staging environment, following docs/DEPLOY.md. The issuer host is
> id.example.com, the realm is "example" with display name "Example", and the first platform admin is me
> (ops@example.com). Show me every command and every generated SQL file before you run it, ask me for each secret
> instead of inventing one, and stop if a step fails.

## 2. Add sign-in to your app

Register the app in your realm's console (`https://id.example.com/admin` → Clients). Then use the zero-dependency
client in `packages/imprim-client` (`createClient`, `startLogin`, `handleCallback`, `verifyBackchannel`). See
[Integrating](INTEGRATE.md#2-sign-people-in).

**Or ask your coding agent**, in your app's repository:

> Add sign-in with Imprim to this app. Issuer: https://id.example.com. Client id: my-app. The client secret is in
> the IDENTITY_CLIENT_SECRET secret. Read https://vibernt.github.io/imprim/INTEGRATE.html and use the imprim-client
> package. Keep our own sessions, roles and CSRF. Key local users on (issuer, sub), not email. Implement the
> back-channel endpoint with durable jti deduplication. Add negative tests for a wrong state, a replayed code, a
> wrong audience and a missing iss. Do not change anything about authorisation inside the app.

## 3. Let agents use your app

Turn on agent access for the app (console → client → `agent_access: on`, resource prefixes and a scope catalogue).
Then make your MCP server answer with the OAuth challenge and verify tokens on every call. See
[Integrating](INTEGRATE.md#4-accept-agents-on-your-mcp-server).

**Or ask your coding agent**, in your app's repository:

> Protect our MCP endpoint at /w/<workspace>/mcp with Imprim (issuer https://id.example.com). Serve protected
> resource metadata, return the WWW-Authenticate challenge from imprim-client when there is no token, and verify
> each token with verifyAccessToken using the exact workspace resource as the audience. Deny revoked grants from
> back-channel events, and intersect token scopes with the person's current role on every request. Follow
> https://vibernt.github.io/imprim/INTEGRATE.html#4-accept-agents-on-your-mcp-server and add negative tests for
> another workspace's token, an expired token and a revoked grant.

**Connecting as a person** needs no setup at all. Give your agent the app's MCP address, for example:

> Connect to the MCP server at https://app.example.com/w/team-one/mcp.

The agent discovers Imprim, opens your browser (or shows a device code), and you approve exactly which workspace
and scopes it gets. You can see and revoke every connected agent at `https://id.example.com/account/agents`.

## Next

- [Realms](REALMS.md): run several brands on one deployment.
- [Branding](BRANDING.md): your Fire look, logo, copy and links, per realm and per app.
- [Agent access](AGENT_ACCESS.md) and [Protocol](PROTOCOL.md): the exact flows, tokens and errors.
- [Security](SECURITY.md): the threat model and what still needs live verification.
- [Roadmap](ROADMAP.md): what is planned next, and where to help.
