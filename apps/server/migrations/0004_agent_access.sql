ALTER TABLE clients ADD COLUMN agent_access TEXT NOT NULL DEFAULT 'off' CHECK(agent_access IN ('off','on'));
ALTER TABLE clients ADD COLUMN agent_registration_methods TEXT NOT NULL DEFAULT '["metadata_document"]' CHECK(json_valid(agent_registration_methods));
ALTER TABLE clients ADD COLUMN agent_allowlist TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(agent_allowlist));
ALTER TABLE clients ADD COLUMN agent_scope_catalogue TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(agent_scope_catalogue));
ALTER TABLE clients ADD COLUMN agent_resource_prefixes TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(agent_resource_prefixes));
ALTER TABLE clients ADD COLUMN agent_max_grant_days INTEGER NOT NULL DEFAULT 90 CHECK(typeof(agent_max_grant_days)='integer' AND agent_max_grant_days>0);
ALTER TABLE auth_requests ADD COLUMN agent_client_id TEXT;
ALTER TABLE auth_requests ADD COLUMN resource TEXT;
ALTER TABLE auth_requests ADD COLUMN device_hash TEXT;
CREATE TABLE agent_clients (
 id TEXT PRIMARY KEY, metadata TEXT NOT NULL CHECK(json_valid(metadata)), created INTEGER NOT NULL, last_used INTEGER NOT NULL
);
CREATE TABLE agent_metadata_cache (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE agent_grants (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL, client_name TEXT NOT NULL, registration_method TEXT NOT NULL,
 app_id TEXT NOT NULL REFERENCES clients(id), user_id TEXT NOT NULL REFERENCES users(id),
 resource TEXT NOT NULL, scope TEXT NOT NULL, method TEXT NOT NULL, google_hd TEXT,
 created INTEGER NOT NULL, last_used INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE INDEX agent_grants_user ON agent_grants(user_id);
CREATE TABLE agent_codes (
 hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES agent_grants(id) ON DELETE CASCADE,
 redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, session_hash TEXT NOT NULL REFERENCES sessions(hash) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL
);
CREATE TABLE agent_refresh_tokens (
 hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES agent_grants(id) ON DELETE CASCADE,
 spent_at INTEGER, replacement_hash TEXT UNIQUE
);
CREATE INDEX agent_refresh_grant ON agent_refresh_tokens(grant_id);
CREATE TABLE agent_devices (
 hash TEXT PRIMARY KEY, user_code_hash TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL, app_id TEXT NOT NULL REFERENCES clients(id),
 resource TEXT NOT NULL, scope TEXT NOT NULL, expires_at INTEGER NOT NULL,
 interval INTEGER NOT NULL DEFAULT 5, next_poll INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
 grant_id TEXT REFERENCES agent_grants(id), poll_marker TEXT
);
CREATE TABLE agent_revocation_outbox (
 id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, app_id TEXT NOT NULL, user_id TEXT NOT NULL, resource TEXT NOT NULL,
 uri TEXT NOT NULL, created INTEGER NOT NULL, queued_at INTEGER
);
