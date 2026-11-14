-- Security pass (brief of 2026-11-15, findings S3, S5, S16 and sweep cost).

-- S3: admission is per (user, app). An account created through one app does not admit it to an invited app.
CREATE TABLE client_admissions (
 user_id TEXT NOT NULL REFERENCES users(id), client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
 created INTEGER NOT NULL, PRIMARY KEY(user_id, client_id)
);
CREATE INDEX client_admissions_client ON client_admissions(client_id);
-- Backfill: anyone who already reached an app (an app session, an agent grant, or an issued token) stays admitted.
INSERT OR IGNORE INTO client_admissions(user_id, client_id, created)
 SELECT user_id, client_id, min(created) FROM app_sessions
 WHERE user_id IN (SELECT id FROM users) AND client_id IN (SELECT id FROM clients) GROUP BY user_id, client_id;
INSERT OR IGNORE INTO client_admissions(user_id, client_id, created)
 SELECT user_id, app_id, min(created) FROM agent_grants
 WHERE user_id IN (SELECT id FROM users) AND app_id IN (SELECT id FROM clients) GROUP BY user_id, app_id;
INSERT OR IGNORE INTO client_admissions(user_id, client_id, created)
 SELECT actor, json_extract(detail, '$.client_id'), min(created) FROM audit
 WHERE event = 'token_issued' AND json_valid(detail) AND actor IN (SELECT id FROM users)
 AND json_extract(detail, '$.client_id') IN (SELECT id FROM clients) GROUP BY actor, json_extract(detail, '$.client_id');

-- S16: a replayed code revokes what it issued.
ALTER TABLE consumed_codes ADD COLUMN access_hash TEXT;
-- A replay marks the code, so an issuance still in flight cannot insert its access token afterwards.
ALTER TABLE consumed_codes ADD COLUMN replayed INTEGER NOT NULL DEFAULT 0 CHECK(replayed IN (0,1));
CREATE TABLE agent_consumed_codes (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX agent_consumed_codes_expiry ON agent_consumed_codes(expires_at);

-- S10 / private_key_jwt: single-use client assertion ids.
CREATE TABLE agent_assertions (jti_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE INDEX agent_assertions_expiry ON agent_assertions(expires_at);

-- S5: bounded growth. Grants and spent refresh tokens are swept; audit has a 400-day retention.
ALTER TABLE agent_refresh_tokens ADD COLUMN created INTEGER NOT NULL DEFAULT 0;
-- A replacement spent by a grace retry never gets a grace retry of its own.
ALTER TABLE agent_refresh_tokens ADD COLUMN grace_spent INTEGER NOT NULL DEFAULT 0 CHECK(grace_spent IN (0,1));
CREATE INDEX agent_refresh_spent ON agent_refresh_tokens(spent_at);
CREATE INDEX agent_grants_revoked ON agent_grants(revoked_at);
CREATE INDEX agent_grants_expiry ON agent_grants(expires_at);
CREATE INDEX agent_grants_app ON agent_grants(app_id, revoked_at);
CREATE INDEX agent_grants_user_page ON agent_grants(user_id, created, id);
DROP TRIGGER audit_no_delete;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
 WHEN OLD.created > CAST(strftime('%s','now') AS INTEGER) * 1000 - 34560000000
 BEGIN SELECT RAISE(ABORT,'audit is append-only within its 400-day retention'); END;
CREATE INDEX audit_created ON audit(created);

-- Sweep cost: every table the minute sweep deletes by expiry has an index on it.
CREATE INDEX consumed_codes_expiry ON consumed_codes(expires_at);
CREATE INDEX invitations_expiry ON invitations(expires_at);
CREATE INDEX agent_codes_expiry ON agent_codes(expires_at);
CREATE INDEX agent_metadata_cache_expiry ON agent_metadata_cache(expires_at);
CREATE INDEX agent_devices_expiry ON agent_devices(expires_at);
CREATE INDEX agent_devices_grant ON agent_devices(grant_id);
CREATE INDEX agent_clients_used ON agent_clients(last_used);
