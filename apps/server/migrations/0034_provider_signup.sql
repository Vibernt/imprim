-- Existing OAuth starts are sign-in only. Provider metadata on links and requests
-- records an identity to link after mailbox proof, never a provider credential.
ALTER TABLE oauth_states ADD COLUMN purpose TEXT NOT NULL DEFAULT 'sign_in'
    CHECK (purpose IN ('sign_in','signup'));
ALTER TABLE oauth_states ADD COLUMN workspace_name TEXT;

ALTER TABLE magic_links ADD COLUMN provider TEXT;
ALTER TABLE magic_links ADD COLUMN provider_id TEXT;
ALTER TABLE magic_links ADD COLUMN provider_login TEXT CHECK (
    (provider IS NULL AND provider_id IS NULL AND provider_login IS NULL)
    OR (provider IS NOT NULL AND provider IN ('google','github') AND provider_id IS NOT NULL AND length(provider_id)>0)
);

ALTER TABLE signup_requests ADD COLUMN provider TEXT;
ALTER TABLE signup_requests ADD COLUMN provider_id TEXT;
ALTER TABLE signup_requests ADD COLUMN provider_login TEXT CHECK (
    (provider IS NULL AND provider_id IS NULL AND provider_login IS NULL)
    OR (provider IS NOT NULL AND provider IN ('google','github') AND provider_id IS NOT NULL AND length(provider_id)>0)
);
