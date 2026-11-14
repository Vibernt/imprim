-- Brand assets (logos and marks), content-addressed by SHA-256 and served from the identity host, so pages keep
-- img-src 'self'. Small by design (256 KiB each).
CREATE TABLE brand_assets (
 id TEXT NOT NULL CHECK(length(id)=64), realm_id TEXT NOT NULL REFERENCES realms(id),
 content_type TEXT NOT NULL CHECK(content_type IN ('image/svg+xml','image/png','image/jpeg','image/webp')),
 data BLOB NOT NULL CHECK(length(data) <= 262144), created INTEGER NOT NULL, PRIMARY KEY(realm_id, id)
);
