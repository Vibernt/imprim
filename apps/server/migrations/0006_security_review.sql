-- Fence stale console/API edits, including secret/authentication-type changes.
ALTER TABLE clients ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE logout_outbox ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE agent_revocation_outbox ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'pending';
UPDATE logout_outbox SET delivery_state='delivered' WHERE delivered_at IS NOT NULL;
UPDATE agent_revocation_outbox SET delivery_state='delivered' WHERE delivered_at IS NOT NULL;
CREATE INDEX logout_retention ON logout_outbox(delivered_at,id);
CREATE INDEX agent_revocation_retention ON agent_revocation_outbox(delivered_at,id);
