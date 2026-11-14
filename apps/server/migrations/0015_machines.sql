-- Machine identities: service clients act as themselves (no person) for one app, with keys, never shared secrets.
CREATE TABLE service_clients (
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 3 AND 60 AND id NOT GLOB '*[^a-z0-9-]*'),
 realm_id TEXT NOT NULL REFERENCES realms(id), app_id TEXT NOT NULL REFERENCES clients(id),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100), owner_email TEXT NOT NULL COLLATE NOCASE,
 jwks TEXT NOT NULL CHECK(json_valid(jwks)), scopes TEXT NOT NULL CHECK(json_valid(scopes) AND json_type(scopes)='array'),
 resource_prefixes TEXT NOT NULL CHECK(json_valid(resource_prefixes) AND json_type(resource_prefixes)='array'),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 created INTEGER NOT NULL, updated INTEGER NOT NULL, last_used INTEGER
);
CREATE INDEX service_clients_app ON service_clients(app_id);
