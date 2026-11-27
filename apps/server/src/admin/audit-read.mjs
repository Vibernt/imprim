import { realmId } from '../realms/realm.mjs';
import { invariant } from '../lib/errors.mjs';
import { json } from '../lib/http.mjs';

const cursor = (value, initial) => {
    const id = value || initial;
    invariant(/^\d{1,19}$/.test(id), 'invalid_request', 'Invalid page cursor.');
    return id;
};

function day(query, key) {
    const value = query.get(key);
    if (value === null) return null;
    const ms = Date.parse(value + 'T00:00:00Z');
    invariant(/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(ms) && new Date(ms).toISOString().startsWith(value + 'T'),
        'invalid_request', 'Use a valid UTC date (YYYY-MM-DD) for ' + key + '.');
    return ms;
}

async function exportAudit(env, query) {
    const after = cursor(query.get('after'), '0');
    const { results: rows } = await env.DB.prepare('SELECT id,event,actor,target,detail,created FROM audit WHERE realm_id=? AND id>? ORDER BY id LIMIT 1000')
        .bind(realmId(env), after).all();
    return new Response(rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), {
        headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store',
            ...(rows.length === 1000 ? { 'x-next-after': String(rows.at(-1).id) } : {}) }
    });
}

export async function readAudit(env, id, action, query) {
    if (action || (id && id !== 'export')) return;
    if (id === 'export') return exportAudit(env, query);

    const before = cursor(query.get('before'), '9223372036854775807');
    const from = day(query, 'from'), to = day(query, 'to');
    invariant(from === null || to === null || from <= to, 'invalid_request', 'The start date must come before or equal the end date.');
    const event = query.get('event');
    invariant(event === null || /^[a-zA-Z0-9_.-]{1,100}$/.test(event), 'invalid_request', 'Invalid audit event type.');
    const filters = ['a.realm_id=?', 'a.id<?'], args = [realmId(env), before];
    for (const [condition, value] of [
        ['a.actor=?', query.get('actor') || null], ['a.target=?', query.get('target') || null],
        ['a.event=?', event], ['a.created>=?', from], ['a.created<?', to === null ? null : to + 86_400_000]
    ]) {
        if (value === null) continue;
        filters.push(condition);
        args.push(value);
    }
    // These audit events use client IDs. Their labels must not come from an imported user with the same ID.
    const clientActors = `a.event IN ('code_replay','invitation_registered','machine_client_requested','workspace_resource_named') OR
        (a.event LIKE 'workspace-%' AND coalesce(a.actor=CASE WHEN json_valid(a.detail)
            THEN json_extract(a.detail,'$.client_id') END, 0))`;
    const clientTargets = `a.event IN ('admin_client_create','admin_client_draft_create','admin_client_activate',
        'admin_client_update','admin_client_secret_rotate','backchannel_expired','invitation_registered','invitation_revoked','sign_in_refused')`;
    const serviceTargets = "a.event IN ('admin_service_create','admin_service_update','admin_service_delete','machine_client_disabled','machine_client_renewed')";
    const { results: rows } = await env.DB.prepare(`SELECT a.*,
        coalesce(u.email,nullif(json_extract(c.branding,'$.name'),'')) AS actor_label,
        coalesce(t.email,nullif(json_extract(d.branding,'$.name'),''),nullif(json_extract(f.configuration,'$.branding.name'),''),s.name) AS target_label
        FROM audit a
        LEFT JOIN users u ON u.realm_id=a.realm_id AND u.id=a.actor AND NOT (${clientActors})
        LEFT JOIN clients c ON c.realm_id=a.realm_id AND c.id=a.actor AND u.id IS NULL
        LEFT JOIN users t ON t.realm_id=a.realm_id AND t.id=a.target AND a.event IN
            ('admin_sign_in','admin_block','admin_unblock','admin_delete','admin_merge','admin_mfa_reset','admin_revoke_session','account_deleted','mailbox_claimed')
        LEFT JOIN clients d ON d.realm_id=a.realm_id AND d.id=a.target AND (${clientTargets})
        LEFT JOIN client_drafts f ON f.realm_id=a.realm_id AND f.id=a.target AND a.event='admin_client_draft_create'
        LEFT JOIN service_clients s ON s.realm_id=a.realm_id AND s.id=a.target AND (${serviceTargets})
        WHERE ${filters.join(' AND ')} ORDER BY a.id DESC LIMIT 51`).bind(...args).all();
    return json({ audit: rows.slice(0, 50), next: rows.length > 50 ? rows[49].id : null });
}
