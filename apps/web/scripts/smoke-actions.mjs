import assert from 'node:assert/strict';

const activeHold = page => page.locator('.fd-toast[data-front][data-held][data-state="open"]');

export function postsTo(page, path) {
    const posts = [];
    page.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === path) posts.push(request.postDataJSON());
    });
    return posts;
}

export async function undoHold(page, row, trigger, posts) {
    const toast = activeHold(page);
    const undo = toast.getByRole('button', { name: 'Undo', exact: true });
    await undo.waitFor();
    assert.equal(await row.getAttribute('aria-busy'), 'true');
    assert.equal(await trigger.isDisabled(), true);
    assert.equal(posts.length, 0);
    const countdown = await toast.locator('.fd-toast-progress').evaluateHandle(bar => bar.getAnimations()[0]);
    try {
        await undo.click();
        await undo.waitFor({ state: 'detached' });
        assert.equal(await countdown.evaluate(animation => animation.playState), 'idle');
    } finally {
        await countdown.dispose();
    }
    await row.locator('xpath=self::*[not(@aria-busy="true")]').waitFor();
    assert.equal(await trigger.isDisabled(), false);
    assert.equal(posts.length, 0, 'Undo cancels the countdown without sending a request');
}

export async function finishHold(page, expected = 5000) {
    // Fire commits from the Web Animation's finish event.
    const progress = activeHold(page).locator('.fd-toast-progress');
    const duration = await progress.evaluate(bar => {
        const [countdown] = bar.getAnimations();
        const duration = countdown.effect.getTiming().duration;
        countdown.finish();
        return duration;
    });
    assert.equal(duration, expected);
}

export async function openAction(scope, label, action) {
    const trigger = scope.getByRole('button', { name: label, exact: true });
    await trigger.click();
    await scope.getByRole('menuitem', { name: action, exact: true }).click();
    return trigger;
}

export async function focused(page, control) {
    await page.waitForFunction(id => document.activeElement?.id === id, await control.getAttribute('id'));
}

export function detailConfirmation(row) {
    return row.locator('xpath=following-sibling::tr[1][contains(@class,"fd-table-detail")]').locator('.fd-confirm-row');
}

export async function dismissRowConfirm(page, confirmation, trigger, posts, close = 'Cancel') {
    const cancel = confirmation.getByRole('button', { name: 'Cancel', exact: true });
    await cancel.waitFor();
    assert.equal(await confirmation.getAttribute('role'), 'group');
    assert.equal(await cancel.getAttribute('data-fd-confirm-row-cancel'), '');
    assert.equal(await cancel.evaluate(button => document.activeElement === button), true);
    assert.equal(posts.length, 0, 'Opening a confirmation sends nothing');
    if (close === 'Escape') await page.keyboard.press('Escape');
    else await cancel.click();
    await confirmation.waitFor({ state: 'hidden' });
    await confirmation.waitFor({ state: 'attached' });
    await focused(page, trigger);
    assert.equal(posts.length, 0, `${close} sends nothing`);
}

export async function enterConfirmationPhrase(confirmation, label, action, phrase, posts) {
    const confirm = confirmation.getByRole('button', { name: action, exact: true });
    const field = confirmation.getByRole('textbox', { name: label, exact: true });
    assert.equal(await confirm.getAttribute('data-fd-confirm-row-submit'), '');
    assert.equal(await confirm.isDisabled(), true);
    await field.fill(phrase.slice(0, -1));
    assert.equal(await confirm.isDisabled(), true);
    await field.fill('wrong-phrase');
    await field.press('Enter');
    assert.equal(await confirm.isDisabled(), true);
    assert.equal(posts.length, 0, 'An incorrect phrase sends nothing');
    await field.fill(phrase);
    assert.equal(await confirm.isEnabled(), true);
    return confirm;
}

// A plain toast can be dismissed, as a person on a phone would before reaching a row it covers. Held toasts cannot.
export async function dismissToasts(page) {
    const open = page.locator('.fd-toaster .fd-toast:not([data-state="closing"])');
    for (let count = await open.count(); count > 0; count = await open.count()) {
        assert.equal(await page.locator('.fd-toaster .fd-toast[data-held]:not([data-state="closing"])').count(), 0,
            'a held toast has no dismiss button: finish or undo it first');
        await page.locator('.fd-toaster .fd-toast[data-front]:not([data-state="closing"]) .fd-toast-close').click();
        await page.waitForFunction(before => document.querySelectorAll('.fd-toaster .fd-toast:not([data-state="closing"])').length < before, count);
    }
}
