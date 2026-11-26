ALTER TABLE agent_grants ADD COLUMN label TEXT CHECK(label IS NULL OR length(label) BETWEEN 1 AND 60);
ALTER TABLE agent_grants ADD COLUMN approved_device TEXT;
ALTER TABLE agent_grants ADD COLUMN approved_location TEXT;

-- Single-grant revocations record the same reason in audit and the outbox.
ALTER TABLE agent_revocation_outbox ADD COLUMN reason TEXT;
