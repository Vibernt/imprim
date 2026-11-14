# imprim-client 0.5.0

Zero-dependency OIDC relying-party and resource-server client for any app of any realm. Earlier versions were
named `imprim-client`; the API is unchanged apart from the 0.3.0 changes listed in [docs/CLIENTS.md](../../docs/CLIENTS.md#client-030-changes-wire-change).

Zero-dependency native ESM OIDC client for Workers and Node 20+. `index.mjs` and `index.d.ts` are the package
entry points. Apps retain authorization, memberships, their own sessions and CSRF, and single-use browser-bound
login transactions. See [client integration](../../docs/CLIENTS.md#worker-app-using-the-client).

Use one long-lived `createClient({ issuer, clientId, redirectUri, resourcePrefixes, fetch })` instance per app
configuration to share discovery and 24-hour JWKS caching. `redirectUri` is required for `startLogin` and
`handleCallback`; verification-only clients can omit it. `resourcePrefixes`, when supplied, is an array of canonical
HTTPS resource prefixes; an empty array denies every revocation resource. Matching requires the same origin and
an exact path or path-segment prefix (not a string prefix such as `/w` matching `/wrong`). Configuration is copied
at creation. Network/key failures throw `IdentityError`; no alternate issuer or stale-key fallback is used.

## Back-channel events

Apps must expire a session minted from identity sign-in within 30 days of that sign-in; Assay uses seven days.
The issuer retains each app-session association for 30 days after creation. Block, delete, logout and merge
send human logout events only to clients with an unexpired association. A local session renewal does not extend
the association; use a new identity sign-in before creating a session beyond this limit.

Both events use ES256 signatures against the issuer's discovery JWKS. An unknown `kid` triggers one refresh,
rate-limited to once per minute per client instance. Verification requires exact issuer and scalar client-id audience,
integer `iat`/`exp`, `0 < exp - iat <= 900`, and exactly one empty event object. Expired tokens are refused at `exp`
with no expiration leeway. `clockSkewSeconds` (integer 0–60, default 60) bounds future `iat`/`nbf` acceptance only.
Neither kind accepts `nonce`. Neither verifier accepts the other token kind.

- `client.verifyLogoutToken(token, { clockSkewSeconds? })` requires `typ: logout+jwt`, event
  `http://schemas.openid.net/event/backchannel-logout`, nonempty `jti`, and `sub` or `sid` (each nonempty if present).
  Returns `{ sub, sid, jti, iat, exp }`. Identity emits `sub` always, `sid` when session-scoped, and a 120-second lifetime.
- `client.verifyRevocationToken(token, { clockSkewSeconds? })` requires `typ: JWT`, event
  `<issuer>/events/agent-revoked` (typ `secevent+jwt`), nonempty `sub`, `jti`, `grant_id`, and `resource`. The canonical resource
  must match `resourcePrefixes` when configured. Returns `{ sub, jti, grantId, resource, iat, exp }`.
  Identity emits a 300-second lifetime; the verifier's interoperability cap is 900 seconds.
- `client.verifyBackchannel(form, options?)` accepts `URLSearchParams` or `FormData`, requires exactly one string
  `logout_token` **or** `revocation_token` (rejecting duplicates, both fields, missing tokens and files), and returns
  `{ kind: 'logout' | 'revocation', claims }` with the corresponding shape above.

All three are also named exports taking client configuration plus optional `clockSkewSeconds` as their second
argument, for example `verifyRevocationToken(token, { issuer, clientId, resourcePrefixes, fetch })`. These one-shot
calls create a new client; use the instance methods for shared caches. The old `handleBackchannelLogout(request)`
and `handleAgentRevocation(request)` remain available and require a form-encoded POST. Their return shapes remain
`{ sub, sid, jti }` and `{ sub, grant_id, resource, jti }` respectively; the stricter validation applies to them too.

A single receiver URI can handle both kinds:

```js
import { createClient, IdentityError } from 'imprim-client';
const identity = createClient({
  issuer: 'https://YOUR_REALM_HOST', clientId: 'YOUR_REGISTERED_CLIENT_ID',
  resourcePrefixes: ['https://YOUR_APP_HOST/w/']
});

export async function backchannel(request, appStore) {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
      'application/x-www-form-urlencoded') return new Response(null, { status: 415 });
  let form;
  try { form = await request.formData(); }
  catch { return new Response(null, { status: 400 }); }
  let event;
  try { event = await identity.verifyBackchannel(form); }
  catch (error) {
    if (error instanceof IdentityError && ['invalid_token', 'invalid_response'].includes(error.code))
      return new Response(null, { status: 400 });
    throw error; // Dependency/configuration failures must not be acknowledged.
  }
  // App-provided durable transaction: insert jti only if unseen and apply its effect atomically.
  // logout: end sessions for sub + sid, or ALL sessions for sub if sid is absent.
  // revocation: deny exactly (sub, resource, grantId), without ending human sessions.
  // Authenticated duplicate jti: no effect, successful return. Storage failures must throw.
  await appStore.applyBackchannelOnce(event);
  return new Response(null, { status: 204 });
}

export async function agentRequest(token, resource, appStore) {
  const claims = await identity.verifyAccessToken(token, { audience: resource });
  if (await appStore.isGrantRevoked(claims.sub, claims.aud, claims.grant_id))
    throw new Error('Grant revoked');
  // Also check current membership and intersect claims.scope with the person's role on EVERY request.
  return claims;
}
```

`appStore` above is an application-owned storage interface, not SDK-provided persistence. Do not acknowledge before
its durable commit. Key replay records by trusted issuer and `jti` if accepting multiple issuers. Identity can re-sign
an outbox event later with the same `jti`; preserve replay records while retries are possible. Grant denials must
cover all unexpired tokens, and logout/denial effects must remain idempotent on retries. No storage is held by the SDK.

## Agent access and adoption

`verifyAccessToken(token, { audience, clockSkewSeconds })` requires a signed `at+jwt`, exact workspace-resource audience, nonempty
`grant_id` (added to server access tokens for 0.2.0), and at most **60 seconds** between `iat` and `exp`. It rejects
at `exp` with no positive leeway; apps must verify on every request and not cache authorization beyond expiry.
With synchronized clocks, a revoked grant loses access within one minute even if no back-channel arrives, because
refresh is refused immediately. Back-channel denial provides earlier enforcement. Human app sessions still require
logout delivery; access-token expiry does not end them.

Resource servers also use `client.protectedResourceMetadata({ resource, scopes })` and
`client.wwwAuthenticate({ resourceMetadataUrl, error? })`; `wwwAuthenticate` is a named export.

Assay must replace its vendored `src/auth/imprim-client.mjs` with the rebuilt `dist/imprim-client.mjs`, update
its version/hash check to 0.2.0 and the emitted **body** SHA-256, and route both POST fields through `verifyBackchannel`.
Touchstone must update its local/package dependency to 0.2.0 and use the same dispatcher. This repository's package
is still `private`; this task does not publish it to npm. Both apps must configure their own client ID/resource
prefixes, implement durable dedupe and the effects above, and check `(sub, aud, grant_id)` on agent requests.
Deploy the server emitting `grant_id` before switching app verification; older access tokens lacking it are refused
by 0.2.0. Wait out the previous server's token lifetime: 60 seconds on this M4 implementation, or longer if the
production issuer still emits older tokens. No compatibility fallback is provided.

`node scripts/build-client.mjs` builds the optional vendored file with version/body-hash header. Source/artifact
parity, real server tokens, negative boundaries, grant denial and expiry are smoke-tested. Local tests can additionally
check the actual Assay copy read-only:

```sh
ASSAY_IDENTITY_CLIENT_PATH=/absolute/assay/src/auth/imprim-client.mjs node --test tests/server-backchannel.test.mjs
```

Access-token `iat` and optional `nbf` permit up to 60 seconds of future clock skew by default. Pass
`clockSkewSeconds` as an integer from 0 through 60 to reduce that allowance. `exp` has zero leeway for every
skew setting; the 60-second maximum `exp - iat` is unchanged. Invalid skew settings fail as configuration errors.
