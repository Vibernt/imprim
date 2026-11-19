# Shared workspaces

Status: built (migration `0024`, client `0.8.2`). This page is the specification; the code matches it.

By default each app keeps its own workspaces, memberships and roles, and Imprim only admits people per app. A realm
can instead hold **shared workspaces** for a family of products. Imprim then keeps each workspace's members, base
roles, invitations and products, and every product that opts in reads them. An invitation from any product counts
for all the products the workspace uses. Products keep everything product-specific, including finer roles.

## Concepts

- **Realm switch.** A realm's config sets `"workspaces": "on"`. Without it, the workspace API answers 404 and nothing
  below applies.
- **Product.** A short name (`^[a-z][a-z0-9-]{1,39}$`) set on each participating app (`clients.product`). A product
  can have several apps, for example a web app and an operator console. A workspace uses products, not apps.
  Through the app API an app manages only its own product; other products join through their own apps or the console.
- **Participation.** `clients.workspaces` is `app` (the default, today's behaviour) or `shared`. Only `shared` apps
  with a `product` use anything on this page.
- **Workspace.** `id` is `ws_` plus 32 lowercase hex characters, permanent and never reused. An import may keep an
  existing product id if it matches `^[A-Za-z0-9_-]{1,64}$` and is unused. `kind` is `team` or `personal`. `status`
  is `active` or `closed`; closing never deletes the row.
- **Base roles:** `owner`, `admin`, `member`, `viewer`, in that order of power. A team workspace keeps at least one
  owner once its first owner joins. Only an owner can grant or remove a member's `owner` role. A personal workspace
  has exactly one member, its owner, and takes no invitations.
- **Version.** Every workspace has an integer `version`, raised by one in the same batch as every change to its
  name, members, roles, products or status. Each event carries the version after the change.

## Schema (migration `0024_workspaces.sql`)

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, realm_id TEXT NOT NULL REFERENCES realms(id),
  kind TEXT NOT NULL CHECK(kind IN ('team','personal')), name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed')),
  personal_owner TEXT UNIQUE REFERENCES users(id),           -- set only for kind='personal': one per person
  version INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL, closed_at INTEGER,
  CHECK((kind='personal') = (personal_owner IS NOT NULL))
);
CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('owner','admin','member','viewer')), created INTEGER NOT NULL, updated INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, user_id)
);
CREATE INDEX workspace_members_user ON workspace_members(user_id);
CREATE TABLE workspace_products (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id), product TEXT NOT NULL, created INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, product)
);
CREATE INDEX workspace_products_product ON workspace_products(product);
CREATE TABLE workspace_invitations (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','member','viewer')), invited_by TEXT REFERENCES users(id),
  via_client TEXT, created INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  accepted_at INTEGER, accepted_by TEXT REFERENCES users(id), revoked_at INTEGER
);
CREATE UNIQUE INDEX workspace_invitations_open ON workspace_invitations(workspace_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX workspace_invitations_email ON workspace_invitations(email);
CREATE TABLE workspace_resources (                              -- agent resource URLs a product registered
  resource TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), client_id TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE INDEX workspace_resources_workspace ON workspace_resources(workspace_id);
CREATE TABLE workspace_holds (                                  -- a product refusing a close, e.g. an unpaid balance
  workspace_id TEXT NOT NULL REFERENCES workspaces(id), client_id TEXT NOT NULL, reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 200),
  created INTEGER NOT NULL, PRIMARY KEY(workspace_id, client_id)
);
CREATE TABLE workspace_event_outbox (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, workspace_id TEXT NOT NULL, user_id TEXT,
  event TEXT NOT NULL CHECK(event IN ('workspace-member-added','workspace-member-removed','workspace-role-changed',
    'workspace-updated','workspace-products-changed','workspace-closed')),
  payload TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload)), version INTEGER NOT NULL, uri TEXT, created INTEGER NOT NULL,
  queued_at INTEGER, delivered_at INTEGER, delivery_state TEXT NOT NULL DEFAULT 'pending', last_error TEXT
);
-- the same three indexes user_event_outbox has: pending, retention, expiry
ALTER TABLE clients ADD COLUMN product TEXT CHECK(product IS NULL OR (length(product) BETWEEN 2 AND 40));
ALTER TABLE clients ADD COLUMN workspaces TEXT NOT NULL DEFAULT 'app' CHECK(workspaces IN ('app','shared'));
ALTER TABLE clients ADD COLUMN personal_workspaces TEXT NOT NULL DEFAULT 'off' CHECK(personal_workspaces IN ('off','on'));
ALTER TABLE clients ADD COLUMN workspace_admin TEXT NOT NULL DEFAULT 'off' CHECK(workspace_admin IN ('off','on'));
ALTER TABLE clients ADD COLUMN initiate_login_uri TEXT;      -- the product's own sign-in page, linked from invitations
ALTER TABLE client_admissions ADD COLUMN source TEXT NOT NULL DEFAULT 'app' CHECK(source IN ('app','workspace'));
```

## Proving who is acting (`actor_token`)

Every call that changes a workspace on a person's behalf carries `actor_token`: an ID token Imprim issued to the
calling app for that person. Imprim verifies it as `ownIdToken` does (`oidc/logout-hint.mjs`): its own signature, `aud`
equal to the calling client, and a `sid` naming a session that is still live in `sessions` for that `sub`, whose user
is active. An expired ID token is accepted while its session lives; a signed-out session is refused. The acting
person's role is then read from `workspace_members`, never taken from the app. Calls without a person (holds,
resources, reads) use the app's credentials alone.

## App API

All calls authenticate the app with its client credentials (Basic or `client_secret_post`), are limited by
`API_LIMITER` like `/v1/grants`, and need the app to be `shared` with a `product` in a realm with workspaces on. An
app sees only workspaces that use its product (`404` otherwise). The products endpoint also lets an eligible app
join an active workspace in its realm by adding its own product. Bodies are JSON. Errors use the existing
`{ error, error_description }` shape.

| Call | Who | Does |
|---|---|---|
| `GET /v1/memberships?sub=` | app | `{ memberships: [{ workspace_id, name, kind, role, products, version }] }` for active workspaces using the app's product |
| `GET /v1/workspaces/{id}` | app | `{ workspace_id, name, kind, status, products, version }` |
| `GET /v1/workspaces/{id}/members?limit=&cursor=` | app | `{ members: [{ sub, email, role }], next_cursor, version }`, oldest first; cursor as in `/v1/grants` |
| `POST /v1/workspaces` | app with `workspace_admin` on, or any shared app for `kind: "personal"` with `personal_workspaces` on | Team body `{ name, products, first_owner_email, actor_token }`. Omit `products` to use the app's product, or pass exactly that product in a one-item array. The first owner is invited as `owner`, or added at once when it is the actor. Personal body `{ kind: "personal", name, actor_token }`. The actor becomes owner, one per person (`409` if one exists). |
| `PATCH /v1/workspaces/{id}` | actor admin+ | `{ name, actor_token }` |
| `POST /v1/workspaces/{id}/products` | app with `workspace_admin` on, acting for an owner or realm admin | `{ add: [], remove: [], actor_token }`. Every entry must be the app's own product. Adding it can join an active workspace in the app's realm even when the app could not read it before. |
| `POST /v1/workspaces/{id}/invitations` | actor admin+ (owner for role `owner`); team only | `{ email, role, actor_token }` → `201 { invitation_id, expires_at }`; 30 days; one open invitation per email (re-inviting replaces it); sends one email |
| `GET /v1/workspaces/{id}/invitations` | app | open invitations `{ invitations: [{ invitation_id, email, role, expires_at }] }` |
| `DELETE /v1/workspaces/{id}/invitations/{invitation_id}` | actor admin+ | `{ actor_token }` |
| `POST /v1/workspaces/{id}/members/{sub}` | actor admin+ (owner to grant or take `owner`) | `{ role, actor_token }` |
| `DELETE /v1/workspaces/{id}/members/{sub}` | actor admin+, or the member themself | `{ actor_token }`; refused if it would leave no owner |
| `POST /v1/workspaces/{id}/close` | actor owner | `{ actor_token }`; `409 workspace_held` with the reasons while any hold exists |
| `PUT` / `DELETE /v1/workspaces/{id}/holds` | app | `{ reason }`; one hold per app per workspace |
| `PUT` / `DELETE /v1/workspaces/{id}/resources` | app | `{ resource }`; the resource must sit under the app's own `agent_resource_prefixes`. Re-registering the same resource to the same workspace by the same app returns `200` with the current workspace snapshot and changes nothing. A registration held by another workspace or app returns `409`. |

An app with `workspace_admin='on'` and a valid `actor_token` can send or resend an `owner` invitation, revoke an
invitation, or close an active team workspace that uses its product and has zero members. Any hold still blocks
close. The write checks that the roster is still empty and records `unjoined: true` in the audit detail. Once anyone
joins, the usual owner and admin permissions apply.

Rules every change enforces in one `DB.batch`, guarded so concurrent writes cannot break them: the workspace is
active; `version` rises by one; a joined team workspace keeps at least one owner (`409 last_owner`); a personal workspace
never gains a second member; the matching events go into the outbox; an `audit` row records actor and change.

## Signing in to a shared app

`admitSession` and `admitted` (`services/admission.mjs`) admit a person to a `shared` app when any of these hold:

1. an existing admission with `source='app'` (today's policy: open signup, an app-scoped `/v1/invitations` invitation,
   or an allowed domain); this is how a guest who only shares one object in one product signs in;
2. membership of an active workspace that uses the app's product;
3. an open, unexpired workspace invitation for the email to a workspace that uses the app's product, with `mailbox` or
   `provider` proof (never `claim`). Signing in accepts every such invitation in one batch: the member is added with
   the invited role, the invitation is marked accepted, the version rises and events go out.

Admission through 2 or 3 is recorded with `source='workspace'`. When a person leaves (or loses through closing) the
last active workspace that uses a product, in the same batch: their `source='workspace'` admissions to that
product's apps are deleted, those apps get a back-channel logout for the person (`logoutStatements` scoped to those
clients), and their agent grants whose resource is registered to that workspace are revoked through
`agent_revocation_outbox`. A person removed from one workspace but still in another that uses the product keeps their
admission; only the grants for the workspace they left are revoked.

## Agents

At agent consent, when the resource is registered in `workspace_resources` for an active workspace, the person must
be a member of it (`access_denied` otherwise) and the consent page shows the workspace's name. The app still checks
the role on every call.

## Events

Workspace events use the existing outbox, queue, retries, 24-hour expiry and `jti` deduplication. Each is a signed
`secevent+jwt` posted as `workspace_token` to the app's `backchannel_uri`, with claims `iss`, `aud` (the client id),
`jti` (the outbox id), `iat`, `exp` (`iat`+300), `toe`, `sub` (the affected person, member events only) and
`events: { "<issuer>/events/<event>": payload }`.

| Event | Payload |
|---|---|
| `workspace-member-added` | `{ workspace_id, version, role }` |
| `workspace-member-removed` | `{ workspace_id, version }` |
| `workspace-role-changed` | `{ workspace_id, version, role }` |
| `workspace-updated` | `{ workspace_id, version, name }` |
| `workspace-products-changed` | `{ workspace_id, version, products }` |
| `workspace-closed` | `{ workspace_id, version }` |

Recipients: every `shared` app in the realm with a `backchannel_uri` whose product the workspace uses, computed when
the change commits; for `workspace-products-changed`, the products before and after. An app applies an event only if
its `version` is higher than the one it holds for that workspace, and catches up with the members list.

## Console and tools

- `/admin/workspaces`: list (name, kind, status, products, members), detail (members, open invitations, products,
  resources, holds, recent audit), create, rename, close, add or remove products, and invite as a realm admin.
- The app editor and `scripts/seed-client.mjs` gain `product`, `workspaces`, `personal_workspaces`,
  `workspace_admin` and `initiate_login_uri`.
- `scripts/realm.mjs` accepts `"workspaces": "on"` in a realm config.
- `scripts/import-workspaces.mjs`: offline, like `import-users.mjs`. Input JSON lists each product's workspaces with
  members (`sub`, `role`) and open invitations. `--dry-run` prints a report: the workspaces to create, and proposed
  pairs where the same person owns a workspace in two products. A pairs file confirms them. Output is SQL to review.

## Email

One invitation email, `workspace_invitation`, in every language Imprim ships, with the HTML part: who invited them,
the workspace name, the products it uses, and a button to the inviting app's `initiate_login_uri` (or, if unset, the
issuer's `/login`).

## Client `0.8.2`

Client `0.8.0` added these calls; `0.8.1` lets `handleCallback(url, values, { idToken: true })` return
`{ claims, idToken }` for `actor_token`; and `0.8.2` refuses redirects so the client works inside Cloudflare Workers.

`memberships(sub)`, `workspace(id)`, `workspaceMembers(id, { limit, cursor })`, `createWorkspace`, `renameWorkspace`,
`setWorkspaceProducts`, `inviteToWorkspace`, `workspaceInvitations`, `revokeWorkspaceInvitation`, `setMemberRole`,
`removeMember`, `closeWorkspace`, `holdWorkspace`, `releaseWorkspace`, `registerWorkspaceResource`,
`unregisterWorkspaceResource`; and `verifyBackchannel` returns `kind: 'workspace'` for a `workspace_token`, with
`{ event, workspaceId, sub, version, payload, jti }`. Calls that change things take `actorToken`.

## Self-serve sign-up

Realms and apps can opt in to [self-serve sign-up](SIGNUP.md), which creates a team workspace for the app's
product after mailbox verification.

## Not in this version

Agents changing membership, workspace claims in the ID token, and translated console pages.
