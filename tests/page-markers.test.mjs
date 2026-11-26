// Every HTML page leaves the Worker with its brand filled in and its administrator-only parts resolved: an unfilled
// `<!--identity:` marker means withBrand was skipped, which would show a page without its look and keep markup meant
// only for administrators. Server pages under /account/ (password, second factor) are the case that once slipped.
import assert from 'node:assert/strict';
import test from 'node:test';
import { begin, login, world } from './support/world.mjs';
import { useWebShell } from './support/web-shell.mjs';

const html = { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' };

test('no page is sent with an unfilled brand or administrator marker', async t => {
    const w = await world(t);
    await useWebShell(t, w.env);
    const { cookie } = await login(w, t);
    const flow = await begin(w);
    const both = `${cookie}; ${flow.cookie}`;
    const pages = [
        ['/login', ''], ['/signed-out', ''], ['/error', ''], ['/device', ''], ['/account', ''],
        ['/signed-in', cookie], ['/logout', cookie], ['/device', cookie], ['/error', cookie],
        ['/account', cookie], ['/account/security', cookie], ['/account/apps', cookie], ['/account/no-such-page', cookie],
        ['/account/password', cookie], ['/account/mfa', cookie],
        [`/account/password?request_id=${flow.request_id}`, both], [`/account/mfa?request_id=${flow.request_id}`, both],
        [`/login?request_id=${flow.request_id}`, flow.cookie]
    ];
    for (const [path, jar] of pages) {
        const response = await w.call(path, { headers: { ...html, cookie: jar } });
        if (!response.headers.get('content-type')?.startsWith('text/html')) continue;
        const body = await response.text();
        assert.doesNotMatch(body, /<!--identity:/, `${path} (${jar ? 'signed in' : 'signed out'}) has an unfilled marker`);
    }
});
