# Realms

A realm is one brand on the shared identity service. Each realm has:

| Per realm | Where it lives |
|---|---|
| Issuer and host, for example `https://id.vibernt.ai` or `https://id.example.com` | `realms.issuer`, plus a custom domain route on the Worker |
| Signing keys and JWKS | `signing_keys.realm_id` (one ring, one rotation schedule, one emergency revocation per realm) |
| Users, provider identities, sessions, admissions | `users.realm_id`, `user_identities.realm_id` |
| Google and GitHub credentials, Turnstile, email sender | `realms.config`, with secrets named as Worker secrets |
| Admins | `admins(realm_id, email, role)` |
| Audit | `audit.realm_id` |

Clients (apps) belong to exactly one realm (`clients.realm_id`), and a client cannot move between realms. Apps in
the same realm get single sign-on with each other. Apps in different realms never share an account, a session, a
cookie, a key or a provider identity. The same email in two realms is two people, with two `sub` values.

The request host selects the realm before any route runs. An unknown host gets `404 unknown_realm`. Queue and cron
work, which has no request host, runs as the realm that owns the client it serves, and the key sweep runs once per
realm.

## Configuration

`realms.config` is JSON. Every field is optional. A value is either a literal string or `{"env":"NAME"}`, which
reads the Worker variable or secret `NAME` at request time. **Secret fields must be `{"env":…}`.** The validator
refuses a literal Turnstile secret or provider client secret, so no secret is ever stored in D1.

```json
{
  "email": { "from": "signin@example.com", "from_name": "Acme", "reply_to": "support@example.com" },
  "turnstile": { "site_key": "0x4AAAA…", "secret": { "env": "ACME_TURNSTILE_SECRET" } },
  "providers": {
    "google": { "client_id": "1234.apps.googleusercontent.com", "client_secret": { "env": "ACME_GOOGLE_CLIENT_SECRET" } },
    "github": { "client_id": { "env": "ACME_GITHUB_CLIENT_ID" }, "client_secret": { "env": "ACME_GITHUB_CLIENT_SECRET" } }
  }
}
```

**More providers.** Any other key under `providers` is a provider id, with a `type`:

```json
"providers": {
  "acme-sso": { "type": "oidc", "issuer": "https://sso.acme.com", "client_id": "…", "client_secret": { "env": "ACME_SSO_SECRET" },
                "name": "Acme SSO", "scopes": "openid email profile", "token_auth": "client_secret_basic", "trusted_domains": ["acme.com"] },
  "microsoft": { "type": "microsoft", "tenant": "common", "client_id": "…", "client_secret": { "env": "MS_SECRET" }, "name": "Microsoft" },
  "apple": { "type": "apple", "client_id": "com.example.web", "team_id": "TEAMID", "key_id": "KEYID", "private_key": { "env": "APPLE_PRIVATE_KEY" }, "name": "Apple" }
}
```

A client offers a provider by listing its id in `sign_in_methods`. The callback to register with the provider is
`<issuer>/login/provider/<id>/callback`.
- **Email trust:** a provider's email is a provider claim, not proof of the mailbox, unless the provider lists the
  email's domain in `trusted_domains`. Microsoft also needs a pinned tenant id for that. Only then does the
  provider's email link an existing account or satisfy `allowed_domains`.
- **Microsoft:** tokens are checked against the issuer of the token's own tenant, and a pinned `tenant` must match.
- **Apple:** the provider posts the callback cross-site (`form_post`), so its one state cookie is `SameSite=None`.
  The client secret is an ES256 JWT that Imprim signs with `private_key` (PKCS#8 PEM).

- The email sender's domain must be enabled for Cloudflare Email sending on the account.
- Each provider needs its own OAuth app per realm, so its consent screen shows that brand. Register these
  callbacks: `<issuer>/auth/github/callback` and `<issuer>/login/google/callback`.
- Turnstile's widget must list the realm's hostname.
- A realm with no Turnstile configured runs email sign-in without the challenge (the existing `off` mode). Configure
  it for production.

The `default` realm, created by migration `0009`, reads the deployment's existing names: `EMAIL_FROM`,
`TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET`. Its issuer is unset until an operator sets it.

## Admins

Admins sign in to `<issuer>/admin` with an email magic link. Their role comes from the D1 roster, never from a
committed variable.

| Role | Can |
|---|---|
| `realm` | Clients, users, sessions and audit of that realm |
| `platform` | Everything a realm admin can, plus create and edit realms, manage any realm's admin roster, and rotate or revoke the signing keys of the realm they signed in to |

Changing realm config is platform-only, because a config names Worker secrets: a realm admin must not be able to
point their realm at another brand's credentials. Every admin write needs a sign-in within ten minutes. The roster
is re-checked inside each write's transaction.

## Adding a realm

1. Create the provider OAuth apps, the Turnstile widget and the email sending domain for the brand.
2. Store each secret: `wrangler secret put ACME_GOOGLE_CLIENT_SECRET --env production`.
3. Write `realm.json`:

   ```json
   { "id": "acme", "issuer": "https://id.example.com", "display_name": "Acme",
     "config": { … as above … }, "admins": [{ "email": "ops@example.com", "role": "realm" }] }
   ```

   Generate and review the SQL: `node scripts/realm.mjs realm.json > realm.sql`. A platform admin can do the
   same through `POST /admin/api/realms` and `POST /admin/api/realms/<id>/admins`.
4. Apply it: `wrangler d1 execute <database> --remote --env production --file realm.sql`.
5. Add the host to the environment's `routes` as a custom domain, then `wrangler deploy --env production`.
6. Check `https://id.example.com/.well-known/openid-configuration`. Its `issuer` must be the new host.
7. Register the brand's apps from that realm's console (`https://id.example.com/admin`).

A realm's host can change only by updating `realms.issuer`. That changes the issuer of every token, so every app
in the realm must update its configuration in the same window.
