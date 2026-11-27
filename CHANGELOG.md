# Changelog

Each release lists the migrations it needs. Apply them in order, then deploy, as [Deploying](docs/DEPLOY.md)
describes. The client package's own changes are in [Clients](docs/CLIENTS.md).

## 2026-11-27.3

No migration.

- **Realm administrators can use their realm's apps.** Only a `platform` administrator's address is kept out of app
  sign-in, admission and self-serve sign-up, because a platform administrator can change every realm's roster and
  keys. A `realm` administrator signs in to that realm's apps like anyone else, under the app's own admission rules;
  the console still needs its own administrator sign-in and second factor. A platform address that proves control
  (a clicked link, a password, a passkey, Google, GitHub or a registry provider) sees "This address manages {realm},
  so it can't sign in to apps. Use another address." An email-link request stays neutral and sends nothing.
- **Invite-only apps say so.** Where an app admits by invitation and self-serve sign-up is not available, the sign-in
  and check-email pages say "{app} is invite-only for now. Use the address you were invited with, or ask the person
  who invited you." and "Create an account" is not offered. A Google, GitHub or registry sign-in that is refused
  says why: not invited (the "No {app} account yet" page where sign-up is available), an administrator address, or
  account unavailable.
- **Refused sign-ins leave a trace.** Every refused sign-in and every email-link request that sends no link logs one
  `sign_in_refused` line with a reason (`not_invited`, `admin_address`, `account_unavailable`, `invalid_credentials`,
  `rate_limited`, `turnstile_failed`, `link_skipped`), the method, app and realm, and a masked address with its
  SHA-256 hash. Those past rate limiting and Turnstile also write a `sign_in_refused` audit row, shown in the
  console's Audit log as "Sign-in refused".
- **Operator commands.** `scripts/operator.mjs` writes reviewable SQL, with the same audit rows the app writes, to
  invite or uninvite an address for an app, add or remove a realm administrator, and set an app's sign-up policy
  (`--version` of the reviewed client). Adding a platform administrator whose address already uses an app in that
  realm fails unless `--allow-app-user` is given; `scripts/realm.mjs` does the same check.

## 2026-11-27.2

No migration. The account and console screens only; no server or API change.

- **Fire v0.14.0.** Its new row confirmation (`fd-confirm-row`) asks inside the item's own row before something
  that cannot be taken back: removing your last second factor, new recovery codes, revoking an agent, disabling a
  machine client, deleting a service client, revoking a signing key, removing a realm administrator. Machine
  clients, service clients and signing keys still ask you to type their id. `docs/fire`: AGENT-RULES, GUIDE,
  WRITING, CLASSES and VOCABULARY from the tag.
- **Actions you can take back wait 5 seconds with Undo** before anything is sent: signing out a session or an app,
  forgetting a browser, removing one of several second factors, removing a workspace member, revoking an
  invitation, removing a product. Leaving the page sends them at once, and they still arrive. Row actions are
  menus.
- **Sign-up requests** are a queue: one request open at a time, with what it changes, who it touches and the
  evidence. **Create workspace** and **Decline** wait 10 seconds with Undo; leaving the page sends nothing. You no
  longer type the email. Other statuses are a read-only table.
- **User detail** and **Workspace detail** in the console show status and an actions menu in the page head, with
  details in a side panel.
- **Loading** shows the shape of each screen under its title, and the first load shows the app's outline instead
  of a blank page.
- **The account area** uses one list style on Security, Sessions and Agents; empty states sit in their cards;
  controls that are off say why. "Two-step verification" is the one name, and page titles match the menu.
- A skip link on every account and console page, tabs and a side preview on Branding, and date fields in the audit
  filter.

## 2026-11-27.1

No migration.

- **Workspaces in the account.** Where a realm has shared workspaces on, someone who belongs to an active workspace
  sees **Workspaces** in their account (after Apps; on a phone, the tab bar is Apps, Workspaces, Agents, Security and
  More). The list shows each workspace's kind, the person's role, member count and apps. A workspace's page shows its
  members, and for admins and owners its open invitations (re-send, revoke), an invite form, role changes and
  removal, each confirmed on the page. Owners rename it; any member can leave it, except the last owner. Apps are
  shown, not changed, and a workspace cannot be closed here. Personal workspaces show only their owner and apps.
- **The account workspace API**, `/v1/account/workspaces`, with the session, the CSRF token and the issuer's
  Origin. It uses the same guarded writes as apps and the console, so the same role rules, events and access teardown
  apply, and it audits with `source: "account"`. A realm administrator has only their member role here. A
  workspace the person does not belong to is not found.
- **Invitation links never lead to the administrator sign-in.** An invitation from the account or the console links
  to the sign-in address of one of the workspace's apps: the one the inviter signed in to most recently, otherwise
  the first by name. An app's invitation links to that app. **When no such app has a sign-in address
  (`initiate_login_uri`), the invitation is refused with `409 no_sign_in_address`**, including from
  `POST /v1/workspaces/{id}/invitations` for an app with no address; give each app its sign-in address.
- Apps can link to `/account/workspaces/{id}` from their own team screens ([Integrating](docs/INTEGRATE.md)).

## 2026-11-27

Migration: `0034_provider_signup.sql` (the purpose and workspace name of a provider start, and the provider account
waiting on a sign-up link or request).

- **Sign up with Google or GitHub.** When an app offers self-serve sign-up and lists Google or GitHub among its
  sign-in methods, **Create an account** shows **Sign up with Google** and **Sign up with GitHub** beside the email
  form, carrying the optional workspace name (`POST /v1/auth/google/signup`, `POST /v1/auth/github/signup`, with the
  issuer's Origin and the original browser).
- **The email is proven first.** A Gmail address, or one whose domain is Google's hosted domain, finishes sign-up at
  once. GitHub and other Google addresses get a sign-up link by email; nothing is created until it is opened in the
  same browser. The provider account is linked in the same write that creates the account and workspace, or when an
  administrator approves the request (skipped, and recorded, if someone else has linked it meanwhile). Sign-up
  requests and their notification show how the person signed up.
- **No account yet.** Someone who signs in with Google or GitHub on an app they have no access to, where sign-up is
  open to them, sees "No {app} account yet" with **Create an account** (`/login?request_id=…&view=signup`) and
  **Sign in another way**, instead of "Account unavailable". Nothing is written. Where sign-up is unavailable, and
  for blocked or merged accounts, the refusal is unchanged.
- **Fire v0.13.2.** Loading placeholders are easier to see and wait 160 ms before they show, so a fast load does not
  flash one. Opening a dialog no longer shifts a page that has no scroll bar. No Imprim markup or script changes.
- `docs/fire`: AGENT-RULES, GUIDE and CLASSES from the tag. Agent instructions now ask every screen to
  name the Fire reference screen it follows; a Fire proposal is written with `fire propose` and shown to the
  maintainer, who decides whether it is filed publicly.

## 2026-11-26.4

Migrations: `0031_hosted_app_access.sql` (an app's `listed` setting, the workspace-access step),
`0032_account_activity.sql` (each app's last sign-in per person) and `0033_client_drafts.sql` (client drafts).

A design release: every screen was reviewed against Fire at phone and desktop width, light and dark, in English and
German, and the findings were fixed.

- **Your apps.** Pages that end or stop a sign-in list the person's own apps (those they can open now) as rows with
  the app's mark and an optional one-line description (`branding.summary`, translatable). Signed out, they list only
  apps marked **Show to everyone** (`listed`, on by default). With exactly one app, "You're signed in" and an expired
  sign-in go straight to it (never for administrators, never after signing out).
- **Account › Apps** shows the person's apps as cards that open them. Sessions › Apps adds Open beside Sign out.
- **Workspace members.** A member refused by a shared app because their team has not added its product sees
  `/workspace-access`, which says whom to ask, then returns the usual `access_denied`.
- **Which account.** Second factor, agent consent, workspace pages and device codes show "Signed in as …" with
  **Not you?** (`POST /switch-account`), which signs out and restarts the same sign-in.
- **Sign-in pages** keep the app's branding through every step (check email, set password, second factor, consent and
  their results); provider buttons carry Google's, GitHub's, Microsoft's and Apple's marks (see NOTICE); sign-in,
  passkey and second-factor errors appear as a notice; the consent page's phishing warning is one line above the
  buttons, permissions lead with their names, and decision buttons fill the width on phones.
- **Account › Agents** shows active connections as compact rows (app, workspace by name, where approved, last used)
  with a menu for Rename and Revoke and the details folded under each; ended connections are folded away with the
  reason. Times are local. Profile and Security are reorganised; unknown account and console addresses show "Page not
  found".
- **Console.** Its own tab bar on phones and tables that stack; readable user records and audit events with event
  type and time filters; Register client asks only for the essentials and keeps a draft until a back-channel URL is
  set; workspace and agent settings show only when they apply; Settings is now Configuration; one Save bar on Branding.
- Fixes found by the review: a client saved in the console no longer comes back with an empty scope list in the
  form; an open audit filter no longer closes when the list reloads; a failed client save no longer covers the Save
  button.

## 2026-11-26.3

No migration. Documentation only.

- Integrating: one resource for every workspace, readable resource names, and workspace machine clients for
  unattended workers; consent lets people leave scopes out.
- Security: the live checks of release 2026.11.26.2 on staging (workspace choice, resource names, machine clients).
- Shared workspaces: the status line names migration `0030`.

## 2026-11-26.2

Migrations: `0029_agent_workspace_choice.sql` and `0030_workspace_machine_clients.sql`. Client 0.12.0.

- A shared-workspace app can publish one agent resource URL for its product. The person chooses a workspace at
  consent, and the grant and its access tokens carry `workspace_id`. Losing access to that workspace revokes the
  grant. Apps can filter their grant list by workspace.
- Registered workspace resources can have a readable name. Consent and Connected agents show the name and the URL.
- Shared apps can request an unattended machine identity for one workspace. An owner or admin reviews the resources,
  scopes and public keys on Imprim and stays accountable for the machine. Workspace machine tokens include
  `workspace_id` and `accountable_sub`. Account › Agents lets the approver renew or disable it.
- MCP probe: an optional product-wide `/mcp` endpoint with the workspace chosen at consent (and, with `APP_SECRET`,
  a current-membership check), `name` to register a resource with a readable name, and `machine` to request, approve
  and use a workspace machine client. `setup.mjs --product` makes a shared-workspace probe client.

## 2026-11-26.1

Migration: `0028_agent_grant_labels.sql` (grant labels, where each grant was approved, the revocation reason).

- **Choosing permissions.** The agent consent page lists each permission with a checkbox, all ticked; the person can
  untick any. The grant, the token response's `scope` and every access token carry only what was approved, and
  refresh can still only narrow it. Device-code approvals work the same way.
- **Telling connections apart.** Account › Agents shows where each connection was approved (browser, system and
  place) and lets the person name it (`POST /v1/account/agents/label`, shown only to them).
- **Replacing a connection.** When a person approves an agent that already has a live connection to the same
  resource, the consent page offers to replace it (the default) or keep both. Permissions the old connection had are
  offered again, marked "Already allowed". Replacing ends the old grant in the same transaction and sends the app a
  revocation event (reason `agent_replaced`). A device-code approval never replaces or inherits anything: anyone can
  start one with a public agent's id.
- The signed-out account page no longer points customers at the administrators' sign-in.
- Server-rendered checkboxes include Fire's tick mark, since those pages load no Fire JavaScript.
- MCP probe: `check --flow loopback` signs in the way a desktop agent does, through a one-time listener on
  `127.0.0.1`; the invitation check expects `201`.

## 2026-11-26

No migration.

- Every page that says to sign in or start again now links to it ([next steps](docs/PROTOCOL.md#next-steps-on-pages-that-stop)).
  A sign-in that stops (an expired session on the join, consent or second-factor step; an app that asked for a fresh
  or recent sign-in, or for another person) offers **Sign in again**, back to the same app's sign-in page, in the
  browser that started it. Elsewhere the page links to the app's `initiate_login_uri`, or, with no app in view
  (`/error`, `/signed-out`, the signed-out account page, the administrators' `/login`), to the realm's apps that have
  one. Before, these pages said "Go back to the app and start again." with no link.
- An app's email link is `/login?request_id=…#token=…`: an expired or used link shows the app's sign-in form again,
  one step from a new link. Before, the page kept only a Sign in button that failed again.
- A refused consent, second-factor or set-password form answers a page in the browser, not JSON.
- A wrong or expired device code leads back to the code form. The hosted workspace choice with nothing to choose says
  "Back to {app}" instead of "Not now".
- Set `initiate_login_uri` on every app people sign in to: without it Imprim has no app address to offer. A failed
  lookup of the apps leaves a page as it was.

## 2026-11-24.2

No migration.

- Fire v0.12.4. A person's reduced-motion setting now wins over a brand's motion dial: a brand saved with slow motion
  no longer brings transitions back for someone who asked the system for less motion. On the Branding page, the
  Tweaks panel's motion control has no visible effect for an administrator with reduced motion on; the saved dial
  still applies to everyone else.
- `docs/fire`: CLASSES from the tag.

## 2026-11-24.1

No migration.

- The account area shows an administrator the admin pages only when their session can open them: an administrator
  sign-in and a second factor, both within the hour. Before that, the menu offers one "Open admin console" entry,
  which goes through the sign-in or second-factor step. `GET /v1/me` reports `admin_ready`, from the same check the
  console enforces.

## 2026-11-24

No migration.

- Fire v0.12.3. A classic script now ends every page's `<head>`, after every stylesheet, so Chromium no longer paints
  buttons link blue for a moment when you move between pages: server pages end with `/imprim/head.js`, and the console
  puts Fire's `boot.js` after its stylesheet and the brand's `theme.css`.
- `docs/fire`: AGENT-RULES, GUIDE, WRITING, CLASSES and VOCABULARY from the tag.

## 2026-11-20.6

No migration.

- Fire v0.12.1. Its styles and behaviour are those of 0.10.2. The rules, guide and class reference in `docs/fire` are
  updated: templates are references to read, never starters, and a component Fire lacks is built to Fire's standard
  and proposed internally in `docs/fire/REQUESTS.md`, never publicly.

## 2026-11-20.5

No migration.

- Fire v0.10.2. Its lint and review now refuse a field inside a settings row and a text field wider than a form;
  Imprim already passed both. The rules, guide and class reference in `docs/fire` are updated.

## 2026-11-20.4

No migration. Client 0.11.0.

- `startLogin({ profile: true })` asks for the `profile` scope, so the ID token carries `name` when one is set.
- `POST /v1/workspaces/{id}/close` takes `release_own_hold: true` (client `closeWorkspace(id, { releaseOwnHold: true })`):
  the calling app's own hold stops blocking and is deleted in the same write, only if the close commits. Other apps'
  holds still block, and a refused close leaves the hold in place.

## 2026-11-20.3

No migration.

- Layout: a value you type (Profile name, language and email; passkey name; admin merge, workspace name, products and
  invitation) is now a field with its button beside the input, in a form that stops at a readable width. Before, the
  input sat inside a settings row, stretched across the card and left the button aligned with the description.

## 2026-11-20.2

No migration.

- Confidential apps can read an admitted person's current profile with `GET /v1/users?sub=<sub>` or
  `user(sub)` in `imprim-client` 0.10.0 after receiving a value-free `user-updated` event.

## 2026-11-20.1

No migration.

- `POST /v1/workspaces/{id}/products` treats an omitted `add` or `remove` as an empty list, and client 0.9.1 sends
  both. Before, `setWorkspaceProducts(id, { add, actorToken })` without `remove` failed with `400 invalid_request`.
- Docs: the README, integration guide, roadmap and architecture describe sign-up approval, joining an existing
  workspace and the realm-admin close.

## 2026-11-20

Migration `0027`.

- `POST /v1/workspaces/joinable` and client 0.9.0 let an app show workspace owners where they can
  [add the app's product](docs/WORKSPACES.md#adding-a-product-to-an-existing-workspace).
- An app with workspace administration enabled can close a workspace on behalf of a realm admin by confirming
  its current name. Client 0.9.0 accepts `confirm` in `closeWorkspace`.
- Shared apps can enable `join_workspaces` to let a team workspace owner add the app's product during
  [hosted sign-in](docs/WORKSPACES.md#adding-a-product-to-an-existing-workspace).

## 2026-11-19.3

No migration.

- Workspace reads (`GET /v1/workspaces/{id}`, `GET /v1/memberships`, create responses) include `created_via`:
  `"signup"` for a self-serve sign-up workspace, otherwise `null`. Client 0.8.3 adds the type.

## 2026-11-19.2

Migrations `0025` and `0026`.

- Optional [self-serve sign-up](docs/SIGNUP.md) lets a person prove their email on Imprim's hosted pages and
  create a team workspace they own. Each participating app receives the usual workspace membership event.
- Realms can require administrator approval after email verification. The Sign-up requests console records approvals,
  declines and expired requests. The realm's immediate sign-up mode is `open`.

## 2026-11-19.1

No migration.

- Fire v0.10.1: its fieldset reset and `focusQuiet` replace Imprim's two stopgaps; its agent rules and class
  reference are in `docs/fire`.
- Every account and admin screen follows one Fire page template ([Interface](docs/WEB.md#layout)): one compact page
  head, lists as a table with row actions, forms in one column, detail screens as stacked cards.
- Fixed: the page title no longer shows a focus ring after navigating; callouts carry their icon; a screen that shows
  a code block no longer stops updating after an action (Fire's code block rewrites its text, so the block is
  re-created when the value changes).
- `fire review` gates the app: every screen at 1440 and 375, light and dark, with Fire's structural and composition
  rules, in `npm --prefix apps/web run check`.

## 2026-11-19

No migration.

- Pinned Fire 0.9.1 from its public repository, shipping its LICENSE and NOTICE; filed the fieldset reset with Fire.
- Built the account area and admin console as a Lit app using `GET /v1/me`, `GET /v1/i18n/<locale>.json`, `/v1/account/*` and `/admin/api/*` JSON APIs.
- Kept the account sign-in message on signed-out `/account`.
- Added a build step and the `ASSETS` binding for deploys ([Deploying](docs/DEPLOY.md)).
- Translated Fire interface labels and checked icons.

## 2026-11-18

Migration `0024`.

- Added opt-in [shared and personal workspaces](docs/WORKSPACES.md), with base roles, invitations in five languages
  and signed workspace events. Client `0.8.0` adds the workspace API and event verification.
- Limited each app to managing its own product through the app API.
- Made resource registration idempotent: the same app registering a resource to the same workspace gets `200` with no change.
- Let an app with `workspace_admin` invite an owner, revoke invitations and close a team workspace with no members
  when the workspace uses its product.
- Client `0.8.1` lets `handleCallback` return the verified ID token for `actor_token`.
- Client `0.8.2` refuses redirects on every request with `redirect: 'manual'`; `0.8.1` used `redirect: 'error'` for
  workspace calls, which Cloudflare Workers reject.
- Made `apps/server/wrangler.jsonc` a template with placeholder hosts and ids. Keep deployment values in the ignored
  `wrangler.local.jsonc` and pass `--config wrangler.local.jsonc` to every `wrangler` command ([Deploying](docs/DEPLOY.md)).
- Changed tests and examples to use `example.com` hosts.
- A test that revoking one of an agent's two grants leaves the other working, and that the event names only the
  revoked grant.
- [Integrating](docs/INTEGRATE.md): why a missed revocation is still safe, how an app catches up with the grants API,
  and how agents choose scopes (Claude Code pins them with `oauth.scopes`).
- Claude Code was verified live against a production MCP server: read-only consent, refresh, and revocation delivered
  to the app in 7 seconds.

## 2026-11-17

Migrations `0020`–`0023`.

- **Agents at scale:**
  - token budgets that suit hosted agents behind shared addresses (`AGENT_LIMITER`, a budget per grant, and a
    per-app `agent_token_rate`);
  - paging and a `sub` filter on the grants API;
  - `agent_assurance` on tokens, introspection and the grant list;
  - registrations kept while a grant is live;
  - client `0.7.0` with `listGrants`, `revokeGrant` and `introspect`.
- **Languages:** pages and emails in English, Spanish, French, German and Portuguese (Brazil), and a branded HTML
  part, light and dark, beside the plain text of every email.
- **OpenID conformance:**
  - classic OpenID Connect per app, `id_token_hint`, `POST /authorize`, `client_secret_post`, UserInfo body tokens
    and RS256 ID tokens per app;
  - the fixes the suite found;
  - no failures in the Basic, Config, RP-Initiated Logout and Back-Channel Logout profiles
    ([OpenID certification](docs/CERTIFICATION.md)).

## 2026-11-15

Migrations up to `0019`.

- The security pass, with client `0.3.0` ([Security pass](docs/SECURITY_PASS.md)).
- Realms: many brands, one deployment.
- Passwords, two-factor and step-up, the account pages and passkeys.
- The provider registry.
- Machines: service clients, introspection, revocation, DPoP and token exchange.
- User lifecycle events.
- Branding as a Fire look, and every page rebuilt with the Fire design system.
