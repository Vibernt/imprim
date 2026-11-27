import assert from 'node:assert/strict';
import test from 'node:test';
import { challengeOf } from '../../server/src/lib/crypto.mjs';
import { forgetRealms } from '../../server/src/realms/realm.mjs';
import { githubProfile } from '../../../tests/support/provider-signup.mjs';
import { smokeServer } from './smoke-server.mjs';

export function providerSignupSmoke(browser) {
    test('hosted sign-up switches views, keeps Enter on email, and starts native provider sign-up', async t => {
        const server = await smokeServer(t), db = server.env.DB.db;
        db.exec(`UPDATE realms SET config=json_set(config,'$.workspaces','on','$.signup','open') WHERE id='default';
            UPDATE clients SET signup_policy='invited',workspaces='shared',product='notes',self_signup='on',
                branding='{"name":"Notes"}',sign_in_methods='["google","email","github"]' WHERE id='app';`);
        forgetRealms(server.env);
        githubProfile(t, { db }, { email: 'applicant@example.com' });
        const context = server.track(await browser.newContext({ viewport: { width: 375, height: 900 }, locale: 'en-US' }));
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        const redirect_uri = 'https://app.example.com/callback';
        db.prepare("UPDATE clients SET redirect_uris=? WHERE id='app'").run(JSON.stringify([redirect_uri]));
        const authorize = new URLSearchParams({ client_id: 'app', redirect_uri,
            response_type: 'code', scope: 'openid email', state: 'rp-state', nonce: 'rp-nonce',
            code_challenge: await challengeOf(server.verifier), code_challenge_method: 'S256' });
        await page.goto(server.origin + '/authorize?' + authorize);
        assert.equal(await page.getByText('Notes is invite-only for now.', { exact: false }).count(), 0);
        const id = await page.locator('#request').getAttribute('data-request-id');
        const googleIn = page.getByRole('link', { name: 'Sign in with Google' });
        const githubIn = page.getByRole('link', { name: 'Sign in with GitHub' });
        const googleUp = page.getByRole('button', { name: 'Sign up with Google' });
        const githubUp = page.getByRole('button', { name: 'Sign up with GitHub' });
        await googleIn.waitFor();
        await githubIn.waitFor();
        assert.equal(await page.locator('button[data-signup-provider]:disabled').count(), 2);

        await page.getByRole('button', { name: 'Create an account' }).click();
        await googleUp.waitFor();
        await githubUp.waitFor();
        await googleIn.waitFor({ state: 'hidden' });
        await githubIn.waitFor({ state: 'hidden' });
        await page.getByRole('separator', { name: 'or' }).waitFor();
        const email = page.getByRole('textbox', { name: 'Email' });
        await email.fill('applicant@example.com');
        const emailRequest = page.waitForRequest(request => request.url().endsWith('/v1/auth/magic/request'));
        await email.press('Enter');
        const posted = await emailRequest;
        assert.equal(posted.method(), 'POST');
        assert.equal(posted.postDataJSON().purpose, 'signup');
        await page.waitForURL('**/check-email?request_id=' + id);
        assert.equal(await page.getByText('Notes is invite-only for now.', { exact: false }).count(), 0);
        await server.drain();
        assert.equal(db.prepare('SELECT count(*) AS n FROM oauth_states').get().n, 0);

        const signIn = '/login?request_id=' + id;
        await page.goto(server.origin + signIn + '&view=signup');
        await page.getByRole('heading', { name: 'Create an account' }).waitFor();
        await googleUp.waitFor();
        await githubUp.waitFor();
        await googleIn.waitFor({ state: 'hidden' });
        await githubIn.waitFor({ state: 'hidden' });
        const name = 'Applicant team';
        await page.getByRole('textbox', { name: 'Workspace name' }).fill(name);

        // Inspect the real Worker redirect and stop before the test reaches an external OAuth provider.
        let upstream;
        await context.route('**/v1/auth/github/signup', async route => {
            upstream = await route.fetch({ maxRedirects: 0 });
            await route.fulfill({ body: 'Test OAuth provider' });
        });
        const nativePost = page.waitForRequest(request => request.url().endsWith('/v1/auth/github/signup'));
        await githubUp.click();
        const native = await nativePost;
        assert.equal(native.isNavigationRequest(), true);
        assert.equal(native.method(), 'POST');
        const fields = new URLSearchParams(native.postData());
        assert.equal(fields.get('request_id'), id);
        assert.equal(fields.get('workspace_name'), name);
        await page.getByText('Test OAuth provider').waitFor();
        assert.equal(upstream.status(), 303);
        assert.equal(new URL(upstream.headers().location).origin, 'https://github.com');

        await page.goto(server.origin + signIn);
        await githubIn.waitFor();
        // Drive a sign-in callback in the same browser without contacting GitHub.
        const jar = (await context.cookies(server.origin)).filter(cookie => cookie.name === '__Host-vi_browser')
            .map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
        const signInCallback = async () => {
            const start = await server.call('/v1/auth/github/start?request_id=' + id, { headers: { cookie: jar } });
            assert.equal(start.status, 303);
            const value = start.headers.getSetCookie()[0].match(/__Host-vi_oauth=([^;]+)/)[1];
            await context.addCookies([{ name: '__Host-vi_oauth', value, domain: 'localhost', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
            const state = new URL(start.headers.get('location')).searchParams.get('state');
            await page.goto(server.origin + '/auth/github/callback?' + new URLSearchParams({ state, code: 'provider-test-code' }));
        };
        await signInCallback();
        await page.getByRole('heading', { name: 'No Notes account yet' }).waitFor();
        await page.getByText('applicant@example.com has no Notes account.', { exact: false }).waitFor();
        assert.equal(await page.getByRole('link', { name: 'Create an account' }).getAttribute('href'), signIn + '&view=signup');
        assert.equal(await page.getByRole('link', { name: 'Sign in another way' }).getAttribute('href'), signIn);
        assert.equal(await page.locator('script[src^="/fire/"], [style], style').count(), 0);

        db.exec("UPDATE clients SET self_signup='off' WHERE id='app'");
        await signInCallback();
        await page.getByRole('heading', { name: "applicant@example.com isn't invited to Notes" }).waitFor();
        await page.getByText('Notes is invite-only for now.', { exact: false }).waitFor();
        assert.equal(await page.getByRole('link', { name: 'Create an account' }).count(), 0);
        await page.getByRole('link', { name: 'Sign in another way' }).click();
        await page.waitForURL('**' + signIn);
        await githubIn.waitFor();
    });
}
