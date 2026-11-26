import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fireLabelScript } from '../apps/server/src/pages/fire-labels.mjs';
import { catalogues, LANGUAGES } from '../apps/server/src/i18n/index.mjs';

const script = /^<script type="application\/json" data-fd-labels>([^<]*)<\/script>$/;
const readLabels = locale => JSON.parse(fireLabelScript({ I18N: { locale } }).match(script)[1]);
const core = readFileSync(new URL('../node_modules/fire-design/fire/js/core.js', import.meta.url), 'utf8');
const labelContract = core.slice(core.indexOf('Keys and English defaults'), core.indexOf('let dictionary'));
const defaults = Object.fromEntries([...labelContract.matchAll(/([a-z][\w-]*\.[\w.-]+) "([^"]*)"/g)]
    .map(([, key, id]) => [key, id]));
// Imprim's sample address uses the same reserved domain as its other examples.
defaults['signup.invalid'] = 'Use a full address, like dana@example.com.';

test('the page dictionary covers every Fire label in all shipped languages and keeps runtime placeholders', () => {
    assert.ok(Object.keys(defaults).length > 100);
    for (const locale of LANGUAGES) {
        const expected = Object.fromEntries(Object.entries(defaults)
            .map(([key, id]) => [key, locale === 'en' ? id : catalogues.get(locale)[id]]));
        const labels = readLabels(locale);
        assert.deepEqual(labels, expected, locale);
        assert.match(labels['secret.show'], /\{noun\}/);
    }
});

test('a Fire label cannot close the inert JSON script', t => {
    const value = '</ScRiPt><script src="/malicious.js">';
    catalogues.set('xx', Object.freeze({ 'Open menu': value }));
    t.after(() => catalogues.delete('xx'));
    assert.equal(readLabels('xx')['menu.open'], value);
});
