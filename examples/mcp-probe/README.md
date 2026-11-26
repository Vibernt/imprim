# MCP probe

A small MCP server that accepts agents through Imprim. It does two jobs:

- **A reference integration.** It shows what an app's MCP server does with Imprim, with no dependencies:
  the challenge, protected resource metadata, exact-audience verification, refusing revoked grants
  and replayed DPoP proofs, intersecting scopes with the person's role, and a verified back-channel.
- **A live test target.** Deploy it beside your staging issuer, for example at `https://probe.example.com`, to test
  real AI clients. It logs each request's method, path, status, user agent, authentication method, agent and
  grant. Tokens stay out of the log.

| Path | What it does |
|---|---|
| `POST /w/<workspace>/mcp` | MCP over Streamable HTTP, JSON responses. Without a valid token: 401 with the challenge. Tool: `whoami`. |
| `GET /.well-known/oauth-protected-resource/w/<workspace>/mcp` | Protected Resource Metadata (RFC 9728) naming the issuer. |
| `POST /mcp` | Product-wide MCP resource. The person picks a workspace at consent. Requires `PRODUCT_RESOURCE=on`. |
| `GET /.well-known/oauth-protected-resource/mcp` | Metadata for the product resource. Requires `PRODUCT_RESOURCE=on`. |
| `POST /backchannel` | Verifies `logout_token`, `revocation_token` and `event_token`, records each once by `jti`. |
| `GET /agent/client.json` | A client ID metadata document for the scripted agent below (declares the device grant). |

Workspace routes use `WORKSPACES` (`team-one,team-two`). `whoami` returns the subject (`sub`), the client
(`client_id`), the grant, token and app scopes, and `kind` (`person` or `machine`). It includes `workspace_id`
and `accountable_sub` when the token carries them. The product endpoint verifies the exact `/mcp` audience
and requires `workspace_id`.

With `APP_SECRET`, `/mcp` checks current membership for the person or the machine's `accountable_sub` on every
call. `whoami` reports `membership: "checked"` or `"not checked"` for `/mcp`. A real app always checks current
membership and role.

## Files

| File | Contents |
|---|---|
| `src/worker.mjs` | Routing and the request log |
| `src/mcp.mjs` | The MCP endpoint and its checks |
| `src/events.mjs` | The back-channel endpoint |
| `src/config.mjs` | Settings, the identity client, the agent document |
| `migrations/0001_probe.sql` | Accepted events and seen DPoP proof ids |
| `setup.mjs` | Makes the app client: a secret file and reviewed SQL |
| `agent/` | The scripted reference agent, browser flows and workspace commands |
| `wrangler.jsonc` | Example deployment settings |

Tests: `tests/examples-mcp-probe.test.mjs` runs the probe against the real Imprim Worker.

## Set it up

Each step changes something outside this repository, so run them one at a time and read the output.

1. **Make the app client.** First set your probe host and staging issuer in `wrangler.jsonc` (`routes`, `ORIGIN`
   and `ISSUER`). Pass the same probe origin to the setup script. It writes a secret file only you can read and
   prints SQL to review.

   ```bash
   node examples/mcp-probe/setup.mjs --origin https://probe.example.com --secret-out ~/.imprim-probe-secret > probe-client.sql
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

4. **Deploy the probe.** The workspace routes need no secrets:

   ```bash
   npx wrangler deploy --config examples/mcp-probe/wrangler.jsonc
   ```

5. **Invite the tester** to the probe app (staging signs in by email link):

   ```bash
   node examples/mcp-probe/agent/run.mjs invite you@example.com --resource https://probe.example.com/w/team-one/mcp --app-secret-file ~/.imprim-probe-secret
   ```

Watch requests while testing:

```bash
npx wrangler tail imprim-probe --format pretty
```

For workspace choice, add `--product probe-tools` to the setup command before registering the app. The product
name starts with a letter and uses 2–40 lowercase letters, digits or hyphens. Enable shared workspaces in the
Imprim realm, give the tester a workspace that uses that product, and set `PRODUCT_RESOURCE=on` in the probe's
Wrangler vars (default `off`). To test live membership too, set the probe's `APP_SECRET` to the secret from setup.

```bash
npx wrangler secret put APP_SECRET --config examples/mcp-probe/wrangler.jsonc < ~/.imprim-probe-secret
```

## The scripted agent

`agent/run.mjs check` connects by device flow (one approval in a browser), then checks discovery, the 60-second
lifetime, the audience boundary between workspaces, the app grant API, introspection, expiry, refresh, a retry
after a lost refresh response, reuse detection revoking the grant, and that the revocation event reaches the probe
before the last token expires. It takes about a minute and a half. Open the one-time local link it prints in a
browser on the same computer.

Add `--flow loopback` to sign in the way a desktop agent does instead: the script prints an address to open in a
browser on the same computer, and the approval comes back to a one-time listener on `127.0.0.1` (RFC 8252). It then
checks that the code redeems once, and runs the same checks.

```bash
node examples/mcp-probe/agent/run.mjs check --resource https://probe.example.com/w/team-one/mcp --app-secret-file ~/.imprim-probe-secret
```

Use `--resource https://probe.example.com/mcp` with either flow to test workspace choice. Pick a workspace on
the consent page. The script checks that `whoami` echoes the token's `workspace_id` and that `/w/team-one/mcp`
refuses the token.

`grants` lists the live grants on the resource, and `revoke <grant_id>` revokes one, as a workspace admin screen
would.

`name` registers or renames a workspace-specific resource and checks that repeating the write leaves the workspace
version unchanged. Use the Imprim workspace ID.

```bash
node examples/mcp-probe/agent/run.mjs name <workspace_id> https://probe.example.com/w/team-one/mcp --name "Team tools" --app-secret-file ~/.imprim-probe-secret
```

`machine` requests a `probe.read` machine client for one workspace. An owner or admin opens the printed approval
URL. The script polls every five seconds for up to ten minutes, then checks the short-lived token, `whoami`,
audience isolation and introspection. The signing key stays in memory. Disable the client from Account › Agents
when done. Pass `--resource https://probe.example.com/mcp` to select the endpoint explicitly.

```bash
node examples/mcp-probe/agent/run.mjs machine <workspace_id> --app-secret-file ~/.imprim-probe-secret
```

## Testing an AI client

Add `https://probe.example.com/w/team-one/mcp` as a remote MCP server in the client, connect, sign in and
approve, then ask it to call `whoami`. For each client, record:

| Question | Where to look |
|---|---|
| Did it use a client ID metadata document or register itself? | Imprim audit, `agent_clients`, the consent page |
| Callback: HTTPS, loopback, or a custom scheme? | The consent page's verification line |
| Did it send `resource`, and which scope did it ask for? | A refused `/authorize` names the reason |
| Which well-known paths did it try on the probe? | `wrangler tail` (`unknown: true` lines) |
| Did `whoami` work, and did it keep working after 60 seconds? | The client, and the probe log |
| Did `/mcp` offer workspace choice and return the chosen `workspace_id`? | Consent, `whoami`, and the product `check` run |
| Did the approved machine get a 60-second token for its resource and show its accountable person? | The `machine` run and `whoami` (`kind: machine`, `accountable_sub`) |
| After revoking at `/account/agents`: did calls stop, and did the event arrive? | The probe log (`reject: revoked`, `kind: revocation`) |
| Could it reconnect after revocation? | The client |
