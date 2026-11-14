-- Two-factor authentication (account security, part 2).
-- TOTP secrets are sealed with SEALING_KEY (AES-256-GCM, factor id as additional data). last_step records the
-- last accepted 30-second step, so a code is accepted once.
CREATE TABLE mfa_factors (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), type TEXT NOT NULL CHECK(type IN ('totp')),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60), sealed_secret TEXT NOT NULL,
 last_step INTEGER NOT NULL DEFAULT -1, confirmed INTEGER NOT NULL DEFAULT 0 CHECK(confirmed IN (0,1)),
 created INTEGER NOT NULL, last_used INTEGER
);
CREATE INDEX mfa_factors_user ON mfa_factors(user_id, confirmed);
-- Ten single-use recovery codes, stored as SHA-256 (each has 50 random bits).
CREATE TABLE recovery_codes (
 user_id TEXT NOT NULL REFERENCES users(id), hash TEXT NOT NULL, created INTEGER NOT NULL, used_at INTEGER,
 PRIMARY KEY(user_id, hash)
);
-- "Remember this browser": a hashed device token, revocable, ended by any password or factor change.
CREATE TABLE trusted_devices (
 hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
 created INTEGER NOT NULL, last_used INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX trusted_devices_user ON trusted_devices(user_id);
CREATE INDEX trusted_devices_expiry ON trusted_devices(expires_at);
-- Per-app policy. mfa: off, optional (required once a person has a factor) or required. A trusted browser may skip
-- the second factor for mfa_trusted_device_days (0 = never). agent_consent_mfa: approving an agent needs a second
-- factor within the last 15 minutes.
ALTER TABLE clients ADD COLUMN mfa TEXT NOT NULL DEFAULT 'off' CHECK(mfa IN ('off','optional','required'));
ALTER TABLE clients ADD COLUMN mfa_trusted_device_days INTEGER NOT NULL DEFAULT 0 CHECK(mfa_trusted_device_days BETWEEN 0 AND 90);
ALTER TABLE clients ADD COLUMN agent_consent_mfa TEXT NOT NULL DEFAULT 'off' CHECK(agent_consent_mfa IN ('off','required'));
-- Step-up requested by the app: acr_values and max_age travel with the authorization request.
ALTER TABLE auth_requests ADD COLUMN acr_values TEXT;
ALTER TABLE auth_requests ADD COLUMN max_age INTEGER;
