# OpenID certification

Imprim is tested against the OpenID Foundation's conformance suite, the same tests the Foundation uses to certify
OpenID providers. This page says which profiles apply, how to set up a deployment for the suite, and how to run it.

## Profiles

| Profile | Suite test plan | Notes |
|---|---|---|
| Basic OP | `oidcc-basic-certification-test-plan` | Authorization code flow. Static clients, discovery. |
| Config OP | `oidcc-config-certification-test-plan` | The discovery document and JWKS. |
| RP-Initiated Logout OP | `oidcc-rp-initiated-logout-certification-test-plan` | Signing out from an app. |
| Back-Channel Logout OP | `oidcc-backchannel-rp-initiated-logout-certification-test-plan` | Signed `logout_token` to the app. |

Dynamic OP is not in scope. It needs open client registration for web apps, which Imprim registers through the
console. Config OP needs RS256 listed for ID tokens: Imprim offers it per app (`id_token_signed_response_alg`).

Some Basic OP tests are skipped by design: the `address` and `phone` scopes (not offered), request objects and
`request_uri` (refused with `request_not_supported` and `request_uri_not_supported`, which the suite accepts) and
refresh tokens (people's app sign-ins have none).

## How the suite signs in

The suite is an OpenID Connect client written to OpenID Connect Core, so its requests leave out PKCE and, in one
test, the nonce. Its test apps therefore use **classic OpenID Connect** ([Protocol](PROTOCOL.md#authorization)),
which is off by default and allowed only for confidential apps. The suite also needs:

- `id_token_hint` at `/authorize`, with `prompt=none`;
- `POST /authorize`;
- `client_secret_post` at `/token`;
- the access token in a POST body at `/userinfo`.

Imprim supports all four for every app.

## Set up a deployment

Use a staging deployment. The setup script is offline: it writes the test apps' secrets and the test person's
password to a new private directory and prints SQL to review.

```bash
node scripts/conformance-setup.mjs --issuer https://id-staging.example --alias imprim-staging --email conformance@example.com --out ~/.imprim-conformance > conformance.sql
```

`conformance.sql` registers three apps, `oidf-basic`, `oidf-basic-2` and `oidf-post`. Each one:

- uses classic OpenID Connect;
- allows password sign-in only;
- admits only the test person;
- has its callback, sign-out and back-channel URLs on `https://www.certification.openid.net/test/a/<alias>/`.

The SQL also creates the test person, with a random password. The script runs against the `default` realm.

Review the SQL, then apply it to the deployment's database:

```bash
npx wrangler d1 execute imprim-staging --remote --config apps/server/wrangler.jsonc --env staging --file conformance.sql
```

`~/.imprim-conformance/plan.json` is the suite configuration for every plan, secrets included.
`~/.imprim-conformance/person.txt` is the test person's email and password. Keep both out of the repository.

## Run the suite

1. Sign in at [certification.openid.net](https://www.certification.openid.net/) and choose **Create a new test plan**.
2. Pick a plan from the table above. Choose these variants:
   - `server_metadata=discovery`;
   - `client_registration=static_client`;
   - for Basic OP, also `response_type=code`, `client_auth_type=client_secret_basic` and `response_mode=default`.
3. Paste `plan.json` into the JSON tab and create the plan.
4. Run each test. When a test opens Imprim's sign-in page, sign in with the test person.
5. Some tests ask for a screenshot, such as the sign-in page shown again after `prompt=login`. Upload one when asked.

A test that fails names the requirement it checks. Fix the cause and redeploy staging, then run that test again.

## Certify

Certification is self-certification. The owner does it:

1. Export each plan's results from the suite once every test passes.
2. Submit the results with a signed declaration of conformance.
3. Pay the fee.

The Foundation's [certification pages](https://openid.net/certification/) list the current steps and
[fees](https://openid.net/certification/fees/). One fee covers every OpenID Connect profile for a deployment for
a calendar year.
