CREATE TABLE signup_requests (
 id TEXT PRIMARY KEY, realm_id TEXT NOT NULL REFERENCES realms(id), client_id TEXT NOT NULL,
 product TEXT NOT NULL, email TEXT NOT NULL, workspace_name TEXT NOT NULL CHECK(length(workspace_name) BETWEEN 1 AND 120),
 locale TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined','expired')),
 created INTEGER NOT NULL, verified_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT, reason TEXT
);
CREATE UNIQUE INDEX signup_requests_pending ON signup_requests(realm_id,email,product) WHERE status='pending';
CREATE INDEX signup_requests_by_status ON signup_requests(realm_id,status,created DESC,id DESC);
CREATE INDEX signup_requests_expiry ON signup_requests(verified_at) WHERE status='pending';
