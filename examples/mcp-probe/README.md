# MCP probe

A small MCP server that accepts agents through Imprim. It does two jobs:

- **A reference integration.** It shows everything an app's MCP server does with Imprim, in about 230 lines with
  no dependencies: the challenge, protected resource metadata, exact-audience verification, refusing revoked grants
  and replayed DPoP proofs, intersecting scopes with the person's role, and a verified back-channel.
- **A live test target.** The reference deployment runs it at `https://imprim-probe.vibernt.ai`, against staging
  (`https://id-staging.vibernt.ai`), to test real AI clients. It logs every request (method, path, status, user
  agent, how the call authenticated, which agent and grant), never a token, so a test shows exactly what each
  client tried.

| Path | What it does |
|---|---|
| `POST /w/<workspace>/mcp` | MCP over Streamable HTTP, JSON responses. Without a valid token: 401 with the challenge. Tool: `whoami`. |
| `GET /.well-known/oauth-protected-resource/w/<workspace>/mcp` | Protected Resource Metadata (RFC 9728) naming the issuer. |
| `POST /backchannel` | Verifies `logout_token`, `revocation_token` and `event_token`, records each once by `jti`. |
| `GET /agent/client.json` | A client ID metadata document for the scripted agent below (declares the device grant). |

Workspaces are the `WORKSPACES` var (`team-one,team-two`). `whoami` returns the person (`sub`), the agent
(`client_id`), the grant, the scope the token carries and the scope the app allows.

## Files

| File | Contents |
|---|---|
| `src/worker.mjs` | Routing and the request log |
| `src/mcp.mjs` | The MCP endpoint and its checks |
| `src/events.mjs` | The back-channel endpoint |
| `src/config.mjs` | Settings, the identity client, the agent document |
| `migrations/0001_probe.sql` | Accepted events and seen DPoP proof ids |
| `setup.mjs` | Makes the app client: a secret file and reviewed SQL |
| `agent/run.mjs` | The scripted reference agent |
| `wrangler.jsonc` | The reference deployment's settings |

Tests: `tests/examples-mcp-probe.test.mjs` runs the probe against the real Imprim Worker.

## Set it up

Each step changes something outside this repository, so run them one at a time and read the output.

1. **Make the app client.** This writes a new secret to a file only you can read, and prints SQL to review:

   ```bash
   node examples/mcp-probe/setup.mjs --secret-out ~/.imprim-probe-secret > probe-client.sql
   ```

2. **Register it on staging** after reviewing `probe-client.sql`:

   ```bash
   npx wrangler d1 execute imprim-staging --remote --config apps/server/wrangler.jsonc --env staging --file probe-client.sql
   ```

3. **Create the probe's database**, put its id in `wrangler.jsonc`, and apply the migration:

   ```bash
   npx wrangler d1 create imprim-probe
   ```

   ```bash
   npx wrangler d1 migrations apply imprim-probe --remote --config examples/mcp-probe/wrangler.jsonc
   ```

4. **Deploy the probe.** It needs no secrets:

   ```bash
   npx wrangler deploy --config examples/mcp-probe/wrangler.jsonc
   ```

5. **Invite the tester** to the probe app (staging signs in by email link):

   ```bash
   node examples/mcp-probe/agent/run.mjs invite you@example.com --resource https://imprim-probe.vibernt.ai/w/team-one/mcp --app-secret-file ~/.imprim-probe-secret
   ```

Watch requests while testing:

```bash
npx wrangler tail imprim-probe --format pretty
```

## The scripted agent

`agent/run.mjs check` connects by device flow (one approval in a browser), then checks discovery, the 60-second
lifetime, the audience boundary between workspaces, the app grant API, introspection, expiry, refresh, a retry
after a lost refresh response, reuse detection revoking the grant, and that the revocation event reaches the probe
before the last token expires. It takes about a minute and a half.

```bash
node examples/mcp-probe/agent/run.mjs check --resource https://imprim-probe.vibernt.ai/w/team-one/mcp --app-secret-file ~/.imprim-probe-secret
```

`grants` lists the live grants on the resource, and `revoke <grant_id>` revokes one, as a workspace admin screen
would.

## Testing an AI client

Add `https://imprim-probe.vibernt.ai/w/team-one/mcp` as a remote MCP server in the client, connect, sign in and
approve, then ask it to call `whoami`. For each client, record:

| Question | Where to look |
|---|---|
| Did it use a client ID metadata document or register itself? | Imprim audit, `agent_clients`, the consent page |
| Callback: HTTPS, loopback, or a custom scheme? | The consent page's verification line |
| Did it send `resource`, and which scope did it ask for? | A refused `/authorize` names the reason |
| Which well-known paths did it try on the probe? | `wrangler tail` (`unknown: true` lines) |
| Did `whoami` work, and did it keep working after 60 seconds? | The client, and the probe log |
| After revoking at `/account/agents`: did calls stop, and did the event arrive? | The probe log (`reject: revoked`, `kind: revocation`) |
| Could it reconnect after revocation? | The client |
