import { validateBranding } from '../branding/tokens.mjs';
import { invariant } from '../lib/errors.mjs';
import { validateSignInSettings } from '../oidc/sign-in-methods.mjs';
import { realmId } from '../realms/realm.mjs';
import { auditStatement } from './auth.mjs';
import { checkClientId, checkClientUris } from './client-basics.mjs';

export function clientDraft(env, id) {
    return env.DB.prepare('SELECT id,configuration FROM client_drafts WHERE realm_id=? AND id=?').bind(realmId(env), id).first();
}

export function draftClientView(row, defaults) {
    return { ...defaults, ...JSON.parse(row.configuration), id: row.id, version: 0, draft: true, confidential: false };
}

export async function createClientDraft(env, actor, input) {
    invariant(Object.keys(input).every(key => ['id', 'branding', 'redirect_uris', 'sign_in_methods'].includes(key)),
        'invalid_request', 'Unknown client draft field.');
    checkClientId(input.id);
    checkClientUris(input.redirect_uris, 'redirect_uris', 0);
    let methods;
    try { ({ methods } = validateSignInSettings(input.sign_in_methods)); }
    catch (error) {
        if (error.code !== 'client_config') throw error;
        invariant(false, 'invalid_request', 'Choose at least one distinct sign-in method.');
    }
    invariant(input.branding && typeof input.branding === 'object' && !Array.isArray(input.branding) && Object.keys(input.branding).length === 1 && typeof input.branding.name === 'string' && input.branding.name.trim(),
        'invalid_request', 'Enter a display name.');
    const branding = validateBranding({ name: input.branding.name.trim() }, { app: true });
    const configuration = JSON.stringify({ branding, redirect_uris: input.redirect_uris, sign_in_methods: methods });
    try {
        await env.DB.batch([
            env.DB.prepare('INSERT INTO client_drafts(id,realm_id,configuration) VALUES(?,?,?)').bind(input.id, realmId(env), configuration),
            auditStatement(env, actor, 'admin_client_draft_create', input.id, { fields: ['branding', 'redirect_uris', 'sign_in_methods'] })
        ]);
    } catch (error) {
        if (/client_id_reserved|UNIQUE constraint/.test(String(error.message))) invariant(false, 'conflict', 'Client ID already exists.', 409);
        throw error;
    }
    return { id: input.id };
}

export function claimDraft(env, draft) {
    return [
        env.DB.prepare('DELETE FROM client_drafts WHERE id=? AND realm_id=? AND configuration=?').bind(draft.id, realmId(env), draft.configuration),
        env.DB.prepare('INSERT INTO admin_assertions(ok) VALUES(changes()=1)')
    ];
}
