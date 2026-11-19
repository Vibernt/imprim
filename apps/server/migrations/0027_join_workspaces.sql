ALTER TABLE clients ADD COLUMN join_workspaces TEXT NOT NULL DEFAULT 'off' CHECK (join_workspaces IN ('off','on'));

-- The browser-bound request carries the offered product, person and workspace IDs until the step is answered.
ALTER TABLE auth_requests ADD COLUMN workspace_join TEXT;
