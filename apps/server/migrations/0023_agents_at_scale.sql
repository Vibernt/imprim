-- Agents at scale. Each app has a budget of agent token requests per agent per minute; grants record the assurance
-- the consent page showed, which tokens then carry; the grants API pages through a resource's grants.
ALTER TABLE clients ADD COLUMN agent_token_rate INTEGER NOT NULL DEFAULT 3000 CHECK(typeof(agent_token_rate)='integer' AND agent_token_rate BETWEEN 10 AND 100000);
ALTER TABLE agent_grants ADD COLUMN assurance TEXT CHECK(assurance IS NULL OR assurance IN ('key','redirect','claimed','none'));
CREATE INDEX agent_grants_app_page ON agent_grants(app_id, resource, created, id);
CREATE INDEX agent_grants_client_live ON agent_grants(client_id, revoked_at, expires_at);
