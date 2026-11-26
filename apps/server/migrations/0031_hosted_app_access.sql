ALTER TABLE clients ADD COLUMN listed INTEGER NOT NULL DEFAULT 1 CHECK(listed IN (0,1));
ALTER TABLE auth_requests ADD COLUMN workspace_access TEXT;
