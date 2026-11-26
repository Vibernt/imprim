ALTER TABLE service_clients ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE service_clients ADD COLUMN accountable_user_id TEXT REFERENCES users(id);
ALTER TABLE service_clients ADD COLUMN expires_at INTEGER;
ALTER TABLE service_clients ADD COLUMN source TEXT NOT NULL DEFAULT 'admin' CHECK(source IN ('admin','workspace'));
CREATE INDEX service_clients_workspace ON service_clients(workspace_id);

CREATE TABLE machine_client_requests (
 id TEXT PRIMARY KEY NOT NULL,
 realm_id TEXT NOT NULL REFERENCES realms(id),
 app_id TEXT NOT NULL REFERENCES clients(id),
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 jwks TEXT NOT NULL CHECK(json_valid(jwks)),
 scopes TEXT NOT NULL CHECK(json_valid(scopes) AND json_type(scopes)='array'),
 resources TEXT NOT NULL CHECK(json_valid(resources) AND json_type(resources)='array'),
 status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','expired')),
 created INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 decided_by TEXT REFERENCES users(id),
 decided_at INTEGER,
 service_client_id TEXT
);
CREATE INDEX machine_client_requests_workspace_status ON machine_client_requests(workspace_id,status);
