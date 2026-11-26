import { draftClientView } from './client-drafts.mjs';
import { invariant } from '../lib/errors.mjs';
import { realmId } from '../realms/realm.mjs';
import { json } from '../lib/http.mjs';
import { clientEditorDefaults, publicClient } from './clients.mjs';
import { clientDelivery } from './delivery.mjs';
import { listServices } from './services.mjs';
import { userDetail, users } from './users.mjs';
import { readAudit } from './audit-read.mjs';

const providerNames = env => Object.fromEntries(Object.entries(env.PROVIDERS || {}).map(([id, provider]) => [id, provider.name || id]));

async function clients(env, id, action, query) {
    if (id === 'editor' && action === 'defaults') return json({ defaults: clientEditorDefaults(), providers: providerNames(env) });
    if (action) return;
    const realm = realmId(env);
    if (id) {
        const [active, drafts] = await env.DB.batch([
            env.DB.prepare('SELECT * FROM clients WHERE id=? AND realm_id=?').bind(id, realm),
            env.DB.prepare('SELECT id,configuration FROM client_drafts WHERE id=? AND realm_id=?').bind(id, realm)
        ]);
        const row = active.results[0], draft = drafts.results[0];
        if (row) return json({ ...publicClient(row), delivery: await clientDelivery(env, id), providers: providerNames(env) });
        invariant(draft, 'not_found', 'Client not found.', 404);
        return json({ ...draftClientView(draft, clientEditorDefaults()), providers: providerNames(env) });
    }
    const activeClients = env.DB.prepare('SELECT * FROM clients WHERE realm_id=? ORDER BY id').bind(realm);
    if (query.get('include_drafts') !== '1') {
        const { results } = await activeClients.all();
        return json({ clients: results.map(publicClient) });
    }
    const [active, drafts] = await env.DB.batch([
        activeClients,
        env.DB.prepare('SELECT id,configuration FROM client_drafts WHERE realm_id=?').bind(realm)
    ]);
    const defaults = clientEditorDefaults();
    const entries = [...active.results.map(publicClient), ...drafts.results.map(draft => draftClientView(draft, defaults))];
    entries.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return json({ clients: entries });
}

export async function coreRead(env, section, id, action, query) {
    if (section === 'clients') return clients(env, id, action, query);
    if (section === 'audit') return readAudit(env, id, action, query);
    if (section === 'services' && !id && !action) return json({ services: await listServices(env) });
    if (section !== 'users') return;
    if (id && action === 'merge') {
        const source = await userDetail(env, id);
        const survivor = await userDetail(env, query.get('surviving_id') || '');
        return json({ source: { id: source.id, email: source.email }, survivor: { id: survivor.id, email: survivor.email } });
    }
    if (!action) return id ? json(await userDetail(env, id)) : json(await users(env, query));
}
