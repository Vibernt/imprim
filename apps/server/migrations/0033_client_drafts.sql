-- Drafts reserve a client ID but do not participate in any live client lookup.
CREATE TABLE client_drafts (
 id TEXT PRIMARY KEY,
 realm_id TEXT NOT NULL REFERENCES realms(id),
 configuration TEXT NOT NULL CHECK(json_valid(configuration))
);
CREATE INDEX client_drafts_realm ON client_drafts(realm_id, id);
CREATE TRIGGER draft_client_id_reserved BEFORE INSERT ON client_drafts
 WHEN EXISTS (SELECT 1 FROM clients WHERE id=NEW.id)
 BEGIN SELECT RAISE(ABORT, 'client_id_reserved'); END;
CREATE TRIGGER active_client_id_reserved BEFORE INSERT ON clients
 WHEN EXISTS (SELECT 1 FROM client_drafts WHERE id=NEW.id)
 BEGIN SELECT RAISE(ABORT, 'client_id_reserved'); END;
