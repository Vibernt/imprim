ALTER TABLE logout_outbox ADD COLUMN last_error TEXT;
ALTER TABLE agent_revocation_outbox ADD COLUMN last_error TEXT;
CREATE INDEX logout_expiry ON logout_outbox(delivery_state,created,id);
CREATE INDEX agent_revocation_expiry ON agent_revocation_outbox(delivery_state,created,id);
