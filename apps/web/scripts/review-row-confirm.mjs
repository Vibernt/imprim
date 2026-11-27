import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { openAction } from './smoke-actions.mjs';

export function seedRowConfirmReview(db, userId, now) {
    db.prepare("INSERT INTO admins(realm_id,email,role,created) VALUES('default','reviewer@example.net','realm',?)").run(now);
    db.prepare(`INSERT INTO agent_grants(id,client_id,client_name,registration_method,app_id,user_id,resource,scope,method,created,last_used,expires_at)
        VALUES(?,'https://agent.example.com/meta','Editorial assistant','metadata_document','app',?,'https://app.example.com/mcp','read','email',?,?,?)`)
        .run(crypto.randomUUID(), userId, now, now, now + 86400000);
}

// Fire review opens routes. These captures exercise the interactions that open a confirmation.
export async function reviewRowConfirmations(server, options, gallery) {
    const accountRemoval = '/account/security', agents = '/account/agents';
    const states = [
        ['Remove last factor', accountRemoval, 'More actions for Test phone', 'Remove'],
        ['Generate recovery codes', accountRemoval, 'Generate new codes'],
        ['Revoke agent', agents, 'More actions for Editorial assistant', 'Revoke'],
        ['Disable machine', agents, 'More actions for Editorial bot', 'Disable'],
        ['Disable service client', '/admin/services', 'More actions for Editorial bot', 'Disable'],
        ['Revoke signing key', '/admin/keys', 'More actions for active ES256 key', 'Revoke'],
        ['Remove realm administrator', '/admin/realms?realm=default', 'More actions for reviewer@example.net', 'Remove'],
    ];
    const out = join(options.out, 'row-confirm');
    await mkdir(out, { recursive: true });
    const browser = await chromium.launch();
    const rows = states.map(([name]) => ({ name, captures: [] }));
    try {
        for (const width of options.widths) for (const theme of options.themes) {
            const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' });
            try {
                await context.addCookies(server.cookies);
                const page = await context.newPage();
                for (const [index, [name, path, trigger, action]] of states.entries()) {
                    await page.goto(server.origin + path);
                    await page.evaluate(theme => {
                        if (document.documentElement.hasAttribute('data-theme')) document.documentElement.dataset.theme = theme;
                    }, theme);
                    if (action) await openAction(page, trigger, action);
                    else await page.getByRole('button', { name: trigger, exact: true }).and(page.locator('[data-fd-confirm-row]')).click();
                    await page.waitForFunction(() => document.activeElement?.matches('.fd-confirm-row [data-fd-confirm-row-cancel]'));
                    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} fits ${width}px`);
                    const shot = `${index + 1}-${width}-${theme}.jpg`;
                    await page.screenshot({ path: join(out, shot), fullPage: true, animations: 'disabled' });
                    rows[index].captures.push({ width, theme, shot, findings: [] });
                }
            } finally {
                await context.close();
            }
        }
    } finally {
        await browser.close();
    }
    await copyFile(join(options.out, 'review.css'), join(out, 'review.css'));
    await writeFile(join(out, 'index.html'), gallery(rows, {
        routes: rows.length, screens: rows.reduce((count, row) => count + row.captures.length, 0), errors: 0, warnings: 0,
        note: 'Confirmation screenshots captured after opening each prompt. The main gallery contains Fire’s automated review.',
    }, options));
    const main = join(options.out, 'index.html');
    await writeFile(main, (await readFile(main, 'utf8')).replace('<main>', '<main><p><a href="row-confirm/index.html">Open confirmation states</a></p>'));
}
