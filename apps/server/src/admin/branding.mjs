// Realm branding, editable by realm admins (the rest of a realm's config, which names secrets, stays platform-only),
// asset upload, and a preview of the sign-in page as an app would show it.
import { invariant } from '../lib/errors.mjs';
import { validateBranding, resolveBranding, assertContrast } from '../branding/tokens.mjs';
import { prepareAsset, storeStatement, assetExists } from '../branding/assets.mjs';
import { forgetRealms } from '../realms/realm.mjs';
import { signInPage } from '../pages/sign-in.mjs';
import { auditStatement } from './auth.mjs';
export const ASSET_FIELDS = ['logo_light', 'logo_dark', 'mark'];
export async function realmBranding(env) {
    const row = await env.DB.prepare('SELECT config,version FROM realms WHERE id=?').bind(env.REALM.id).first();
    return { branding: JSON.parse(row.config).branding || {}, version: row.version };
}
// A realm's branding is valid when its own theme meets contrast, its assets are that realm's, and every app's
// override still meets contrast once merged over it, so a realm change can never leave an app failing.
export async function checkRealmBranding(env, realm, value) {
    const branding = validateBranding(value);
    assertContrast(resolveBranding(branding));
    for (const key of ASSET_FIELDS) if (branding[key]) invariant(await assetExists(env, branding[key], realm), 'branding', `branding.${key} is not an uploaded asset of this realm.`);
    const { results } = await env.DB.prepare('SELECT id,branding FROM clients WHERE realm_id=?').bind(realm).all();
    const failing = results.filter(client => { try { assertContrast(resolveBranding(branding, JSON.parse(client.branding || '{}'))); return false; } catch { return true; } });
    invariant(!failing.length, 'branding_contrast', `These apps would fail WCAG AA contrast with this branding; change their themes first: ${failing.map(client => client.id).join(', ')}.`, 400);
    return branding;
}
export const realmVersionGuard = (env, realm, version) => env.DB.prepare(`INSERT INTO admin_assertions(ok) SELECT CASE WHEN EXISTS(
    SELECT 1 FROM realms WHERE id=? AND version=?) THEN 1 ELSE 0 END`).bind(realm, version);
export async function saveRealmBranding(env, actor, input) {
    invariant(input && Number.isSafeInteger(input.version), 'invalid_request', 'branding and version are required.');
    const branding = await checkRealmBranding(env, env.REALM.id, input.branding);
    const row = await env.DB.prepare('SELECT config,version FROM realms WHERE id=?').bind(env.REALM.id).first();
    invariant(row.version === input.version, 'conflict', 'Branding changed; reload before editing.', 409);
    const config = { ...JSON.parse(row.config), branding };
    // The guard fails the whole batch, audit included, if another admin saved first.
    await env.DB.batch([realmVersionGuard(env, env.REALM.id, row.version),
        env.DB.prepare('UPDATE realms SET config=?,version=version+1 WHERE id=? AND version=?').bind(JSON.stringify(config), env.REALM.id, row.version),
        auditStatement(env, actor, 'admin_branding_update', env.REALM.id, { fields: Object.keys(branding) })]);
    forgetRealms(env);
    return { branding, version: row.version + 1 };
}
export async function uploadAsset(env, actor, input) {
    invariant(input && Object.keys(input).every(key => ['content_type', 'data'].includes(key)) && typeof input.content_type === 'string' && typeof input.data === 'string' && input.data.length <= 349528,
        'invalid_request', 'content_type and base64 data (at most 256 KiB) are required.');
    const asset = await prepareAsset(input.content_type, input.data);
    await env.DB.batch([storeStatement(env, asset), auditStatement(env, actor, 'admin_asset_upload', asset.id, { content_type: asset.contentType })]);
    return { id: asset.id, url: asset.url };
}
// The sign-in page an app's users would see, without a live authorization request (its buttons do nothing).
export async function preview(env, clientId) {
    const client = clientId ? await env.DB.prepare('SELECT * FROM clients WHERE id=? AND realm_id=?').bind(clientId, env.REALM.id).first() : null;
    const response = signInPage(env, '', [], client);
    response.headers.set('x-robots-tag', 'noindex');
    return response;
}
