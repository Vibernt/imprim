import { readJson, requireCsrf } from '../api/json.mjs';
import { webRequest, serveWeb } from '../web/serve.mjs';
import { deliveryStatus, dispatchDeliveries } from '../services/outbox.mjs';
import { adminSession, adminMutation, mutationEnvironment, requirePlatform, requireAdminFresh } from './auth.mjs';
import { listRealms, saveRealm, saveAdmin } from './realms.mjs';
import { saveService, deleteService } from './services.mjs';
import { realmBranding, saveRealmBranding, uploadAsset, preview } from './branding.mjs';
import { saveClient, rotateSecret } from './clients.mjs';
import { revokeSession } from './sessions.mjs';
import { changeUser, resetMfa } from './users.mjs';
import { rotateNow, keyList, revokeKeyNow } from '../oidc/keys.mjs';
import { audit } from '../services/audit.mjs';
import { getSession } from '../auth/session.mjs';
import { json, readBody, redirect } from '../lib/http.mjs';
import { invariant, AppError } from '../lib/errors.mjs';
import * as pages from './pages.mjs';
import { coreRead } from './core-read.mjs';
import { adminParts } from './path.mjs';
import { workspaceApi, workspaceFormPost } from './workspaces/api.mjs';
import { sampleEmail } from './branding-email.mjs';
import { newPath as newWorkspacePath } from './workspaces/read.mjs';
import { clientFromForm } from './client-form.mjs';
import { decideSignupRequest, listSignupRequests } from './signups.mjs';
// A form the console posted and the server refused: the console says why, in place. Scripts and the admin API (which
// do not ask for HTML) still get the JSON error from the worker.
export async function admin(request, env, ctx) {
    try { return await handle(request, env, ctx); }
    catch (error) {
        const path = new URL(request.url).pathname;
        if (!(error instanceof AppError) || request.method !== 'POST' || path.startsWith('/admin/api/') || !request.headers.get('accept')?.includes('text/html') || !env.SEEN?.role) throw error;
        // Return to the page the form was on.
        const [section = 'clients', id] = path.slice(7).split('/').filter(Boolean);
        let back = `/admin/${section}`;
        if (section === 'clients' && !id) back = '/admin/clients/new';
        if (section === 'workspaces' && !id) back = newWorkspacePath;
        if (id && ['clients', 'users', 'workspaces'].includes(section)) back += '/' + id;
        return pages.failedPage(error.message, error.status, back, section);
    }
}
async function handle(request, env, ctx) {
    const url = new URL(request.url), api = url.pathname.startsWith('/admin/api/');
    if (!api && webRequest(request, url.pathname)) return serveWeb(request, env, url);
    if (request.method === 'GET' && !api && !await getSession(request, env)) return redirect(env.ISSUER + '/login');
    let session;
    try { session = await adminSession(request, env, api); }
    catch (error) {
        // The console sends an admin without a fresh second factor to enrol or verify, then back.
        if (request.method === 'GET' && !api && ['mfa_enrolment_required', 'mfa_required'].includes(error.code))
            return redirect(`${env.ISSUER}${error.code === 'mfa_required' ? '/mfa' : '/account/mfa'}?next=${encodeURIComponent(url.pathname)}`);
        throw error;
    }
    const [section = 'clients', id, action] = adminParts(url.pathname, api);
    if (request.method === 'GET') {
        if (section === 'branding' && id === 'preview' && !action) return preview(env, url.searchParams.get('client'));
        if (!api && section === 'branding' && id === 'email-preview' && !action) return sampleEmail(env);
        if (api) {
            if (section === 'workspaces') return workspaceApi(request, env, ctx, session, id, action, url.searchParams);
            if (section === 'signups' && !id) return json(await listSignupRequests(env, url.searchParams));
            const response = await coreRead(env, section, id, action, url.searchParams);
            if (response) return response;
            if (section === 'branding' && !id) return json(await realmBranding(env));
            if (section === 'realms' && !id) { requirePlatform(session); return json({ realms: await listRealms(env) }); }
            if (section === 'keys' && !id) { requirePlatform(session); return json({ keys: await keyList(env) }); }
            if (section === 'settings' && !id) {
                const settings = { realm: env.REALM, role: session.role, turnstile: Boolean(env.TURNSTILE_SITE_KEY) && Boolean(env.TURNSTILE_SECRET) ? 'on' : !env.TURNSTILE_SITE_KEY && !env.TURNSTILE_SECRET ? 'off' : 'misconfigured',
                    delivery: await deliveryStatus(env),
                    rate_limits: 'Deployment bindings AUTH_LIMITER and API_LIMITER; fixed per-email/IP budgets in source. Not editable at runtime.' };
                return json(settings);
            }
        }
    }
    if (request.method === 'POST') {
        if (api && section === 'workspaces') return workspaceApi(request, env, ctx, session, id, action, url.searchParams);
        // A logo upload carries up to 256 KiB as base64; every other admin body keeps the 16 KiB bound.
        const limit = section === 'branding' && id === 'assets' ? 360000 : undefined;
        if (api) await requireCsrf(request, env, session);
        const body = api ? await readJson(request, limit) : await readBody(request, 'form', limit);
        // Every write is destructive: a client edit changes redirect URIs, back-channel and agent policy (S14).
        const destructive = true;
        if (api) requireAdminFresh(session);
        else await adminMutation(request, env, session, body, destructive);
        delete body.csrf;
        if (!api && section === 'workspaces') return workspaceFormPost(request, env, ctx, session, id, action, body);
        const writeEnv = mutationEnvironment(env, session, destructive);
        if (api && section === 'signups' && id && ['approve', 'decline'].includes(action))
            return json(await decideSignupRequest(writeEnv, ctx, session.user_id, id, action, body));
        let result;
        if (section === 'clients' && !action) {
            result = await saveClient(writeEnv, session.user_id, id, api ? body : clientFromForm(body));
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
        else if (section === 'branding' && id === 'assets' && !action) result = await uploadAsset(writeEnv, session.user_id, body);
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
