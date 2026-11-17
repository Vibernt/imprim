-- Languages. The languages an authorization request asked for (OIDC ui_locales, sanitized), and the language a person
-- chose on their account page. Both are optional: no value means automatic.
ALTER TABLE auth_requests ADD COLUMN ui_locales TEXT;
ALTER TABLE users ADD COLUMN locale TEXT;
