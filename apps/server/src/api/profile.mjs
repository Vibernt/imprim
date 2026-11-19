import { deleteAccount, profileLanguages, readProfile, saveLanguage, saveName, startEmailChange } from '../account/profile.mjs';
import { json } from '../lib/http.mjs';
import { readJson, requireApiSession, requireCsrf } from './json.mjs';

export async function profileApi(request, env, ctx, action) {
    const session = await requireApiSession(request, env);
    if (request.method === 'GET') {
        const profile = await readProfile(env, session);
        return json({ ...profile, email_verified: profile.email_verified === 1, languages: profileLanguages(env) });
    }
    await requireCsrf(request, env, session);
    const body = await readJson(request);
    if (action === 'email') return json(await startEmailChange(request, env, ctx, session, body));
    if (action === 'delete') {
        const cookies = await deleteAccount(request, env, ctx, session, body);
        const response = json({ redirect: '/signed-out' });
        for (const cookie of cookies) response.headers.append('set-cookie', cookie);
        return response;
    }
    if (action === 'language') {
        await saveLanguage(env, session, body);
        return json({ locale: body.locale || null });
    }
    await saveName(env, ctx, session, body);
    const profile = await readProfile(env, session);
    return json({ display_name: profile.display_name });
}
