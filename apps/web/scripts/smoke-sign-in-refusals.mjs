import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword } from '../../server/src/auth/password-hash.mjs';
import { challengeOf } from '../../server/src/lib/crypto.mjs';
import { smokeServer } from './smoke-server.mjs';

export function signInRefusalsSmoke(browser) {
    test('invite-only pages stay neutral and proven platform credentials show a branded refusal', async t => {
        const server = await smokeServer(t), db = server.env.DB.db;
        const user = db.prepare("SELECT id,email FROM users WHERE email='person@example.com'").get();
        const redirect_uri = 'https://app.example.com/callback';
        db.prepare(`UPDATE clients SET signup_policy='invited',branding='{"name":"Notes"}',redirect_uris=?,
            sign_in_methods='["email","password","passkey"]' WHERE id='app'`).run(JSON.stringify([redirect_uri]));
        db.prepare("INSERT INTO admins VALUES('default',?,'realm',0,NULL)").run(user.email);
        const password = 'a test password for the smoke suite', hash = await hashPassword(password);
        db.prepare('INSERT INTO user_passwords VALUES(?,?,?,?,?,0,0)').run(user.id, hash.algorithm, hash.iterations, hash.salt, hash.hash);
        const context = server.track(await browser.newContext({ viewport: { width: 375, height: 900 }, locale: 'en-US', colorScheme: 'dark' }));
        const page = await context.newPage(), errors = [];
        page.setDefaultTimeout(8000);
        page.on('pageerror', error => errors.push(error.message));
        const authorize = new URLSearchParams({ client_id: 'app', redirect_uri, response_type: 'code', scope: 'openid email',
            state: 'rp-state', nonce: 'rp-nonce', code_challenge_method: 'S256', code_challenge: await challengeOf(server.verifier) });
        const inviteCopy = 'Notes is invite-only for now. Use the address you were invited with, or ask the person who invited you.';
        await page.goto(server.origin + '/authorize?' + authorize);
        const requestId = await page.locator('#request').getAttribute('data-request-id');
        const signIn = '/login?request_id=' + requestId;
        await page.getByText(inviteCopy, { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Create an account' }).count(), 0);
        const requestLink = async email => {
            await page.getByRole('textbox', { name: 'Email' }).fill(email);
            await page.getByRole('button', { name: 'Email me a link' }).click();
            await page.waitForURL('**/check-email?request_id=' + requestId);
            await page.getByText(`If ${email} can sign in here, a link is on its way.`, { exact: true }).waitFor();
            await page.getByText(inviteCopy, { exact: true }).waitFor();
            await server.drain();
        };
        const before = server.mails.length;
        await requestLink('admin@example.com');
        assert.equal(server.mails.length, before);
        await page.getByRole('link', { name: 'Use a different email' }).click();
        await requestLink(user.email);
        assert.equal(server.mails.length, before + 1);
        const token = server.mails.at(-1).text.match(/#token=([A-Za-z0-9_-]+)/)[1];
        db.prepare("UPDATE admins SET role='platform' WHERE realm_id='default' AND email=?").run(user.email);

        const assertRefusal = async () => {
            await page.getByText("This address manages Vibernt, so it can't sign in to apps. Use another address.", { exact: true }).waitFor();
            assert.equal(await page.title(), 'Sign in · Notes');
            const retry = page.getByRole('link', { name: 'Sign in another way' });
            assert.equal(await retry.getAttribute('href'), signIn);
            assert.equal(await retry.evaluate(link => document.activeElement === link), true);
            assert.equal(await page.locator('script[src^="/fire/"], [style], style').count(), 0);
            assert.ok(!(await context.cookies()).some(cookie => cookie.name === '__Host-vi_session'));
            await retry.click();
            await page.waitForURL('**' + signIn);
            await page.getByRole('heading', { name: 'Sign in to Notes' }).waitFor();
        };
        await page.goto(server.origin + signIn + '#token=' + token);
        await page.locator('#verify').click();
        await assertRefusal();
        await page.getByRole('textbox', { name: 'Email' }).fill(user.email);
        await page.getByLabel('Password', { exact: true }).fill(password);
        await page.locator('#password-sign-in').click();
        await assertRefusal();
        assert.deepEqual(errors, []);
    });
}
