import { deliveryStatus, dispatchDeliveries } from '../services/outbox.mjs';
import { adminSession, adminMutation, mutationEnvironment, requirePlatform } from './auth.mjs';
import { realmId } from '../realms/realm.mjs';
import { listRealms, saveRealm, saveAdmin } from './realms.mjs';
import { listServices, saveService, deleteService } from './services.mjs';
import { realmBranding, saveRealmBranding, uploadAsset, preview } from './branding.mjs';
import { saveClient, getAdminClient, rotateSecret, publicClient } from './clients.mjs';
import { revokeSession } from './sessions.mjs';
import { users, userDetail, changeUser, resetMfa } from './users.mjs';
import { rotateNow, keyList, revokeKeyNow } from '../oidc/keys.mjs';
import { audit } from '../services/audit.mjs';
import { cookies, CSRF_COOKIE, getSession } from '../auth/session.mjs';
import { json, readBody, redirect } from '../lib/http.mjs';
import { invariant } from '../lib/errors.mjs';
import * as pages from './pages.mjs';
import { clientDelivery } from './delivery.mjs';
export async function admin(request, env, ctx) {
    const url = new URL(request.url), api = url.pathname.startsWith('/admin/api/');
    if (request.method === 'GET' && !api && !await getSession(request, env)) return redirect(env.ISSUER + '/login');
    let session;
    try { session = await adminSession(request, env); }
    catch (error) {
        // The console sends an admin without a fresh second factor to enrol or verify, then back.
        if (request.method === 'GET' && !api && ['mfa_enrolment_required', 'mfa_required'].includes(error.code))
            return redirect(`${env.ISSUER}${error.code === 'mfa_required' ? '/mfa' : '/account/mfa'}?next=${encodeURIComponent(url.pathname)}`);
        throw error;
    }
    const csrf = cookies(request)[CSRF_COOKIE] || '';
    let parts;
    try { parts = url.pathname.slice(api ? 11 : 7).split('/').filter(Boolean).map(decodeURIComponent); }
    catch { invariant(false, 'invalid_request', 'Malformed admin path encoding.'); }
    const [section = 'clients', id, action] = parts;
    invariant(parts.length <= 3, 'not_found', 'Admin endpoint not found.', 404);
    if (request.method === 'GET') {
        if (!api && section === 'users' && id && action === 'merge') {
            const source = await userDetail(env, id), survivor = await userDetail(env, url.searchParams.get('surviving_id') || '');
            return pages.mergeConfirmation(source, survivor, csrf);
        }
        if (section === 'clients' && !action) {
            if (id === 'new' && !api) return pages.clientEditor(null, csrf, true);
            if (id) {
                const value = await getAdminClient(env, id), delivery = await clientDelivery(env, id);
                return api ? json({ ...value, delivery }) : pages.clientEditor(value, csrf, false, delivery);
            }
            const rows = (await env.DB.prepare('SELECT * FROM clients WHERE realm_id=? ORDER BY id').bind(realmId(env)).all()).results.map(publicClient);
            return api ? json({ clients: rows }) : pages.clientList(rows);
        }
        if (section === 'users' && !action) {
            if (id) { const value = await userDetail(env, id); return api ? json(value) : pages.userPage(value, csrf); }
            const rows = await users(env, url.searchParams);
            return api ? json({ users: rows.slice(0,50), next: rows.length > 50 ? rows[49].id : null }) : pages.userList(rows, url.searchParams.get('q') || '');
        }
        // NDJSON export of this realm's audit log, 1,000 rows a page, oldest first; follow x-next-after.
        if (section === 'audit' && id === 'export' && api) {
            const after = url.searchParams.get('after') || '0';
            invariant(/^\d{1,19}$/.test(after), 'invalid_request', 'Invalid page cursor.');
            const rows = (await env.DB.prepare('SELECT id,event,actor,target,detail,created FROM audit WHERE realm_id=? AND id>? ORDER BY id LIMIT 1000').bind(realmId(env), after).all()).results;
            return new Response(rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), { headers: { 'content-type': 'application/x-ndjson',
                'cache-control': 'no-store', ...(rows.length === 1000 ? { 'x-next-after': String(rows.at(-1).id) } : {}) } });
        }
        if (section === 'audit' && !id) {
            const before = url.searchParams.get('before') || '9223372036854775807';
            invariant(/^\d{1,19}$/.test(before), 'invalid_request', 'Invalid page cursor.');
            const actor = url.searchParams.get('actor') || '', target = url.searchParams.get('target') || '';
            const rows = (await env.DB.prepare(`SELECT * FROM audit WHERE realm_id=? AND id<? AND (?='' OR actor=?) AND (?='' OR target=?) ORDER BY id DESC LIMIT 51`)
                .bind(realmId(env), before, actor, actor, target, target).all()).results;
            return api ? json({ audit: rows.slice(0,50), next: rows.length > 50 ? rows[49].id : null }) : pages.auditPage(rows, url.searchParams);
        }
        if (section === 'branding' && id === 'preview') return preview(env, url.searchParams.get('client'));
        if (section === 'branding' && !id) { const value = await realmBranding(env); return api ? json(value) : pages.brandingPage(value, csrf); }
        if (section === 'services' && !id) { const rows = await listServices(env); return api ? json({ services: rows }) : pages.servicesPage(rows); }
        if (section === 'realms' && !id) { requirePlatform(session); const rows = await listRealms(env); return api ? json({ realms: rows }) : pages.realmsPage(rows, csrf); }
        if (section === 'keys' && !id) { requirePlatform(session); const rows = await keyList(env); return api ? json({ keys: rows }) : pages.keysPage(rows, csrf); }
        if (section === 'settings' && !id) {
            const settings = { realm: env.REALM, role: session.role, turnstile: Boolean(env.TURNSTILE_SITE_KEY) && Boolean(env.TURNSTILE_SECRET) ? 'on' : !env.TURNSTILE_SITE_KEY && !env.TURNSTILE_SECRET ? 'off' : 'misconfigured',
                delivery: await deliveryStatus(env),
                rate_limits: 'Deployment bindings AUTH_LIMITER and API_LIMITER; fixed per-email/IP budgets in source. Not editable at runtime.' };
            return api ? json(settings) : pages.settingsPage(settings);
        }
    }
    if (request.method === 'POST') {
        // A logo upload carries up to 256 KiB as base64; every other admin body keeps the 16 KiB bound.
        const body = await readBody(request, api ? 'json' : 'form', section === 'branding' && id === 'assets' ? 360000 : undefined);
        // Every write is destructive: a client edit changes redirect URIs, back-channel and agent policy (S14).
        const destructive = true;
        await adminMutation(request, env, session, body, destructive);
        const writeEnv = mutationEnvironment(env, session, destructive);
        delete body.csrf;
        let result;
        if (section === 'clients' && !action) {
            if (!api) {
                try {
                    for (const field of ['redirect_uris','post_logout_uris','allowed_domains','branding','sign_in_methods','google_hosted_domains','token_exchange_from',
                        'agent_registration_methods','agent_allowlist','agent_scope_catalogue','agent_resource_prefixes']) if (body[field] !== undefined) body[field] = JSON.parse(body[field]);
                    for (const field of ['dev','agent_max_grant_days','version','mfa_trusted_device_days']) if (body[field] !== undefined) body[field] = Number(body[field]);
                } catch { invariant(false, 'invalid_request', 'List and branding fields must contain valid JSON.'); }
            }
            result = await saveClient(writeEnv, session.user_id, id, body);
            ctx.waitUntil(dispatchDeliveries(env).catch(() => audit(env, 'admin_dispatch_failed', session.user_id, { pending: true })));
        } else if (section === 'clients' && id && action === 'rotate-secret') {
            if (!api && body.make_confidential === 'true') body.make_confidential = true;
            result = await rotateSecret(writeEnv, session.user_id, id, body);
        }
        else if (section === 'users' && id && ['block','unblock','delete','merge','revoke-session','reset-mfa'].includes(action)) {
            result = action === 'revoke-session' ? await revokeSession(writeEnv, session.user_id, id, body.sid) :
                action === 'reset-mfa' ? await resetMfa(writeEnv, session.user_id, id, body.reason) :
                await changeUser(writeEnv, session.user_id, id, action, body.surviving_id, body.confirm_source_email);
            if (action !== 'unblock') result.delivery = { state: 'pending', message: 'Access revoked locally; outbox delivery is asynchronous. See Settings for outstanding events.' };
            ctx.waitUntil(dispatchDeliveries(env).catch(() => audit(env, 'admin_dispatch_failed', session.user_id, { pending: true })));
        } else if (section === 'keys' && id === 'rotate' && !action) { requirePlatform(session); result = await rotateNow(writeEnv, session.user_id); }
        else if (section === 'keys' && id && action === 'revoke') { requirePlatform(session); result = await revokeKeyNow(writeEnv, session.user_id, id); }
        else if (section === 'services' && action === 'delete' && id) result = await deleteService(writeEnv, session.user_id, id);
        else if (section === 'branding' && id === 'assets') result = await uploadAsset(writeEnv, session.user_id, body);
        else if (section === 'branding' && !id) {
            if (!api) { try { body.branding = JSON.parse(body.branding); body.version = Number(body.version); } catch { invariant(false, 'invalid_request', 'branding must be JSON.'); } }
            result = await saveRealmBranding(writeEnv, session.user_id, body);
        }
        else if (section === 'services' && !action) {
            if (!api) { try { for (const field of ['jwks', 'scopes', 'resource_prefixes']) if (typeof body[field] === 'string') body[field] = JSON.parse(body[field]); } catch { invariant(false, 'invalid_request', 'jwks, scopes and resource_prefixes must be JSON.'); } }
            result = await saveService(writeEnv, session.user_id, id, body);
        }
        else if (section === 'realms' && !action) {
            requirePlatform(session);
            if (!api && typeof body.config === 'string') { try { body.config = JSON.parse(body.config); } catch { invariant(false, 'invalid_request', 'config must be JSON.'); } }
            if (!api && body.version !== undefined) body.version = Number(body.version);
            result = await saveRealm(writeEnv, session.user_id, id, body);
        } else if (section === 'realms' && id && action === 'admins') { requirePlatform(session); result = await saveAdmin(writeEnv, session.user_id, id, body); }
        if (result) return api ? json(result) : pages.resultPage(result);
    }
    invariant(false, 'not_found', 'Admin endpoint not found.', 404);
}
