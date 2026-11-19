import { realmId } from '../realms/realm.mjs';
import { invariant } from '../lib/errors.mjs';
import { json } from '../lib/http.mjs';
import { clientEditorDefaults, getAdminClient, publicClient } from './clients.mjs';
import { clientDelivery } from './delivery.mjs';
import { listServices } from './services.mjs';
import { userDetail, users } from './users.mjs';

const page = (key, rows) => json({ [key]: rows.slice(0, 50), next: rows.length > 50 ? rows[49].id : null });
const providerNames = env => Object.fromEntries(Object.entries(env.PROVIDERS || {}).map(([id, provider]) => [id, provider.name || id]));

async function clients(env, id, action) {
    if (id === 'editor' && action === 'defaults') return json({ defaults: clientEditorDefaults(), providers: providerNames(env) });
    if (action) return;
    if (id) {
        const value = await getAdminClient(env, id);
        return json({ ...value, delivery: await clientDelivery(env, id), providers: providerNames(env) });
    }
    const rows = (await env.DB.prepare('SELECT * FROM clients WHERE realm_id=? ORDER BY id').bind(realmId(env)).all()).results;
    return json({ clients: rows.map(publicClient) });
}

async function audit(env, id, action, query) {
    if (action) return;
    if (id === 'export') {
        // NDJSON export, 1,000 rows a page, oldest first. Follow x-next-after.
        const after = query.get('after') || '0';
        invariant(/^\d{1,19}$/.test(after), 'invalid_request', 'Invalid page cursor.');
        const rows = (await env.DB.prepare('SELECT id,event,actor,target,detail,created FROM audit WHERE realm_id=? AND id>? ORDER BY id LIMIT 1000').bind(realmId(env), after).all()).results;
        return new Response(rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), {
            headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store',
                ...(rows.length === 1000 ? { 'x-next-after': String(rows.at(-1).id) } : {}) }
        });
    }
    if (id) return;
    const before = query.get('before') || '9223372036854775807';
    invariant(/^\d{1,19}$/.test(before), 'invalid_request', 'Invalid page cursor.');
    const actor = query.get('actor') || '', target = query.get('target') || '';
    const rows = (await env.DB.prepare(`SELECT * FROM audit WHERE realm_id=? AND id<? AND (?='' OR actor=?) AND (?='' OR target=?) ORDER BY id DESC LIMIT 51`)
        .bind(realmId(env), before, actor, actor, target, target).all()).results;
    return page('audit', rows);
}

export async function coreRead(env, section, id, action, query) {
    if (section === 'clients') return clients(env, id, action);
    if (section === 'audit') return audit(env, id, action, query);
    if (section === 'services' && !id && !action) return json({ services: await listServices(env) });
    if (section !== 'users') return;
    if (id && action === 'merge') {
        const source = await userDetail(env, id);
        const survivor = await userDetail(env, query.get('surviving_id') || '');
        return json({ source: { id: source.id, email: source.email }, survivor: { id: survivor.id, email: survivor.email } });
    }
    if (!action) return id ? json(await userDetail(env, id)) : page('users', await users(env, query));
}
