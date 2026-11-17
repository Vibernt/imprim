-- RS256 ID tokens. Each realm gets a second signing ring, so keys carry their algorithm and generations are per ring.
-- Every existing key is ES256 and keeps its generation, kid and windows.
CREATE TABLE keys_copy AS SELECT * FROM signing_keys;
DROP TABLE signing_keys;
CREATE TABLE signing_keys (
 realm_id TEXT NOT NULL DEFAULT 'default' REFERENCES realms(id), alg TEXT NOT NULL DEFAULT 'ES256' CHECK(alg IN ('ES256','RS256')),
 generation INTEGER NOT NULL, kid TEXT NOT NULL UNIQUE, public_jwk TEXT NOT NULL, sealed_jwk TEXT NOT NULL, created_at INTEGER NOT NULL,
 activates_at INTEGER NOT NULL, retired_at INTEGER, verification_until INTEGER,
 PRIMARY KEY(realm_id, alg, generation)
);
INSERT INTO signing_keys(realm_id, alg, generation, kid, public_jwk, sealed_jwk, created_at, activates_at, retired_at, verification_until)
 SELECT realm_id, 'ES256', generation, kid, public_jwk, sealed_jwk, created_at, activates_at, retired_at, verification_until FROM keys_copy;
DROP TABLE keys_copy;
-- Which ring signs an app's ID tokens and logout tokens. ES256 unless the app's library needs RS256.
ALTER TABLE clients ADD COLUMN id_token_signed_response_alg TEXT NOT NULL DEFAULT 'ES256' CHECK(id_token_signed_response_alg IN ('ES256','RS256'));
