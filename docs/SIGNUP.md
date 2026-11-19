# Self-serve sign-up

Sign-up is off by default. When a realm and an app enable it, a person without existing access can verify their
email and request a team workspace for the app's product. Imprim hosts sign-up and sign-in on the issuer using the
app's branding. The app starts the flow at `/authorize`.

## Settings

| Where | Setting | Values | Meaning |
|---|---|---|---|
| Realm config | `signup` | `off` (default), `approval`, `open` | Hide sign-up, hold verified requests for review, or create workspaces immediately after verification. Both enabled modes need `"workspaces": "on"`. |
| App | `self_signup` | `off` (default), `on` | Offer sign-up at a shared app that has a product and accepts email links. |

Configure the realm in its console editor or through `scripts/realm.mjs`. Set `self_signup` in the app editor or
through `scripts/seed-client.mjs`. These settings govern workspace sign-up. The app's separate `signup_policy`,
invitations and allowed domains continue to govern existing admission paths.

## Hosted sign-up

The sign-in page shows **Create an account** when sign-up is available. The person enters an email and an optional
workspace name of up to 120 characters after trimming. An empty name uses the email's local part followed by
`'s workspace`. Turnstile, when configured, and the existing IP, email and degraded-mode rate limits apply.
Addresses with existing app access or a current workspace invitation get an ordinary sign-in link with the same
neutral response.

The sign-up link verifies the mailbox. It works once, within 15 minutes, in the browser that started the request.
In `open` mode, verification creates the account and workspace and resumes authorization.

## Approval

In `approval` mode the hosted page confirms that the request is waiting for approval. The verified request grants
no session, account, workspace or app admission. A realm can have one pending request per email and product.
A repeat from any app for that product keeps the original request and sends no duplicate admin notice. Pending
requests expire 30 days after verification. Maintenance records the expired status.

Realm administrators receive a branded email with the applicant, workspace name, app and product. **Sign-up
requests** at `/admin/signups` defaults to Pending and also shows Approved, Declined and Expired. Approve and
Decline require inline confirmation in the console and fresh administrator authentication, a current second factor,
CSRF and the issuer's Origin on the API. Repeating a decision, or deciding an expired request, returns `409`.

Approval applies the current realm and app settings. Pending requests can still be approved if the realm switches
to `open`. Newly verified sign-ups then create workspaces immediately. If the applicant already owns a sign-up
workspace for the product, has since been admitted, or has a
current invitation, approval records a decline with the reason and sends no decline notice, since they can already sign in. Their
existing access is preserved. A manual
decline can record an optional reason for administrators. Decision emails use the language saved at verification.
Declines send a short notice. Approvals link to the app's `initiate_login_uri`, or to the issuer's `/login` when
the app has no URL. Set `initiate_login_uri` so applicants can start a fresh authorization from the app. Direct
issuer sign-in serves administrators.

Decision emails are attempted after the decision commits. If sending fails, the console reports delivery failure
and the audit records `signup_email_failed`. The decision remains in effect.

## What sign-up creates

A single guarded write creates or verifies the user, preserves any imported subject, and creates a version-1 team
workspace with `created_via='signup'`. The person becomes its owner. Imprim records `source='workspace'` admission
for the requesting app, writes `workspace-member-added` events for the product's apps, and records the
`workspace_signup` audit event with the approver as actor in approval mode. A person may own one sign-up
workspace per product, including closed workspaces they still own.

Apps with `workspace_admin` enabled can also create a team workspace and invite the first owner through
[Shared workspaces](WORKSPACES.md).

## Schema

Migration `0025_signup.sql` adds `clients.self_signup`, `workspaces.created_via` and the `signup` magic-link
purpose. Migration `0026_signup_requests.sql` stores verified requests, their language and decision details,
and enforces the pending-request limit.
