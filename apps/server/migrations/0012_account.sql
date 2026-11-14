-- Account page (account security, part 3).
ALTER TABLE users ADD COLUMN display_name TEXT CHECK(display_name IS NULL OR length(display_name) BETWEEN 1 AND 100);
-- Where and on what each identity session was opened, and when it was last used (updated at most every 5 minutes).
ALTER TABLE sessions ADD COLUMN device TEXT;
ALTER TABLE sessions ADD COLUMN location TEXT;
ALTER TABLE sessions ADD COLUMN last_seen INTEGER;
-- Devices a person has signed in from, so a sign-in from a new one sends a notice.
CREATE TABLE seen_devices (
 user_id TEXT NOT NULL REFERENCES users(id), device_hash TEXT NOT NULL, last_seen INTEGER NOT NULL,
 PRIMARY KEY(user_id, device_hash)
);
-- Email change: a single-use, browser-bound link to the new address.
CREATE TABLE email_changes (
 hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), new_email TEXT NOT NULL COLLATE NOCASE,
 browser_hash TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX email_changes_expiry ON email_changes(expires_at);
