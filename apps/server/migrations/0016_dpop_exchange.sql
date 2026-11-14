-- DPoP (RFC 9449) and token exchange (RFC 8693).
-- A grant whose first token was DPoP-bound stays bound to that key (thumbprint): every refresh needs a proof from it.
ALTER TABLE agent_grants ADD COLUMN dpop_jkt TEXT;
-- Proof jti values are single-use for their lifetime.
CREATE TABLE dpop_proofs (jti_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE INDEX dpop_proofs_expiry ON dpop_proofs(expires_at);
-- agent_dpop: optional or required for this app's agents. token_exchange_from: {"<client id>": ["scope", ...]}, the
-- apps allowed to exchange an agent's token for one to this app's resources, and the most scopes each may get.
ALTER TABLE clients ADD COLUMN agent_dpop TEXT NOT NULL DEFAULT 'optional' CHECK(agent_dpop IN ('optional','required'));
ALTER TABLE clients ADD COLUMN token_exchange_from TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(token_exchange_from) AND json_type(token_exchange_from)='object');
