import assert from 'node:assert/strict';
import test from 'node:test';
import { issueSession } from '../apps/server/src/auth/session.mjs';
import { fakeGoogle } from './support/google.mjs';
import { effectCounts, githubProfile, gmail, providerCallback, startProvider, unchanged } from './support/provider-signup.mjs';
import { count, signupWorld } from './support/signup.mjs';

test('ordinary Google GET returns the no-account page with a usable signup view and leaves no profile or session write', async t => {
    const w = await signupWorld(t), google = fakeGoogle(t, w, { email: gmail, hd: undefined });
    w.db.exec(`UPDATE clients SET sign_in_methods='["google","password","email","github"]' WHERE id='app'`);
    w.db.exec("INSERT INTO users(id,email,email_verified,created) VALUES('other-user','other@example.com',1,0)");
    const user = w.db.prepare("SELECT * FROM users WHERE id='other-user'").get();
    const signed = await issueSession(w.env, user, 'email');
    w.db.exec('UPDATE sessions SET last_seen=0');
    const flow = await startProvider(w, 'google', { google, signup: false });
    assert.equal(w.db.prepare('SELECT purpose FROM oauth_states').get().purpose, 'sign_in');
    const before = effectCounts(w.db);
    const auditCount = count(w.db, 'audit');
    const response = await providerCallback(w, flow, {
        cookie: [flow.cookie, ...signed.cookies.map(cookie => cookie.split(';')[0])].join('; '),
        query: { purpose: 'signup', workspace_name: 'ignored' }
    });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<h1 class="fd-h1">No Notes account yet<\/h1><p class="fd-muted">person@gmail\.com has no Notes account\./);
    assert.ok(html.includes(`href="/login?request_id=${flow.request_id}&amp;view=signup"`));
    assert.ok(html.includes(`href="/login?request_id=${flow.request_id}">Sign in another way`));
    assert.doesNotMatch(html, /\sstyle=|<style|\/fire\/js\//);
    assert.doesNotMatch(response.headers.get('set-cookie'), /vi_session/);
    unchanged(w.db, before);
    assert.equal(count(w.db, 'audit'), auditCount);
    assert.equal(w.db.prepare('SELECT last_seen FROM sessions').get().last_seen, 0);
    assert.equal(count(w.db, 'oauth_states'), 0);

    const page = await w.call('/login?request_id=' + flow.request_id + '&view=signup', { headers: { cookie: flow.cookie } });
    const markup = await page.text();
    assert.match(markup, /id="signup-head">/);
    assert.match(markup, /id="sign-in-head" hidden/);
    assert.match(markup, /request_id=[^"]+" hidden>.*Sign in with Google/);
    assert.match(markup, /id="send-signup"[^>]*>.*Email me a link[\s\S]*Sign up with Google[\s\S]*Sign up with GitHub/);
    assert.match(page.headers.get('content-security-policy'), /form-action 'self' https:\/\/accounts\.google\.com https:\/\/github\.com;/);
});

test('ordinary provider refusals keep Account unavailable when app sign-up is unavailable', async t => {
    const w = await signupWorld(t, { appSignup: 'off' });
    githubProfile(t, w);
    const flow = await startProvider(w, 'github', { signup: false });
    const response = await providerCallback(w, flow);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error_description, 'Account unavailable.');
    unchanged(w.db);
    assert.equal(w.mails.length, 0);
});
