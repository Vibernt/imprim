import { getSession, requireCsrf as checkCsrf } from '../auth/session.mjs';
import { invariant } from '../lib/errors.mjs';
import { readBody } from '../lib/http.mjs';

export const readJson = (request, limit) => readBody(request, 'json', limit);

export async function requireApiSession(request, env) {
    const session = await getSession(request, env);
    invariant(session, 'login_required', 'Sign in first.', 401);
    return session;
}

export function requireCsrf(request, env, session) {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return checkCsrf(request, env, session);
}
