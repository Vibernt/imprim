-- Adapted from Assay 0001_catalog, 0026_oidc_signing_keys and 0048_github_sign_in.
PRAGMA foreign_keys=ON;
CREATE TABLE users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 email_verified INTEGER NOT NULL DEFAULT 0 CHECK(email_verified IN (0,1)),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','blocked','deleted')),
 merged_into TEXT REFERENCES users(id), created INTEGER NOT NULL
);
CREATE TABLE user_identities (
 provider TEXT NOT NULL CHECK(provider='github'), provider_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id), login TEXT, created INTEGER NOT NULL,
 PRIMARY KEY(provider,provider_id)
);
CREATE INDEX identities_user ON user_identities(user_id);
CREATE TABLE clients (
 id TEXT PRIMARY KEY, secret_hash TEXT,
 redirect_uris TEXT NOT NULL CHECK(json_valid(redirect_uris)),
 post_logout_uris TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(post_logout_uris)),
 backchannel_uri TEXT, signup_policy TEXT NOT NULL DEFAULT 'invited' CHECK(signup_policy IN ('invited','open')),
 allowed_domains TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(allowed_domains)),
 branding TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(branding)),
 dev INTEGER NOT NULL DEFAULT 0 CHECK(dev IN (0,1))
);
CREATE TABLE auth_requests (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), redirect_uri TEXT NOT NULL,
 state TEXT NOT NULL, nonce TEXT NOT NULL, challenge TEXT NOT NULL, scope TEXT NOT NULL,
 browser_hash TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX auth_requests_expiry ON auth_requests(expires_at);
CREATE TABLE magic_links (
 hash TEXT PRIMARY KEY, email TEXT NOT NULL, request_id TEXT REFERENCES auth_requests(id) ON DELETE CASCADE,
 browser_hash TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX magic_links_expiry ON magic_links(expires_at);
CREATE TABLE oauth_states (
 hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, verifier TEXT NOT NULL,
 request_id TEXT NOT NULL REFERENCES auth_requests(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_states_expiry ON oauth_states(expires_at);
CREATE TABLE sessions (
 hash TEXT PRIMARY KEY, sid TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id),
 csrf_hash TEXT NOT NULL, method TEXT NOT NULL CHECK(method IN ('email','github')),
 auth_time INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE codes (
 hash TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), redirect_uri TEXT NOT NULL,
 challenge TEXT NOT NULL, nonce TEXT NOT NULL, scope TEXT NOT NULL,
 session_hash TEXT NOT NULL REFERENCES sessions(hash) ON DELETE CASCADE, expires_at INTEGER NOT NULL
);
CREATE INDEX codes_expiry ON codes(expires_at);
CREATE TABLE access_tokens (
 hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL REFERENCES sessions(hash) ON DELETE CASCADE,
 client_id TEXT NOT NULL REFERENCES clients(id), scope TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX access_tokens_expiry ON access_tokens(expires_at);
-- Tombstones distinguish a known replay from an unknown random code; retained for one day.
CREATE TABLE consumed_codes (hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE signing_keys (
 generation INTEGER PRIMARY KEY, kid TEXT NOT NULL UNIQUE, public_jwk TEXT NOT NULL,
 sealed_jwk TEXT NOT NULL, created_at INTEGER NOT NULL, activates_at INTEGER NOT NULL
);
CREATE TABLE invitations (
 client_id TEXT NOT NULL REFERENCES clients(id), email TEXT NOT NULL COLLATE NOCASE,
 expires_at INTEGER NOT NULL, PRIMARY KEY(client_id,email)
);
CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, actor TEXT, detail TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX rate_limits_expiry ON rate_limits(expires_at);
