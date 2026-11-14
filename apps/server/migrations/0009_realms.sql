-- Realms: each brand gets its own issuer host, signing keys, users, provider credentials, email sender and admins.
-- Clients belong to exactly one realm. Existing data becomes realm 'default'; its issuer is set by the operator
-- (scripts/realm.mjs) before the realm-aware Worker is deployed. D1 runs each migration file in one transaction.
PRAGMA defer_foreign_keys = on;

CREATE TABLE realms (
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 40 AND id NOT GLOB '*[^a-z0-9-]*'),
 issuer TEXT UNIQUE CHECK(issuer IS NULL OR (issuer LIKE 'https://%' AND issuer NOT LIKE '%/' AND length(issuer) <= 200)),
 display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 100),
 config TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(config) AND json_type(config)='object'),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 version INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL
);
-- The default realm reads the deployment's existing variable and secret names, so nothing else changes for it.
INSERT INTO realms(id, issuer, display_name, config, created) VALUES('default', NULL, 'Identity', json('{
 "email": { "from": { "env": "EMAIL_FROM" } },
 "turnstile": { "site_key": { "env": "TURNSTILE_SITE_KEY" }, "secret": { "env": "TURNSTILE_SECRET" } },
 "providers": {
  "github": { "client_id": { "env": "GITHUB_CLIENT_ID" }, "client_secret": { "env": "GITHUB_CLIENT_SECRET" } },
  "google": { "client_id": { "env": "GOOGLE_CLIENT_ID" }, "client_secret": { "env": "GOOGLE_CLIENT_SECRET" } }
 }
}'), 0);

-- Admins live in D1, per realm, never in a committed variable. `platform` also manages realms and signing keys.
CREATE TABLE admins (
 realm_id TEXT NOT NULL REFERENCES realms(id), email TEXT NOT NULL COLLATE NOCASE,
 role TEXT NOT NULL CHECK(role IN ('platform','realm')), created INTEGER NOT NULL, created_by TEXT,
 PRIMARY KEY(realm_id, email)
);

-- Users: email is unique per realm. Rebuilt by copy, drop and recreate so deferred foreign keys balance.
CREATE TABLE users_copy AS SELECT * FROM users;
DROP TABLE users;
CREATE TABLE users (
 id TEXT PRIMARY KEY, realm_id TEXT NOT NULL DEFAULT 'default' REFERENCES realms(id),
 email TEXT NOT NULL COLLATE NOCASE,
 email_verified INTEGER NOT NULL DEFAULT 0 CHECK(email_verified IN (0,1)),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','blocked','deleted')),
 merged_into TEXT REFERENCES users(id), created INTEGER NOT NULL,
 UNIQUE(realm_id, email)
);
INSERT INTO users(id, realm_id, email, email_verified, status, merged_into, created)
 SELECT id, 'default', email, email_verified, status, merged_into, created FROM users_copy;
DROP TABLE users_copy;

-- Provider subjects are unique per realm: one GitHub account may be two people's accounts in two brands.
CREATE TABLE identities_copy AS SELECT * FROM user_identities;
DROP TABLE user_identities;
CREATE TABLE user_identities (
 realm_id TEXT NOT NULL DEFAULT 'default' REFERENCES realms(id),
 provider TEXT NOT NULL CHECK(provider IN ('github','google')), provider_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id), login TEXT, created INTEGER NOT NULL,
 PRIMARY KEY(realm_id, provider, provider_id)
);
INSERT INTO user_identities(realm_id, provider, provider_id, user_id, login, created)
 SELECT 'default', provider, provider_id, user_id, login, created FROM identities_copy;
DROP TABLE identities_copy;
CREATE INDEX identities_user ON user_identities(user_id);

-- Signing keys: one ring per realm.
CREATE TABLE keys_copy AS SELECT * FROM signing_keys;
DROP TABLE signing_keys;
CREATE TABLE signing_keys (
 realm_id TEXT NOT NULL DEFAULT 'default' REFERENCES realms(id), generation INTEGER NOT NULL,
 kid TEXT NOT NULL UNIQUE, public_jwk TEXT NOT NULL, sealed_jwk TEXT NOT NULL, created_at INTEGER NOT NULL,
 activates_at INTEGER NOT NULL, retired_at INTEGER, verification_until INTEGER,
 PRIMARY KEY(realm_id, generation)
);
INSERT INTO signing_keys(realm_id, generation, kid, public_jwk, sealed_jwk, created_at, activates_at, retired_at, verification_until)
 SELECT 'default', generation, kid, public_jwk, sealed_jwk, created_at, activates_at, retired_at, verification_until FROM keys_copy;
DROP TABLE keys_copy;

-- Clients, dynamic agent registrations and magic links carry their realm.
ALTER TABLE clients ADD COLUMN realm_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX clients_realm ON clients(realm_id);
CREATE TRIGGER clients_realm_insert BEFORE INSERT ON clients BEGIN
 SELECT RAISE(ABORT,'unknown realm') WHERE NOT EXISTS(SELECT 1 FROM realms WHERE id=NEW.realm_id);
END;
CREATE TRIGGER clients_realm_update BEFORE UPDATE OF realm_id ON clients BEGIN
 SELECT RAISE(ABORT,'a client cannot move between realms');
END;
ALTER TABLE agent_clients ADD COLUMN realm_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE magic_links ADD COLUMN realm_id TEXT NOT NULL DEFAULT 'default';

-- Audit rows name their realm. The append-only trigger is lifted only for this one backfill.
ALTER TABLE audit ADD COLUMN realm_id TEXT;
DROP TRIGGER audit_no_update;
UPDATE audit SET realm_id='default';
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
CREATE INDEX audit_realm_page ON audit(realm_id, id);
