import test from 'node:test';
import assert from 'node:assert/strict';
import { seedAccountWorkspace, seedAccountWorkspaceMember } from '../../../tests/support/account-workspaces.mjs';
import { assertPhoneFit } from './smoke-account-directory.mjs';

const root = '/account/workspaces';
const team = root + '/example-team';

function seed(server, role) {
    const db = server.env.DB.db;
    const person = db.prepare('SELECT id FROM users WHERE email=?').get('person@example.com').id;
    db.exec(`UPDATE realms SET config=json_set(config,'$.workspaces','on');
        UPDATE clients SET workspaces='shared',product='notes',listed=1,branding='{"name":"Notes"}',
            initiate_login_uri='https://notes.example.com/sign-in' WHERE id='app';
        UPDATE clients SET workspaces='shared',product='tasks',listed=0,branding='{"name":"Task Board"}',
            initiate_login_uri='https://tasks.example.com/sign-in' WHERE id='other';`);
    db.prepare('INSERT INTO users(id,email,created) VALUES(?,?,?)').run('teammate', 'teammate@example.com', Date.now());
    seedAccountWorkspace(db, 'example-team', 'Editorial team', {
        owner: role === 'owner' ? person : 'teammate', products: ['notes', 'tasks']
    });
    seedAccountWorkspaceMember(db, 'example-team', role === 'owner' ? 'teammate' : person);
    if (role === 'owner') seedAccountWorkspace(db, 'personal', 'Personal notes', { kind: 'personal', owner: person });
    return db;
}

const heading = (page, name) => page.getByRole('heading', { level: 1, name, exact: true }).waitFor();
// A row's inline confirmation is a detail row that also names the email; match the record row only.
const rowFor = (table, email) => table.locator('tbody tr:not(.fd-table-detail)').filter({ hasText: email });
const rowActions = (row, email) => row.getByRole('button', { name: 'Actions for ' + email, exact: true });
const action = (page, name) => page.getByRole('menuitem', { name, exact: true }).click();

export function accountWorkspacesSmoke(open) {
    test('an owner sees the workspace list and can rename, invite, resend, revoke, change role and remove', async t => {
        const { page, server } = await open(t);
        const db = seed(server, 'owner'), email = 'invitee@example.com', teammate = 'teammate@example.com';
        const response = await page.goto(server.origin + root);
        assert.equal(response.status(), 200);
        const sidebar = page.locator('.fd-sidebar .fd-nav-item');
        assert.deepEqual((await sidebar.allTextContents()).map(text => text.trim()).slice(0, 3), ['Profile', 'Apps', 'Workspaces']);
        const list = page.getByRole('table', { name: 'Workspaces' });
        const teamRow = rowFor(list, 'Editorial team');
        await teamRow.getByRole('link', { name: 'Editorial team' }).waitFor();
        assert.deepEqual(await list.locator('tbody tr').count(), 2);
        assert.equal(await teamRow.getByRole('link', { name: 'Notes', exact: true }).getAttribute('href'), 'https://notes.example.com/sign-in');
        await teamRow.getByText('Task Board', { exact: true }).waitFor();
        assert.equal(await teamRow.getByRole('link', { name: 'Task Board', exact: true }).count(), 0);
        await teamRow.getByRole('link', { name: 'Editorial team' }).click();
        await heading(page, 'Editorial team');
        assert.equal(await page.locator('main button[data-variant="primary"]').count(), 1);
        assert.equal(await page.getByRole('button', { name: 'Leave workspace', exact: true }).isDisabled(), true);
        await page.getByText('Make someone else an owner first.', { exact: true }).waitFor();

        await page.getByRole('button', { name: 'Rename', exact: true }).click();
        await page.getByLabel('Workspace name', { exact: true }).fill('Release team');
        await page.getByRole('button', { name: 'Save name', exact: true }).click();
        await heading(page, 'Release team');
        await page.getByRole('region', { name: 'Invite someone', exact: true }).getByLabel('Email', { exact: true }).fill(email);
        await page.getByLabel('Invitation role').selectOption('viewer');
        await page.getByRole('button', { name: 'Send invitation', exact: true }).click();
        const invites = page.getByRole('table', { name: 'Open invitations', exact: true });
        const invited = rowFor(invites, email);
        await invited.getByText('Viewer', { exact: true }).waitFor();
        const getInvitation = () => db.prepare('SELECT id,revoked_at FROM workspace_invitations WHERE email=? AND revoked_at IS NULL').get(email);
        const first = getInvitation().id;
        await rowActions(invited, email).click();
        const resent = page.waitForResponse(res => res.url().endsWith(team + '/invitations') && res.request().method() === 'POST');
        await action(page, 'Re-send');
        assert.equal((await resent).status(), 201);
        assert.notEqual(getInvitation().id, first);
        await rowActions(invited, email).click();
        await action(page, 'Revoke');
        await invites.getByText('No open invitations', { exact: true }).waitFor();

        const roster = page.getByRole('table', { name: 'Members', exact: true }), member = rowFor(roster, teammate);
        await rowActions(member, teammate).click();
        await action(page, 'Change role');
        await page.getByLabel('New role', { exact: true }).selectOption('admin');
        await page.getByRole('button', { name: 'Save role', exact: true }).click();
        await member.getByText('Admin', { exact: true }).waitFor();
        await rowActions(member, teammate).click();
        await action(page, 'Remove member');
        const confirmation = page.getByLabel('Type ' + teammate + ' to confirm', { exact: true });
        const remove = page.getByRole('button', { name: 'Remove member', exact: true });
        await confirmation.fill('someone@example.com');
        assert.equal(await remove.isDisabled(), true);
        await confirmation.fill(teammate);
        await remove.click();
        await member.waitFor({ state: 'detached' });
        assert.equal(db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id=? AND user_id=?').get('example-team', 'teammate'), undefined);
    });

    test('a member sees the roster and can confirm leave, which removes the Workspaces tab', async t => {
        const { page, server } = await open(t, { width: 375 });
        seed(server, 'member');
        await page.goto(server.origin + team);
        await heading(page, 'Editorial team');
        assert.equal(await page.getByRole('table', { name: 'Members', exact: true }).locator('tbody tr').count(), 2);
        for (const name of ['Rename', 'Send invitation', 'Actions for teammate@example.com']) {
            assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0);
        }
        assert.equal(await page.getByRole('heading', { name: 'Open invitations' }).count(), 0);
        await page.getByRole('button', { name: 'Leave workspace', exact: true }).click();
        await page.getByLabel('Type Editorial team to confirm', { exact: true }).fill('Editorial team');
        await page.getByRole('button', { name: 'Leave workspace', exact: true }).click();
        await page.waitForURL(server.origin + '/account/apps');
        await heading(page, 'Apps');
        await assertPhoneFit(page, ['Profile', 'Apps', 'Security', 'Sessions', 'Agents']);
    });

    test('personal workspaces and team row actions fit the 375px Fire shell', async t => {
        const { page, server } = await open(t, { width: 375 });
        const db = seed(server, 'owner');
        db.prepare(`INSERT INTO workspace_invitations(id,workspace_id,email,role,created,expires_at)
            VALUES('smoke-invite','example-team','pending@example.com','member',?,?)`)
            .run(Date.now(), Date.now() + 86400000);
        await page.goto(server.origin + root);
        await page.getByRole('link', { name: 'Personal notes', exact: true }).click();
        await heading(page, 'Personal notes');
        assert.equal(await page.getByRole('table', { name: 'Members', exact: true }).locator('tbody tr').count(), 1);
        for (const name of ['Open invitations', 'Invite someone', 'Danger zone'])
            assert.equal(await page.getByRole('heading', { name, exact: true }).count(), 0);
        await page.getByRole('link', { name: 'Notes', exact: true }).waitFor();
        await assertPhoneFit(page, ['Apps', 'Workspaces', 'Agents', 'Security', 'More']);
        await page.locator('.fd-tabbar').getByRole('button', { name: 'More', exact: true }).click();
        const menu = page.locator('#im-mobile-nav');
        await menu.waitFor();
        assert.deepEqual((await menu.locator('a:visible').allTextContents()).map(text => text.trim()), ['Profile', 'Sessions', 'Sign out']);
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'hidden' });

        await page.locator('.fd-tabbar').getByRole('link', { name: 'Workspaces', exact: true }).click();
        const list = page.getByRole('table', { name: 'Workspaces', exact: true });
        const link = list.getByRole('link', { name: 'Editorial team', exact: true });
        await link.waitFor();
        assert.equal(await list.locator('tbody tr').first().evaluate(row => getComputedStyle(row).display), 'grid');
        await link.click();
        await heading(page, 'Editorial team');
        const roster = page.getByRole('table', { name: 'Members', exact: true });
        const member = rowFor(roster, 'teammate@example.com');
        assert.equal(await member.evaluate(row => getComputedStyle(row).display), 'grid');
        await rowActions(member, 'teammate@example.com').click();
        await action(page, 'Remove member');
        await page.getByLabel('Type teammate@example.com to confirm', { exact: true }).waitFor({ state: 'visible' });
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        const invites = page.getByRole('table', { name: 'Open invitations', exact: true });
        const invited = rowFor(invites, 'pending@example.com');
        assert.equal(await invited.evaluate(row => getComputedStyle(row).display), 'grid');
        await rowActions(invited, 'pending@example.com').click();
        await page.getByRole('menuitem', { name: 'Re-send', exact: true }).waitFor({ state: 'visible' });
        await page.getByRole('menuitem', { name: 'Revoke', exact: true }).waitFor({ state: 'visible' });
        await page.keyboard.press('Escape');
        await assertPhoneFit(page, ['Apps', 'Workspaces', 'Agents', 'Security', 'More']);
    });

    test('account Workspaces is a not-found page when the person has no active membership', async t => {
        const { page, server } = await open(t, { width: 375, expectedNotFound: [root] });
        server.env.DB.db.exec("UPDATE realms SET config=json_set(config,'$.workspaces','on')");
        const response = await page.goto(server.origin + root);
        assert.equal(response.status(), 404);
        await heading(page, 'Page not found');
        await assertPhoneFit(page, ['Profile', 'Apps', 'Security', 'Sessions', 'Agents']);
        assert.equal(await page.locator('.fd-sidebar').getByRole('link', { name: 'Workspaces', exact: true }).count(), 0);
    });

    test('the admin console shows a missing workspace sign-in address inline', async t => {
        const url = '/admin/workspaces/example-team', endpoint = '/admin/api/workspaces/example-team/invite';
        const { page, server } = await open(t, { role: 'realm', expectedConflict: endpoint });
        const db = server.env.DB.db;
        const admin = db.prepare('SELECT id FROM users WHERE email=?').get('admin@example.com').id;
        seedAccountWorkspace(db, 'example-team', 'Editorial team', { owner: admin });
        await page.goto(server.origin + url);
        await heading(page, 'Editorial team');
        await page.getByLabel('Email', { exact: true }).fill('invitee@example.com');
        const refusal = page.waitForResponse(response => response.url().endsWith(endpoint));
        await page.getByRole('button', { name: 'Send invitation', exact: true }).click();
        assert.equal((await refusal).status(), 409);
        await page.locator('form').getByRole('alert').getByText(
            'No app in this workspace has a sign-in address yet. Ask your administrator.', { exact: true }).waitFor();
        assert.equal(db.prepare('SELECT count(*) AS n FROM workspace_invitations').get().n, 0);
    });
}
