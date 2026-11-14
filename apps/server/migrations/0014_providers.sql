-- Provider registry: upstream providers are named in realm config (github, google, microsoft, apple or any OIDC
-- issuer), so provider ids are validated in code and here by shape only. D1 runs this file in one transaction.
PRAGMA defer_foreign_keys = on;
CREATE TABLE states_copy AS SELECT * FROM oauth_states;
DROP TABLE oauth_states;
CREATE TABLE oauth_states (
 hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, verifier TEXT NOT NULL,
 request_id TEXT NOT NULL REFERENCES auth_requests(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL,
 provider TEXT NOT NULL CHECK(length(provider) BETWEEN 2 AND 40 AND provider NOT GLOB '*[^a-z0-9-]*'), oidc_nonce TEXT
);
INSERT INTO oauth_states SELECT * FROM states_copy;
DROP TABLE states_copy;
CREATE INDEX oauth_states_expiry ON oauth_states(expires_at);
CREATE TABLE identities_copy AS SELECT * FROM user_identities;
DROP TABLE user_identities;
CREATE TABLE user_identities (
 realm_id TEXT NOT NULL DEFAULT 'default' REFERENCES realms(id),
 provider TEXT NOT NULL CHECK(length(provider) BETWEEN 2 AND 40 AND provider NOT GLOB '*[^a-z0-9-]*'), provider_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id), login TEXT, created INTEGER NOT NULL,
 PRIMARY KEY(realm_id, provider, provider_id)
);
INSERT INTO user_identities SELECT * FROM identities_copy;
DROP TABLE identities_copy;
CREATE INDEX identities_user ON user_identities(user_id);
-- Client methods: built-ins or a provider id (lowercase letters, digits and hyphens).
DROP TRIGGER clients_methods_insert;
DROP TRIGGER clients_methods_update;
CREATE TRIGGER clients_methods_insert BEFORE INSERT ON clients BEGIN
 SELECT RAISE(ABORT,'invalid sign_in_methods') WHERE
 EXISTS(SELECT 1 FROM json_each(NEW.sign_in_methods) WHERE type!='text' OR length(value) NOT BETWEEN 2 AND 40 OR value GLOB '*[^a-z0-9-]*')
 OR (SELECT count(DISTINCT value) FROM json_each(NEW.sign_in_methods)) != json_array_length(NEW.sign_in_methods);
 SELECT RAISE(ABORT,'invalid google_hosted_domains') WHERE
 EXISTS(SELECT 1 FROM json_each(NEW.google_hosted_domains) WHERE type!='text' OR value='' OR value!=lower(value)
 OR value GLOB '*[^a-z0-9.-]*' OR value NOT LIKE '%.%' OR value LIKE '.%' OR value LIKE '%.' OR value LIKE '%..%')
 OR (SELECT count(DISTINCT value) FROM json_each(NEW.google_hosted_domains)) != json_array_length(NEW.google_hosted_domains);
END;
CREATE TRIGGER clients_methods_update BEFORE UPDATE OF sign_in_methods,google_hosted_domains ON clients BEGIN
 SELECT RAISE(ABORT,'invalid sign_in_methods') WHERE
 EXISTS(SELECT 1 FROM json_each(NEW.sign_in_methods) WHERE type!='text' OR length(value) NOT BETWEEN 2 AND 40 OR value GLOB '*[^a-z0-9-]*')
 OR (SELECT count(DISTINCT value) FROM json_each(NEW.sign_in_methods)) != json_array_length(NEW.sign_in_methods);
 SELECT RAISE(ABORT,'invalid google_hosted_domains') WHERE
 EXISTS(SELECT 1 FROM json_each(NEW.google_hosted_domains) WHERE type!='text' OR value='' OR value!=lower(value)
 OR value GLOB '*[^a-z0-9.-]*' OR value NOT LIKE '%.%' OR value LIKE '.%' OR value LIKE '%..%')
 OR (SELECT count(DISTINCT value) FROM json_each(NEW.google_hosted_domains)) != json_array_length(NEW.google_hosted_domains);
END;
