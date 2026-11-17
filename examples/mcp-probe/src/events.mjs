// The back-channel URI: Imprim posts signed logout, revocation and user events here. Each is verified, then recorded
// once by its jti (delivery is at least once). Only identifiers are stored, never the token.
import { identity } from './config.mjs';

const MAX_BODY = 16384;

function row(event) {
    const c = event.claims;
    if (event.kind === 'revocation') return [c.jti, 'revocation', c.sub, c.grantId, c.resource, null];
    if (event.kind === 'logout') return [c.jti, 'logout', c.sub ?? null, null, null, JSON.stringify({ sid: c.sid ?? null })];
    return [c.jti, 'user', c.sub, null, null, JSON.stringify({ event: c.event, data: c.data, toe: c.toe })];
}

export async function backchannel(request, env, cfg, note) {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
    if ((request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded')
        return new Response(null, { status: 415 });
    const text = await request.text();
    if (text.length > MAX_BODY) return new Response(null, { status: 413 });
    let event;
    try { event = await identity(env, cfg).verifyBackchannel(new URLSearchParams(text)); }
    catch (error) {
        note.reject = error?.code || 'invalid_token';
        return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    note.kind = event.kind;
    if (event.kind === 'revocation') note.grant_id = event.claims.grantId;
    const written = await env.DB.prepare('INSERT INTO events(jti,kind,sub,grant_id,resource,detail,received_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(jti) DO NOTHING')
        .bind(...row(event), Date.now()).run();
    note.duplicate = written.meta.changes === 0;
    return new Response(null, { status: 204 });
}
