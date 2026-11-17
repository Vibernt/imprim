-- Shared workspaces (docs/WORKSPACES.md). Off unless a realm turns them on and an app opts in: apps default to
-- workspaces='app', today's behaviour. Workspaces are closed, never deleted, so ids stay linked to products' records.
CREATE TABLE workspaces (
 id TEXT PRIMARY KEY, realm_id TEXT NOT NULL REFERENCES realms(id),
 kind TEXT NOT NULL CHECK(kind IN ('team','personal')), name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed')),
 personal_owner TEXT UNIQUE REFERENCES users(id),
 version INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL, closed_at INTEGER,
 CHECK((kind='personal') = (personal_owner IS NOT NULL))
);
CREATE INDEX workspaces_realm ON workspaces(realm_id, status);
CREATE TABLE workspace_members (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES users(id),
 role TEXT NOT NULL CHECK(role IN ('owner','admin','member','viewer')), created INTEGER NOT NULL, updated INTEGER NOT NULL,
 PRIMARY KEY(workspace_id, user_id)
);
CREATE INDEX workspace_members_user ON workspace_members(user_id);
CREATE INDEX workspace_members_page ON workspace_members(workspace_id, created, user_id);
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
CREATE TABLE workspace_resources (
 resource TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), client_id TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE INDEX workspace_resources_workspace ON workspace_resources(workspace_id);
CREATE TABLE workspace_holds (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id), client_id TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 200), created INTEGER NOT NULL,
 PRIMARY KEY(workspace_id, client_id)
);
CREATE TABLE workspace_event_outbox (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL, workspace_id TEXT NOT NULL, user_id TEXT,
 event TEXT NOT NULL CHECK(event IN ('workspace-member-added','workspace-member-removed','workspace-role-changed',
  'workspace-updated','workspace-products-changed','workspace-closed')),
 payload TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload)), version INTEGER NOT NULL, uri TEXT, created INTEGER NOT NULL,
 queued_at INTEGER, delivered_at INTEGER, delivery_state TEXT NOT NULL DEFAULT 'pending', last_error TEXT
);
CREATE INDEX workspace_event_pending ON workspace_event_outbox(delivered_at,queued_at);
CREATE INDEX workspace_event_retention ON workspace_event_outbox(delivered_at,id);
CREATE INDEX workspace_event_expiry ON workspace_event_outbox(delivery_state,created,id);
ALTER TABLE clients ADD COLUMN product TEXT CHECK(product IS NULL OR (length(product) BETWEEN 2 AND 40 AND product NOT GLOB '*[^a-z0-9-]*' AND substr(product,1,1) GLOB '[a-z]'));
ALTER TABLE clients ADD COLUMN workspaces TEXT NOT NULL DEFAULT 'app' CHECK(workspaces IN ('app','shared'));
ALTER TABLE clients ADD COLUMN personal_workspaces TEXT NOT NULL DEFAULT 'off' CHECK(personal_workspaces IN ('off','on'));
ALTER TABLE clients ADD COLUMN workspace_admin TEXT NOT NULL DEFAULT 'off' CHECK(workspace_admin IN ('off','on'));
ALTER TABLE clients ADD COLUMN initiate_login_uri TEXT;
ALTER TABLE client_admissions ADD COLUMN source TEXT NOT NULL DEFAULT 'app' CHECK(source IN ('app','workspace'));
