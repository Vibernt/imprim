import test from 'node:test';
import assert from 'node:assert/strict';
import { issueSession } from '../../server/src/auth/session.mjs';
import { openAction, postsTo, undoHold } from './smoke-actions.mjs';

export function heldSmoke(open) {
    test('Fire eviction commits a held action once and leaves Undo final', async t => {
        const { page, server } = await open(t);
        const db = server.env.DB.db, user = db.prepare('SELECT * FROM users').get();
        const sessions = [];
        for (let i = 0; i < 7; i++) {
            const { session } = await issueSession(server.env, user, 'email');
            const device = 'Test browser ' + i;
            db.prepare('UPDATE sessions SET device=? WHERE sid=?').run(device, session.sid);
            sessions.push({ sid: session.sid, device });
        }
        await page.goto(server.origin + '/account/sessions');
        const row = session => page.locator('li.fd-list-row').filter({ has: page.getByText(session.device, { exact: true }) });
        const [undone, oldest, ...others] = sessions;
        const posts = postsTo(page, '/v1/account/sessions');
        const trigger = await openAction(row(undone), 'More actions for ' + undone.device, 'Sign out ' + undone.device);
        await undoHold(page, row(undone), trigger, posts);

        const result = await page.evaluate(pending => {
            // Queue all decisions in one turn so expiration cannot account for the first dismissal.
            for (const { sid } of pending) {
                const trigger = document.getElementById('im-more-session-' + sid);
                trigger.click();
                document.getElementById(trigger.dataset.fdMenu).querySelector('[role="menuitem"]').click();
            }
            const title = [...document.querySelectorAll('.fd-toast[data-state="closing"] .fd-toast-title')];
            return title.map(element => element.textContent);
        }, [oldest, ...others]);
        assert.ok(result.includes('Signing out ' + oldest.device));
        await row(oldest).waitFor({ state: 'detached' });
        assert.equal(posts[0].sid, oldest.sid);
        assert.equal(posts.filter(post => post.sid === oldest.sid).length, 1);
        assert.ok(posts.every(post => post.sid !== undone.sid));
        assert.ok(db.prepare('SELECT 1 FROM sessions WHERE sid=?').get(undone.sid));

        // Let the remaining holds commit before browser and database teardown.
        await Promise.all(others.map(session => row(session).waitFor({ state: 'detached', timeout: 10_000 })));
    });
}
