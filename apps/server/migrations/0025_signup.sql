ALTER TABLE clients ADD COLUMN self_signup TEXT NOT NULL DEFAULT 'off' CHECK(self_signup IN ('off','on'));
ALTER TABLE workspaces ADD COLUMN created_via TEXT CHECK(created_via IS NULL OR created_via='signup');

-- SQLite cannot extend the old purpose CHECK in place. Keep the pending authorization foreign key and expiry index.
CREATE TABLE magic_links_new (
 hash TEXT PRIMARY KEY, email TEXT NOT NULL, request_id TEXT REFERENCES auth_requests(id) ON DELETE CASCADE,
 browser_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, realm_id TEXT NOT NULL DEFAULT 'default',
 purpose TEXT NOT NULL DEFAULT 'sign_in' CHECK(purpose IN ('sign_in','password','signup')),
 workspace_name TEXT CHECK(workspace_name IS NULL OR (purpose='signup' AND length(workspace_name) BETWEEN 1 AND 120))
);
INSERT INTO magic_links_new(hash,email,request_id,browser_hash,expires_at,realm_id,purpose)
 SELECT hash,email,request_id,browser_hash,expires_at,realm_id,purpose FROM magic_links;
DROP TABLE magic_links;
ALTER TABLE magic_links_new RENAME TO magic_links;
CREATE INDEX magic_links_expiry ON magic_links(expires_at);
