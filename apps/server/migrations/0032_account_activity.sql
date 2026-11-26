ALTER TABLE client_admissions ADD COLUMN last_signed_in INTEGER;
UPDATE client_admissions AS a SET last_signed_in=(
    SELECT max(s.created) FROM app_sessions s WHERE s.user_id=a.user_id AND s.client_id=a.client_id
);
CREATE INDEX agent_revocations_grant ON agent_revocation_outbox(grant_id,created);
