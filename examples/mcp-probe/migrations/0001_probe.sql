-- The probe's own state: back-channel events it accepted, and DPoP proof ids it has seen.
-- No tokens are stored. sub and grant_id are opaque identifiers from verified events.
CREATE TABLE events(
    jti TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('logout','revocation','user')),
    sub TEXT,
    grant_id TEXT,
    resource TEXT,
    detail TEXT,
    received_at INTEGER NOT NULL
);
CREATE INDEX events_grant ON events(grant_id) WHERE grant_id IS NOT NULL;
CREATE TABLE dpop_seen(jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
