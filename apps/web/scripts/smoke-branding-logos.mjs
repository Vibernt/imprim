import assert from 'node:assert/strict';
import { PNG } from 'pngjs';

const png = PNG.sync.write({ width: 1, height: 1, data: Buffer.from([38, 89, 129, 255]) });
const fullLogo = { name: 'logo.png', mimeType: 'image/png', buffer: png };

export function fullLogoField(page) {
    return page.getByRole('group', { name: 'Full logo', exact: true }).and(page.locator('.fd-dropzone[data-layout="logo"]'));
}

export async function rejectInvalidLogos(page, assetPosts) {
    const field = fullLogoField(page);
    const input = field.locator('input[type="file"]');
    const error = page.locator('#logo_light-error.fd-field-error');
    for (const [file, message] of [
        [{ ...fullLogo, buffer: Buffer.alloc(256 * 1024 + 1) }, 'Larger than 0.25 MB'],
        [{ name: 'logo.txt', mimeType: 'text/plain', buffer: Buffer.from('logo') }, 'File type not supported'],
    ]) {
        await input.setInputFiles(file);
        await error.getByText(message, { exact: true }).waitFor();
        assert.equal(await input.getAttribute('aria-invalid'), 'true');
        assert.equal(assetPosts.length, 0);
    }
}

export async function chooseFullLogo(page, toast, assetPosts) {
    const field = fullLogoField(page);
    const before = assetPosts.length;
    const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        field.getByRole('button', { name: 'Upload', exact: true }).click(),
    ]);
    await chooser.setFiles(fullLogo);
    await toast('Logo uploaded');
    const preview = field.getByRole('img', { name: fullLogo.name, exact: true });
    await preview.waitFor({ state: 'attached' });
    assert.match(await preview.evaluate((image) => image.src), /^data:/);
    const previewImage = await preview.elementHandle();
    await page.waitForFunction((image) => image.complete, previewImage, { timeout: 5000 });
    assert.ok(await preview.evaluate((image) => image.naturalWidth > 0), 'The chosen logo preview should load');
    await field.getByRole('button', { name: 'Remove', exact: true }).and(field.locator('[data-fd-file-clear]')).waitFor();
    await field.locator('.fd-file-status').getByText('Uploaded', { exact: true }).waitFor();
    await page.locator('#logo_light-error').waitFor({ state: 'hidden' });
    assert.deepEqual(assetPosts.slice(before), [{ content_type: fullLogo.mimeType, data: png.toString('base64') }]);
}
