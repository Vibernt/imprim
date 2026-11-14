// Realm branding, editable by realm admins (the rest of a realm's config, which names secrets, stays platform-only),
// asset upload, and a preview of the sign-in page as an app would show it.
import { invariant } from '../lib/errors.mjs';
import { validateBranding, resolveBranding, assertContrast } from '../branding/tokens.mjs';
import { storeAsset, assetExists } from '../branding/assets.mjs';
import { forgetRealms } from '../realms/realm.mjs';
import { signInPage } from '../pages/sign-in.mjs';
import { auditStatement } from './auth.mjs';
export async function realmBranding(env) {
    const row = await env.DB.prepare('SELECT config,version FROM realms WHERE id=?').bind(env.REALM.id).first();
    return { branding: JSON.parse(row.config).branding || {}, version: row.version };
}
export async function saveRealmBranding(env, actor, input) {
    invariant(input && Number.isSafeInteger(input.version), 'invalid_request', 'branding and version are required.');
    const branding = validateBranding(input.branding);
    assertContrast(resolveBranding(branding));
    for (const key of ['logo_light', 'logo_dark', 'mark']) if (branding[key]) invariant(await assetExists(env, branding[key]), 'branding', `branding.${key} is not an uploaded asset.`);
    const row = await env.DB.prepare('SELECT config,version FROM realms WHERE id=?').bind(env.REALM.id).first();
    invariant(row.version === input.version, 'conflict', 'Branding changed; reload before editing.', 409);
    const config = { ...JSON.parse(row.config), branding };
    const [result] = await env.DB.batch([
        env.DB.prepare('UPDATE realms SET config=?,version=version+1 WHERE id=? AND version=?').bind(JSON.stringify(config), env.REALM.id, row.version),
        auditStatement(env, actor, 'admin_branding_update', env.REALM.id, { fields: Object.keys(branding) })]);
    invariant(result.meta.changes === 1, 'conflict', 'Branding changed; reload before editing.', 409);
    forgetRealms(env);
    return { branding, version: row.version + 1 };
}
export async function uploadAsset(env, actor, input) {
    invariant(input && typeof input.content_type === 'string' && typeof input.data === 'string' && input.data.length <= 360000, 'invalid_request', 'content_type and base64 data (at most 256 KiB) are required.');
    const stored = await storeAsset(env, input.content_type, input.data);
    await env.DB.batch([auditStatement(env, actor, 'admin_asset_upload', stored.id, { content_type: input.content_type })]);
    return stored;
}
// The sign-in page an app's users would see, without a live authorization request (its buttons do nothing).
export async function preview(env, clientId) {
    const client = clientId ? await env.DB.prepare('SELECT * FROM clients WHERE id=? AND realm_id=?').bind(clientId, env.REALM.id).first() : null;
    const response = signInPage(env, '', [], client);
    response.headers.set('x-robots-tag', 'noindex');
    return response;
}
