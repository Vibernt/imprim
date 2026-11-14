-- App associations outlive identity sessions and UserInfo tokens, but expire 30 days after creation.
CREATE TABLE app_sessions (
 client_id TEXT NOT NULL REFERENCES clients(id), user_id TEXT NOT NULL REFERENCES users(id),
 sid TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(client_id,user_id,sid)
);
CREATE INDEX app_sessions_user ON app_sessions(user_id);
CREATE INDEX app_sessions_created ON app_sessions(created);
CREATE TABLE logout_outbox (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL, sid TEXT,
 uri TEXT, created INTEGER NOT NULL, queued_at INTEGER, delivered_at INTEGER
);
CREATE INDEX logout_pending ON logout_outbox(delivered_at,queued_at);
ALTER TABLE agent_revocation_outbox ADD COLUMN delivered_at INTEGER;
ALTER TABLE sessions ADD COLUMN admin_until INTEGER;
ALTER TABLE audit ADD COLUMN target TEXT;
CREATE INDEX audit_actor_page ON audit(actor,id);
CREATE INDEX audit_target_page ON audit(target,id);
-- A healthy retired key remains verifiable; unreadable keys retain the M1 recovery policy.
ALTER TABLE signing_keys ADD COLUMN verification_until INTEGER;
-- Transaction-local assertions: invalid predicates abort the entire admin batch.
CREATE TABLE admin_assertions(ok INTEGER CONSTRAINT admin_assertions CHECK(ok=1));
CREATE TRIGGER admin_assertions_cleanup AFTER INSERT ON admin_assertions BEGIN DELETE FROM admin_assertions; END;
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX agent_revocations_pending ON agent_revocation_outbox(delivered_at,queued_at);
