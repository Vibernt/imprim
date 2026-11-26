ALTER TABLE clients ADD COLUMN agent_workspace_resources TEXT NOT NULL DEFAULT '[]'
    CHECK(json_valid(agent_workspace_resources) AND json_type(agent_workspace_resources)='array');
ALTER TABLE agent_grants ADD COLUMN workspace_id TEXT REFERENCES workspaces(id);
CREATE INDEX agent_grants_workspace ON agent_grants(workspace_id);
ALTER TABLE workspace_resources ADD COLUMN name TEXT CHECK(name IS NULL OR length(name) BETWEEN 1 AND 80);

-- Enforce the two registration modes even when app settings and resource writes race,
-- including client settings applied through offline seed SQL.
CREATE TRIGGER client_choice_resources_insert BEFORE INSERT ON clients
WHEN EXISTS(SELECT 1 FROM json_each(NEW.agent_workspace_resources) choice
    JOIN workspace_resources wr ON wr.resource=choice.value)
BEGIN SELECT RAISE(ABORT, 'agent_workspace_resource_registered'); END;

CREATE TRIGGER client_choice_resources_update BEFORE UPDATE OF agent_workspace_resources ON clients
WHEN EXISTS(SELECT 1 FROM json_each(NEW.agent_workspace_resources) choice
    JOIN workspace_resources wr ON wr.resource=choice.value)
BEGIN SELECT RAISE(ABORT, 'agent_workspace_resource_registered'); END;

CREATE TRIGGER workspace_resource_choice_insert BEFORE INSERT ON workspace_resources
WHEN EXISTS(SELECT 1 FROM clients c,json_each(c.agent_workspace_resources) choice WHERE choice.value=NEW.resource)
BEGIN SELECT RAISE(ABORT, 'agent_workspace_resource_registered'); END;

CREATE TRIGGER workspace_resource_choice_update BEFORE UPDATE OF resource ON workspace_resources
WHEN EXISTS(SELECT 1 FROM clients c,json_each(c.agent_workspace_resources) choice WHERE choice.value=NEW.resource)
BEGIN SELECT RAISE(ABORT, 'agent_workspace_resource_registered'); END;
