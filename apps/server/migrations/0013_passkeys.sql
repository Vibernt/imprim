-- Passkeys (WebAuthn): a passwordless sign-in method and a second factor. The relying party ID is the realm's host.
CREATE TABLE webauthn_credentials (
 id TEXT PRIMARY KEY, realm_id TEXT NOT NULL REFERENCES realms(id), user_id TEXT NOT NULL REFERENCES users(id),
 public_key TEXT NOT NULL CHECK(json_valid(public_key)), alg INTEGER NOT NULL CHECK(alg IN (-7,-8,-257)),
 sign_count INTEGER NOT NULL DEFAULT 0, backup_eligible INTEGER NOT NULL DEFAULT 0 CHECK(backup_eligible IN (0,1)),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60), created INTEGER NOT NULL, last_used INTEGER
);
CREATE INDEX webauthn_credentials_user ON webauthn_credentials(user_id);
-- Single-use, browser-bound challenges, looked up by the hash of the challenge the browser signs.
CREATE TABLE webauthn_challenges (
 hash TEXT PRIMARY KEY, purpose TEXT NOT NULL CHECK(purpose IN ('register','login','mfa')),
 user_id TEXT, request_id TEXT, browser_hash TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX webauthn_challenges_expiry ON webauthn_challenges(expires_at);
