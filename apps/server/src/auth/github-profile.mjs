import { invariant } from '../lib/errors.mjs';
import { normalizeEmail } from '../services/admission.mjs';
async function jsonFetch(url, init) {
    const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    invariant(response.ok, 'github_unavailable', 'GitHub request failed.', 502);
    return response.json();
}
export async function githubProfile(env, code, verifier) {
    const token = await jsonFetch('https://github.com/login/oauth/access_token', {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET,
            code, code_verifier: verifier, redirect_uri: `${env.ISSUER}/auth/github/callback` })
    });
    invariant(typeof token.access_token === 'string' && !token.error, 'github_unavailable', 'GitHub exchange refused.', 502);
    const headers = { authorization: `Bearer ${token.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'imprim', 'x-github-api-version': '2022-11-28' };
    const user = await jsonFetch('https://api.github.com/user', { headers });
    const emails = await jsonFetch('https://api.github.com/user/emails?per_page=100', { headers });
    invariant(Number.isSafeInteger(user.id) && user.id > 0, 'github_profile', 'GitHub returned no numeric id.', 502);
    const primary = Array.isArray(emails) && emails.find(email => email.primary === true && email.verified === true);
    invariant(primary, 'access_denied', 'A verified primary GitHub email is required.', 403);
    return { providerId: String(user.id), email: normalizeEmail(primary.email), login: typeof user.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(user.login) ? user.login : null };
}
