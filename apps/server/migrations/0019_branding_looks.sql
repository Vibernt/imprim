-- Branding moved from colour tokens (theme, theme_dark) to a Fire look (branding.look). The old keys are no longer
-- valid and would refuse every later save, so they are removed. Nothing else in branding changes.
UPDATE realms SET config = json_remove(config, '$.branding.theme', '$.branding.theme_dark')
 WHERE json_valid(config) AND (json_type(config, '$.branding.theme') IS NOT NULL OR json_type(config, '$.branding.theme_dark') IS NOT NULL);
UPDATE clients SET branding = json_remove(branding, '$.theme', '$.theme_dark')
 WHERE json_valid(branding) AND (json_type(branding, '$.theme') IS NOT NULL OR json_type(branding, '$.theme_dark') IS NOT NULL);
