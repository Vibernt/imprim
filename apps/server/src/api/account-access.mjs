import { readConnectedAgents, revokeConnectedAgent } from '../agents/account.mjs';
import { endSessions, endAppSessions, forgetBrowser, readSessions } from '../account/sessions.mjs';
import { json, uniqueParams } from '../lib/http.mjs';
import { readJson, requireApiSession, requireCsrf } from './json.mjs';

export async function accountAccessApi(request, env, ctx, action) {
    const session = await requireApiSession(request, env);
    if (request.method === 'GET') {
        if (action === 'sessions') return json(await readSessions(env, session));
        const { before } = uniqueParams(new URL(request.url).searchParams);
        return json(await readConnectedAgents(env, session, before));
    }
    await requireCsrf(request, env, session);
    const body = await readJson(request);
    if (action === 'sessions') await endSessions(env, ctx, session, body);
    if (action === 'apps') await endAppSessions(env, ctx, session, body);
    if (action === 'devices') await forgetBrowser(env, session, body);
    if (action === 'agents') await revokeConnectedAgent(env, ctx, session, body);
    return json({});
}
