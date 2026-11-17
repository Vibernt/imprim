# Integrating an app and connecting agents

Imprim proves who a person is. Your app keeps its own session and CSRF protections, and checks permissions on
every request. It keeps workspaces, memberships and roles by default. The `sub` claim is the stable person id within one realm. Key your local user
record on `(issuer, sub)`, never on email.

## 1. Register the app

A realm admin registers the client in `<issuer>/admin` (or with `scripts/seed-client.mjs`):

| Setting | Choose |
|---|---|
| `redirect_uris` | Exact HTTPS callback URLs. `dev=1` allows exact `http://localhost` ones for development. |
| `post_logout_uris` | Exact URLs you return to after sign-out. |
| `backchannel_uri` | Required. Receives `logout_token`, `revocation_token` and (with `user_events: on`) `event_token` POSTs. |
| `sign_in_methods` | Ordered list from `email`, `password`, `passkey`, `github`, `google` and the realm's provider ids (such as `microsoft`). Refused at the server, not only hidden. |
| `signup_policy` | `invited` (default) or `open`. Under `invited`, admit people with `POST /v1/invitations` or `allowed_domains`. |
| `branding` | Name, Fire look, logos, copy and links for this app's pages and emails, over the realm's defaults ([Branding](BRANDING.md)). |
| `mfa` | `off` (default), `optional` or `required` second factor for this app. |

A confidential client gets its secret once, at creation. Store it as a secret in your app.

### Opt in to shared workspaces

1. Ask the realm admin to set the realm's `workspaces` to `on`, and the app's `workspaces` to `shared` with a
   `product` such as `notes`. Apps for the same product use the same product name.
2. Register the app's back-channel URL and set `initiate_login_uri` to its sign-in page for invitation emails.
   Enable `personal_workspaces` for personal workspace creation and `workspace_admin` when the app needs team
   creation or product management.
3. Use client 0.8.0 on the server to read memberships and manage workspaces. For actions on a person's behalf,
   pass the ID token issued to the app as `actorToken`. Keep app-specific permissions and check them on each request.
4. Verify `workspace_token` on the back channel. Deduplicate `jti`, apply newer versions and use `workspaceMembers`
   to catch up. [Shared workspace specification](WORKSPACES.md)

## 2. Sign people in

```js
import { createClient, IdentityError } from 'imprim-client';
const identity = createClient({ issuer: 'https://id.example.com', clientId: 'my-app',
  clientSecret: env.IDENTITY_CLIENT_SECRET, redirectUri: 'https://app.example.com/auth/callback' });

// Start: keep state, nonce and codeVerifier in a short-lived, HttpOnly, SameSite=Lax cookie of your own.
const login = await identity.startLogin();          // { url, state, nonce, codeVerifier }
// Callback: exchange, verify the ID token (ES256, iss, aud, nonce, exp), then mint YOUR session.
const claims = await identity.handleCallback(request.url, login);   // { sub, email, email_verified, amr, auth_time, sid, … }
```

- `error=access_denied` at your callback means this app has not admitted the person (`IdentityError.code`). Show
  your own "no access" page. `error.description` is untrusted text: escape it.
- `prompt: 'none'` checks for an identity session without any UI: `login_required` means show your sign-in button.
- `email` is in the ID token only with the `email` scope, which `startLogin` requests. Treat it as contact data,
  not identity. `email_verified=false` means only a provider vouched for it.
- Sensitive action? Start a new login with `acr_values: 'urn:imprim:acr:mfa'` (and `max_age`) and require
  `claims.acr === 'urn:imprim:acr:mfa'` before you proceed.
- Sign-out: send the person to `await identity.logoutUrl({ idTokenHint, postLogoutRedirectUri, state })`.

## 3. Receive back-channel events

Imprim POSTs signed events to `backchannel_uri` when someone signs out, is blocked, deleted or merged
(`logout_token`), when an agent grant is revoked (`revocation_token`), and, if the app sets `user_events: on`,
when a person's account changes (`event_token`). Verify each with `identity.verifyBackchannel(form)`. Store its `jti` and apply its effect in one transaction, then return 2xx. The
[package README](https://github.com/Vibernt/imprim/blob/main/packages/imprim-client/README.md) has a complete handler. Delivery is at least once and is
retried for 24 hours.

If your app was down or missed an agent revocation, it is still safe: the agent's refresh stopped the moment the
person revoked, and its access token expires within 60 seconds. To catch up after an outage, list the live grants
with `GET /v1/grants` (or `listGrants`) and drop any you hold that are not in it, or introspect a token you are
unsure of. Revocation is final, so events cannot arrive in a harmful order: a revoked `grant_id` never becomes live
again, and a person who reconnects gets a new one. An event names one grant, so revoking one of an agent's grants
leaves its others working.

## 4. Accept agents on your MCP server

1. Ask a realm admin to set the client's agent policy: `agent_access: "on"`; `agent_resource_prefixes`, for
   example `["https://app.example.com/w/"]`; and `agent_scope_catalogue` (`{"mcp.read": "Read your workspace"}`).
   Optionally set `agent_allowlist` and `agent_max_grant_days`.
2. Serve Protected Resource Metadata and answer unauthenticated calls with the challenge:

   ```js
   // GET /.well-known/oauth-protected-resource/w/<id>/mcp
   return Response.json(identity.protectedResourceMetadata({ resource, scopes: ['mcp.read', 'mcp.write'] }));
   // Any MCP request without a valid token:
   return new Response(null, { status: 401, headers: { 'www-authenticate': wwwAuthenticate({ resourceMetadataUrl }) } });
   ```

3. On every request:

   ```js
   const claims = await identity.verifyAccessToken(bearer, { audience: resource });  // 60-second at+jwt
   // Refuse if (claims.sub, claims.aud, claims.grant_id) was revoked by a back-channel event.
   // Look up the person's CURRENT membership in this workspace and intersect claims.scope with their role.
   // For dangerous actions, require a recent approval: claims.grant_issued_at (seconds) never moves on refresh.
   ```

The resource must name exactly one workspace and be in canonical form (no trailing slash, no needless
percent-encoding). The token's audience is that exact string.

Agents usually ask for every scope in your metadata's `scopes_supported`. Claude Code does unless its `.mcp.json`
pins the server's scopes, for example `"oauth": { "scopes": "read-only" }`, and the consent page shows the person
exactly what was asked for. List your least powerful scope first and describe each one plainly in the catalogue, and
check the person's role on every call whatever the token says.

## 5. Build an agent that connects

An agent connects for a person, never as one. Give it only the app's MCP address.

1. Call the MCP address and read `resource_metadata` from the 401 challenge. Fetch it, then fetch the
   authorization server metadata at `<issuer>/.well-known/oauth-authorization-server`.
2. Identify yourself with a **client ID metadata document**: an HTTPS URL on port 443 that serves JSON with
   `client_id` (its own URL), `client_name`, `redirect_uris` and `grant_types`. **Declare
   `urn:ietf:params:oauth:grant-type:device_code` if you use device flow**; it is never a default.
3. **Recommended:** publish keys (`token_endpoint_auth_method: "private_key_jwt"` and `jwks_uri` on the same host)
   and send a fresh signed `client_assertion` with every token and device request. People then see your host as
   verified, and nobody else can redeem codes or start device flows under your name. Without keys, loopback and
   device consents say "Agent calling itself …, claimed, not verified".
4. Browser flow: `/authorize` with PKCE S256, `state`, exactly one `resource` and scopes from the catalogue. Then
   exchange the code at `/token` with the same `resource`.
5. Headless: `POST /device_authorization`, show `user_code` and `verification_uri`, then poll `/token` at the
   given interval and add 5 seconds on `slow_down`.
6. Refresh before the 60-second access token expires. Store the new refresh token atomically: every refresh
   rotates it. If a response is lost, retry the same token within 10 seconds. After that, a spent token revokes
   the whole grant, and the person must approve again.
7. People see and revoke connected agents at `<issuer>/account/agents`.

Tools that run without a person (CI, scheduled jobs) use a **service client**. A realm admin registers its public
key, app, scopes and resource prefixes. The tool then signs a `private_key_jwt` assertion and calls
`/token grant_type=client_credentials`. Your MCP server sees `sub: "service:<id>"` and authorises it like any caller.

Resource servers that can't verify JWTs locally, or that want revocation to take effect at once, call `POST /introspect`
with the app's credentials. A workspace admin screen in your app can list and revoke connected agents through
`GET /v1/grants?resource=…` (paged, filterable by person) and `POST /v1/grants/revoke`, or through
`imprim-client` 0.7.0's `listGrants`, `revokeGrant` and `introspect`. Agent tokens carry `agent_assurance`, how sure
Imprim is about who the agent is, if your app wants to trust verified agents more.

[`examples/mcp-probe`](https://github.com/Vibernt/imprim/tree/main/examples/mcp-probe) is a complete MCP server that
does all of the above, with a scripted agent that tests it end to end.
