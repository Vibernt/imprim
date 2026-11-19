import { changeFactor, readFactors } from '../account/factors.mjs';
import { passwordStatus, savePassword } from '../account/password-service.mjs';
import { addPasskey, beginPasskey, deletePasskey } from '../webauthn/ceremonies.mjs';
import { json } from '../lib/http.mjs';
import { readJson, requireApiSession, requireCsrf } from './json.mjs';

export async function accountSecurityApi(request, env, ctx, action) {
    const session = await requireApiSession(request, env);
    if (request.method === 'GET') {
        const [factors, password] = await Promise.all([readFactors(env, session), passwordStatus(env, session)]);
        return json({ ...factors, password, email_verified: session.email_verified === 1 });
    }
    await requireCsrf(request, env, session);
    const body = await readJson(request);
    if (action === 'passkey-options') return json(await beginPasskey(request, env, session));
    if (action === 'passkey-register') return json(await addPasskey(request, env, ctx, session, body));
    if (action === 'passkey-remove') await deletePasskey(env, ctx, session, body);
    else if (action === 'password') await savePassword(env, ctx, session, body);
    else return json(await changeFactor(env, ctx, session, action, body));
    return json({});
}
