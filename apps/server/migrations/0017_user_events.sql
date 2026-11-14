-- User lifecycle events for apps (RFC 8417 security event tokens over the back-channel).
CREATE TABLE user_event_outbox (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL,
 event TEXT NOT NULL CHECK(event IN ('user-updated','user-blocked','user-unblocked','user-deleted','user-merged','mfa-reset')),
 payload TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload)), uri TEXT, created INTEGER NOT NULL,
 queued_at INTEGER, delivered_at INTEGER, delivery_state TEXT NOT NULL DEFAULT 'pending', last_error TEXT
);
CREATE INDEX user_event_pending ON user_event_outbox(delivered_at,queued_at);
CREATE INDEX user_event_retention ON user_event_outbox(delivered_at,id);
CREATE INDEX user_event_expiry ON user_event_outbox(delivery_state,created,id);
-- Opt-in per app: only apps that handle event_token receive user events.
ALTER TABLE clients ADD COLUMN user_events TEXT NOT NULL DEFAULT 'off' CHECK(user_events IN ('off','on'));
