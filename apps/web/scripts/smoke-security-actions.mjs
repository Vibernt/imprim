import test from 'node:test';
import assert from 'node:assert/strict';
import { dismissRowConfirm, finishHold, focused, openAction, postsTo, undoHold } from './smoke-actions.mjs';

export function securityActionsSmoke(open) {
    test('phone authenticator rows put both usage states in the description', async t => {
        const { page, server } = await open(t, { width: 375 });
        const db = server.env.DB.db, user = db.prepare('SELECT id FROM users').get();
        const created = Date.UTC(2026, 10, 25, 12), used = Date.UTC(2026, 10, 27, 14);
        const insert = db.prepare(`INSERT INTO mfa_factors(id,user_id,type,name,sealed_secret,confirmed,created,last_used)
            VALUES(?,?,'totp',?,'test fixture',1,?,?)`);
        insert.run(crypto.randomUUID(), user.id, 'Travel phone', created, used);
        insert.run(crypto.randomUUID(), user.id, 'Backup phone', created, null);
        await page.goto(server.origin + '/account/security');
        const [addedDate, usedDate] = await page.evaluate(times => {
            const format = new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: 'medium', timeStyle: 'short' });
            return times.map(time => format.format(time));
        }, [created, used]);
        const factors = page.getByRole('list', { name: 'Authenticator apps' });
        for (const [name, usage] of [['Travel phone', `last used ${usedDate}`], ['Backup phone', 'never used']]) {
            const row = factors.getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) });
            await row.locator('.fd-list-desc').getByText(`Added ${addedDate} · ${usage}`, { exact: true }).waitFor();
            assert.equal(await row.locator('.fd-list-meta').count(), 0);
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    });

    for (const last of ['authenticator app', 'passkey']) test(`Security holds a non-last factor removal and confirms the last ${last}`, async t => {
        const { page, server } = await open(t, { width: 375, colorScheme: 'dark' });
        const db = server.env.DB.db, user = db.prepare('SELECT id FROM users').get(), now = Date.now();
        const authenticator = { name: 'Travel phone', path: '/v1/account/mfa/remove', id: crypto.randomUUID(), key: 'factor_id' };
        const passkey = { name: 'Desk passkey', path: '/v1/account/passkeys/remove', id: 'desk-passkey-smoke-test', key: 'id' };
        db.prepare('UPDATE sessions SET mfa_at=? WHERE user_id=?').run(now, user.id);
        db.prepare(`INSERT INTO mfa_factors(id,user_id,type,name,sealed_secret,confirmed,created)
            VALUES(?,?,'totp',?,'test fixture',1,?)`).run(authenticator.id, user.id, authenticator.name, now);
        db.prepare(`INSERT INTO webauthn_credentials(id,realm_id,user_id,public_key,alg,name,created)
            VALUES(?,'default',?,'{}',-7,?,?)`).run(passkey.id, user.id, passkey.name, now);
        const [held, remaining] = last === 'passkey' ? [authenticator, passkey] : [passkey, authenticator];
        const row = factor => page.locator('li.fd-list-row').filter({ has: page.getByText(factor.name, { exact: true }) });
        const remove = factor => openAction(row(factor), 'More actions for ' + factor.name, 'Remove');
        await page.goto(server.origin + '/account/security');
        const heldPosts = postsTo(page, held.path);
        const lastPosts = postsTo(page, remaining.path);
        const trigger = await remove(held);
        assert.equal(await page.locator('.fd-confirm-row:visible').count(), 0);
        assert.equal(await row(remaining).locator('[data-fd-menu]').isDisabled(), true);
        await undoHold(page, row(held), trigger, heldPosts);
        await focused(page, trigger);
        await remove(held);
        await finishHold(page);
        await row(held).waitFor({ state: 'detached' });
        assert.deepEqual(heldPosts, [{ [held.key]: held.id }]);

        const confirm = row(remaining).locator(':scope > .fd-confirm-row');
        await dismissRowConfirm(page, confirm, await remove(remaining), lastPosts);
        await dismissRowConfirm(page, confirm, await remove(remaining), lastPosts, 'Escape');
        await remove(remaining);
        await confirm.getByText(`Remove ${remaining.name}? Two-step verification turns off.`, { exact: true }).waitFor();
        await confirm.getByRole('button', { name: 'Remove ' + last, exact: true }).click();
        await page.getByText('Two-step verification is off.', { exact: true }).waitFor();
        assert.deepEqual(lastPosts, [{ [remaining.key]: remaining.id }]);
        await server.drain();
    });

    test('a failed confirmation keeps the question and focuses its danger button', async t => {
        const path = '/v1/account/mfa/remove';
        const { page, server } = await open(t, { expectedNotFound: [path] });
        const db = server.env.DB.db, user = db.prepare('SELECT id FROM users').get(), now = Date.now();
        const id = crypto.randomUUID();
        db.prepare('UPDATE sessions SET mfa_at=? WHERE user_id=?').run(now, user.id);
        db.prepare(`INSERT INTO mfa_factors(id,user_id,type,name,sealed_secret,confirmed,created)
            VALUES(?,?,'totp','Travel phone','test fixture',1,?)`).run(id, user.id, now);
        await page.goto(server.origin + '/account/security');
        await openAction(page, 'More actions for Travel phone', 'Remove');
        db.prepare('DELETE FROM mfa_factors WHERE id=?').run(id);
        const confirmation = page.getByRole('group', { name: /Remove .*Two-step verification turns off/ });
        const posts = postsTo(page, path);
        await confirmation.getByRole('button', { name: 'Remove authenticator app' }).click();
        await confirmation.getByRole('alert').filter({ hasText: 'Factor not found.' }).waitFor();
        await page.waitForFunction(() => document.activeElement?.matches('.fd-confirm-row [data-fd-confirm-row-submit]'));
        assert.equal(await confirmation.getAttribute('aria-busy'), null);
        assert.equal(posts.length, 1);
        await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
        await focused(page, page.getByRole('button', { name: 'More actions for Travel phone' }));
        assert.equal(posts.length, 1);
    });
}
