-- Preserve the methods existing M1 clients already offered; Google is opt-in for those clients.
ALTER TABLE clients ADD COLUMN sign_in_methods TEXT NOT NULL DEFAULT '["email","github"]'
 CHECK(json_valid(sign_in_methods) AND json_type(sign_in_methods)='array' AND json_array_length(sign_in_methods) BETWEEN 1 AND 3);
ALTER TABLE clients ADD COLUMN google_hosted_domains TEXT NOT NULL DEFAULT '[]'
 CHECK(json_valid(google_hosted_domains) AND json_type(google_hosted_domains)='array');
CREATE TRIGGER clients_methods_insert BEFORE INSERT ON clients BEGIN
 SELECT RAISE(ABORT,'invalid sign_in_methods') WHERE
 EXISTS(SELECT 1 FROM json_each(NEW.sign_in_methods) WHERE type!='text' OR value NOT IN ('email','github','google'))
 OR (SELECT count(DISTINCT value) FROM json_each(NEW.sign_in_methods)) != json_array_length(NEW.sign_in_methods);
 SELECT RAISE(ABORT,'invalid google_hosted_domains') WHERE
 EXISTS(SELECT 1 FROM json_each(NEW.google_hosted_domains) WHERE type!='text' OR value='' OR value!=lower(value)
 OR value GLOB '*[^a-z0-9.-]*' OR value NOT LIKE '%.%' OR value LIKE '.%' OR value LIKE '%.' OR value LIKE '%..%')
 OR (SELECT count(DISTINCT value) FROM json_each(NEW.google_hosted_domains)) != json_array_length(NEW.google_hosted_domains);
END;
CREATE TRIGGER clients_methods_update BEFORE UPDATE OF sign_in_methods,google_hosted_domains ON clients BEGIN
 SELECT RAISE(ABORT,'invalid sign_in_methods') WHERE
 EXISTS(SELECT 1 FROM json_each(NEW.sign_in_methods) WHERE type!='text' OR value NOT IN ('email','github','google'))
 OR (SELECT count(DISTINCT value) FROM json_each(NEW.sign_in_methods)) != json_array_length(NEW.sign_in_methods);
 SELECT RAISE(ABORT,'invalid google_hosted_domains') WHERE
 EXISTS(SELECT 1 FROM json_each(NEW.google_hosted_domains) WHERE type!='text' OR value='' OR value!=lower(value)
 OR value GLOB '*[^a-z0-9.-]*' OR value NOT LIKE '%.%' OR value LIKE '.%' OR value LIKE '%..%')
 OR (SELECT count(DISTINCT value) FROM json_each(NEW.google_hosted_domains)) != json_array_length(NEW.google_hosted_domains);
END;
ALTER TABLE oauth_states ADD COLUMN provider TEXT NOT NULL DEFAULT 'github' CHECK(provider IN ('github','google'));
ALTER TABLE oauth_states ADD COLUMN oidc_nonce TEXT;
-- Rebuild constrained tables without disabling foreign keys or losing live sessions/codes/tokens.
CREATE TABLE identities_copy AS SELECT * FROM user_identities;
DROP TABLE user_identities;
CREATE TABLE user_identities (
 provider TEXT NOT NULL CHECK(provider IN ('github','google')), provider_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id), login TEXT, created INTEGER NOT NULL,
 PRIMARY KEY(provider,provider_id)
);
INSERT INTO user_identities SELECT * FROM identities_copy;
DROP TABLE identities_copy;
CREATE INDEX identities_user ON user_identities(user_id);
CREATE TABLE sessions_copy AS SELECT * FROM sessions;
CREATE TABLE codes_copy AS SELECT * FROM codes;
CREATE TABLE access_tokens_copy AS SELECT * FROM access_tokens;
DROP TABLE codes;
DROP TABLE access_tokens;
DROP TABLE sessions;
CREATE TABLE sessions (
 hash TEXT PRIMARY KEY, sid TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id),
 csrf_hash TEXT NOT NULL, method TEXT NOT NULL CHECK(method IN ('email','github','google')),
 auth_time INTEGER NOT NULL, expires_at INTEGER NOT NULL, google_hd TEXT
);
INSERT INTO sessions(hash,sid,user_id,csrf_hash,method,auth_time,expires_at) SELECT * FROM sessions_copy;
DROP TABLE sessions_copy;
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE codes (
 hash TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), redirect_uri TEXT NOT NULL,
 challenge TEXT NOT NULL, nonce TEXT NOT NULL, scope TEXT NOT NULL,
 session_hash TEXT NOT NULL REFERENCES sessions(hash) ON DELETE CASCADE, expires_at INTEGER NOT NULL
);
INSERT INTO codes SELECT * FROM codes_copy;
DROP TABLE codes_copy;
CREATE INDEX codes_expiry ON codes(expires_at);
CREATE TABLE access_tokens (
 hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL REFERENCES sessions(hash) ON DELETE CASCADE,
 client_id TEXT NOT NULL REFERENCES clients(id), scope TEXT NOT NULL, expires_at INTEGER NOT NULL
);
INSERT INTO access_tokens SELECT * FROM access_tokens_copy;
DROP TABLE access_tokens_copy;
CREATE INDEX access_tokens_expiry ON access_tokens(expires_at);
