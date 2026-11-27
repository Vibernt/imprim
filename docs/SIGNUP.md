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

When an app's `signup_policy` is `invited` and self-serve sign-up is unavailable, sign-in and check-email pages
explain that the app is invite-only and ask the person to use the invited address or contact the person who
invited them. Check-email stays neutral about delivery. When sign-up is available, an uninvited person can
request a workspace and the sign-in page offers **Create an account**.

Realm administrators can sign up under the same admission rules as other people. A platform roster address
cannot sign up or sign in to the realm's apps, and an email-link request for it stays neutral.

The sign-up link verifies the mailbox. It works once, within 15 minutes, in the browser that started the request.
In `open` mode, verification creates the account and workspace and resumes authorization.

### Google and GitHub

The sign-up view offers Google and GitHub when the app already offers email sign-up and lists the provider among
its sign-in methods. The buttons carry the optional workspace name through the provider flow. Google hosted-domain
restrictions still apply. Agent requests and registry providers do not get sign-up buttons.

Sign-up needs proof that the person controls the mailbox. A verified Gmail address qualifies, as does a verified
Google address whose domain exactly equals Google's signed `hd` claim. GitHub and other Google addresses receive
an Imprim link at the verified address the provider returned. The OAuth round trip serves as the bot check.
Email and address limits still apply. The link works only in the original browser. Until the person redeems it,
Imprim saves the pending link and provider identity, with no account, workspace, admission or approval request.

After mailbox proof, `open` creates the workspace and links the provider identity in the same write. Direct Google
sign-up creates a Google session. A follow-up email link creates an email session. A conflicting provider link
stops the write. A person who already has an account and can sign in to the app or join a workspace continues
through ordinary sign-in. When app policy already accepts the address but a weak provider would have to create a
user, the email link proves the mailbox and completes ordinary sign-in. It links the provider and applies the
app's existing admission rules.

If Google, GitHub or a registry provider authenticates the person and the app requires an invitation, the page
says that their address isn't invited and offers **Sign in another way**. When self-serve sign-up is available,
the **No {app} account yet** page offers **Create an account**, which opens the sign-up view in the same browser.
The person starts a fresh sign-up from there. A proven platform address gets an app-branded page asking for
another address. Blocked or merged accounts and conflicting provider identities receive **Account unavailable.**
These pages create no account, admission, session or provider link.

## Approval

In `approval` mode the hosted page confirms that the request is waiting for approval. The verified request grants
no session, account, workspace or app admission. A realm can have one pending request per email and product.
A repeat from any app for that product keeps the original request and sends no duplicate admin notice. Pending
requests expire 30 days after verification. Maintenance records the expired status.

Realm administrators receive a branded email with the applicant, workspace name, app, product and sign-up method.
The console shows the method on the list and in the decision view. **Sign-up requests** at `/admin/signups` defaults to Pending and also shows Approved, Declined and Expired. Approve and
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

Approval links the provider identity saved on a verified request. If another account already owns the identity
at approval time, Imprim creates the workspace without linking it and records `provider_link_skipped: true` in
the `workspace_signup` audit detail.

Decision emails are attempted after the decision commits. If sending fails, the console reports delivery failure
and the audit records `signup_email_failed`. The decision remains in effect.

## What sign-up creates

A single guarded write creates or verifies the user, preserves any imported subject, and creates a version-1 team
workspace with `created_via='signup'`. The person becomes its owner. Imprim records `source='workspace'` admission
for the requesting app, writes `workspace-member-added` events for the product's apps, and records the
`workspace_signup` audit event with the approver as actor in approval mode. A person may own one sign-up
workspace per product, including closed workspaces they still own.

An app with `join_workspaces='on'` can offer its product to a sign-up workspace's owner during [hosted sign-in](WORKSPACES.md#adding-a-product-to-an-existing-workspace).

Apps with `workspace_admin` enabled can also create a team workspace and invite the first owner through
[Shared workspaces](WORKSPACES.md).

## Schema

Migration `0025_signup.sql` adds `clients.self_signup`, `workspaces.created_via` and the `signup` magic-link
purpose. Migration `0026_signup_requests.sql` stores verified requests, their language and decision details,
and enforces the pending-request limit.

Migration `0034_provider_signup.sql` adds the OAuth purpose and workspace name, and stores pending Google or
GitHub identity metadata on links and verified requests.
