-- Classic OpenID Connect, per app and off by default: a confidential app may leave out PKCE and the nonce, as OpenID
-- Connect clients written before OAuth 2.1 do. An empty challenge or nonce in auth_requests and codes means "not sent".
ALTER TABLE clients ADD COLUMN classic_oidc TEXT NOT NULL DEFAULT 'off' CHECK(classic_oidc IN ('off','on'));
-- The person an authorization request's id_token_hint named. Whoever finishes the sign-in must be that person.
ALTER TABLE auth_requests ADD COLUMN hint_sub TEXT;
