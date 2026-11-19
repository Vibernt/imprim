import { ADMIN_FRESH_MS } from '../admin/auth.mjs';
import { ADMIN_MFA_MS } from '../auth/mfa.mjs';
import { initialsOf } from '../auth/session.mjs';
import { localeOf } from '../i18n/index.mjs';
import { json } from '../lib/http.mjs';
import { adminRole } from '../services/admission.mjs';
import { requireApiSession } from './json.mjs';

export async function viewer(request, env) {
    const session = await requireApiSession(request, env);
    return json({
        sub: session.user_id,
        email: session.email,
        initials: initialsOf(session.email),
        locale: localeOf(env),
        admin: await adminRole(env, session.email),
        mfa: session.mfa_at > Date.now() - ADMIN_MFA_MS,
        fresh_until: session.auth_time * 1000 + ADMIN_FRESH_MS,
        realm: { id: env.REALM.id, display_name: env.REALM.display_name }
    });
}
