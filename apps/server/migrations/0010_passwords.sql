-- Passwords (account security, part 1). D1 runs this file in one transaction.
PRAGMA defer_foreign_keys = on;

-- One password per user. Algorithm and parameters are stored with each hash, so a stronger scheme can replace a
-- hash at the next successful sign-in.
CREATE TABLE user_passwords (
 user_id TEXT PRIMARY KEY REFERENCES users(id),
 algorithm TEXT NOT NULL CHECK(algorithm IN ('pbkdf2-sha256')),
 iterations INTEGER NOT NULL CHECK(iterations >= 100000),
 salt TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL
);

-- A magic link either signs in ('sign_in') or proves the mailbox before setting a password ('password').
ALTER TABLE magic_links ADD COLUMN purpose TEXT NOT NULL DEFAULT 'sign_in' CHECK(purpose IN ('sign_in','password'));

-- Sessions: method is validated in code (the list grows with passkeys and providers); amr records RFC 8176 values,
-- mfa_at the time a second factor was last satisfied. Rebuilt by copy, drop and recreate. In-flight codes and
-- access tokens (at most ten minutes old) cascade away; people mid-sign-in start again.
CREATE TABLE sessions_copy AS SELECT * FROM sessions;
DROP TABLE sessions;
CREATE TABLE sessions (
 hash TEXT PRIMARY KEY, sid TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id),
 csrf_hash TEXT NOT NULL, method TEXT NOT NULL CHECK(length(method) BETWEEN 1 AND 64),
 auth_time INTEGER NOT NULL, expires_at INTEGER NOT NULL, google_hd TEXT, admin_until INTEGER,
 amr TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(amr) AND json_type(amr)='array'), mfa_at INTEGER
);
INSERT INTO sessions(hash,sid,user_id,csrf_hash,method,auth_time,expires_at,google_hd,admin_until,amr)
 SELECT hash,sid,user_id,csrf_hash,method,auth_time,expires_at,google_hd,admin_until,json_array(method) FROM sessions_copy;
DROP TABLE sessions_copy;
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX sessions_user ON sessions(user_id);

-- Clients: the sign-in method list grows (password now; passkeys and providers later), so the 1-3 CHECK goes.
-- client_admissions cascades from clients and is kept across the rebuild; every other dependent is NO ACTION and
-- balances when the rows return.
CREATE TABLE admissions_copy AS SELECT * FROM client_admissions;
CREATE TABLE clients_copy AS SELECT * FROM clients;
DROP TABLE clients;
CREATE TABLE clients (
 id TEXT PRIMARY KEY, secret_hash TEXT,
 redirect_uris TEXT NOT NULL CHECK(json_valid(redirect_uris)),
 post_logout_uris TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(post_logout_uris)),
 backchannel_uri TEXT, signup_policy TEXT NOT NULL DEFAULT 'invited' CHECK(signup_policy IN ('invited','open')),
 allowed_domains TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(allowed_domains)),
 branding TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(branding)),
 dev INTEGER NOT NULL DEFAULT 0 CHECK(dev IN (0,1)),
 sign_in_methods TEXT NOT NULL DEFAULT '["email"]'
  CHECK(json_valid(sign_in_methods) AND json_type(sign_in_methods)='array' AND json_array_length(sign_in_methods) BETWEEN 1 AND 16),
 google_hosted_domains TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(google_hosted_domains) AND json_type(google_hosted_domains)='array'),
 agent_access TEXT NOT NULL DEFAULT 'off' CHECK(agent_access IN ('off','on')),
 agent_registration_methods TEXT NOT NULL DEFAULT '["metadata_document"]' CHECK(json_valid(agent_registration_methods)),
 agent_allowlist TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(agent_allowlist)),
 agent_scope_catalogue TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(agent_scope_catalogue)),
 agent_resource_prefixes TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(agent_resource_prefixes)),
 agent_max_grant_days INTEGER NOT NULL DEFAULT 90 CHECK(typeof(agent_max_grant_days)='integer' AND agent_max_grant_days>0),
 version INTEGER NOT NULL DEFAULT 0, realm_id TEXT NOT NULL DEFAULT 'default'
);
INSERT INTO clients SELECT * FROM clients_copy;
DROP TABLE clients_copy;
INSERT OR IGNORE INTO client_admissions SELECT * FROM admissions_copy;
DROP TABLE admissions_copy;
CREATE INDEX clients_realm ON clients(realm_id);
CREATE TRIGGER clients_realm_insert BEFORE INSERT ON clients BEGIN
 SELECT RAISE(ABORT,'unknown realm') WHERE NOT EXISTS(SELECT 1 FROM realms WHERE id=NEW.realm_id);
END;
CREATE TRIGGER clients_realm_update BEFORE UPDATE OF realm_id ON clients BEGIN
 SELECT RAISE(ABORT,'a client cannot move between realms');
END;
CREATE TRIGGER clients_methods_insert BEFORE INSERT ON clients BEGIN
 SELECT RAISE(ABORT,'invalid sign_in_methods') WHERE
 EXISTS(SELECT 1 FROM json_each(NEW.sign_in_methods) WHERE type!='text' OR value NOT IN ('email','github','google','password','passkey'))
 OR (SELECT count(DISTINCT value) FROM json_each(NEW.sign_in_methods)) != json_array_length(NEW.sign_in_methods);
 SELECT RAISE(ABORT,'invalid google_hosted_domains') WHERE
 EXISTS(SELECT 1 FROM json_each(NEW.google_hosted_domains) WHERE type!='text' OR value='' OR value!=lower(value)
 OR value GLOB '*[^a-z0-9.-]*' OR value NOT LIKE '%.%' OR value LIKE '.%' OR value LIKE '%.' OR value LIKE '%..%')
 OR (SELECT count(DISTINCT value) FROM json_each(NEW.google_hosted_domains)) != json_array_length(NEW.google_hosted_domains);
END;
CREATE TRIGGER clients_methods_update BEFORE UPDATE OF sign_in_methods,google_hosted_domains ON clients BEGIN
 SELECT RAISE(ABORT,'invalid sign_in_methods') WHERE
 EXISTS(SELECT 1 FROM json_each(NEW.sign_in_methods) WHERE type!='text' OR value NOT IN ('email','github','google','password','passkey'))
 OR (SELECT count(DISTINCT value) FROM json_each(NEW.sign_in_methods)) != json_array_length(NEW.sign_in_methods);
 SELECT RAISE(ABORT,'invalid google_hosted_domains') WHERE
 EXISTS(SELECT 1 FROM json_each(NEW.google_hosted_domains) WHERE type!='text' OR value='' OR value!=lower(value)
 OR value GLOB '*[^a-z0-9.-]*' OR value NOT LIKE '%.%' OR value LIKE '.%' OR value LIKE '%..%')
 OR (SELECT count(DISTINCT value) FROM json_each(NEW.google_hosted_domains)) != json_array_length(NEW.google_hosted_domains);
END;
