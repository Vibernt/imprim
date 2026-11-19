import test from 'node:test';
import assert from 'node:assert/strict';
import { ICONS } from 'fire-design/fire/js/icons.js';
import { icon } from '../apps/server/src/pages/ui.mjs';

test('every server icon, including shell navigation and callouts, renders Fire SVG', () => {
    const names = ['arrow-left', 'ban', 'blocks', 'bot', 'check', 'chevron-down', 'circle-alert', 'circle-check', 'globe',
        'info', 'key-round', 'list-filter', 'lock', 'log-out', 'mail', 'menu', 'monitor', 'palette', 'panel-left', 'plus',
        'refresh-cw', 'scroll-text', 'search', 'server', 'settings', 'shield-check', 'sliders-horizontal', 'triangle-alert',
        'user', 'users', 'workflow'];
    for (const name of names) {
        assert.ok(Object.hasOwn(ICONS, name), name);
        assert.match(icon(name), /^<svg class="fd-icon"[^>]*><.+<\/svg>$/);
    }
    for (const missing of ['not-a-fire-icon', 'constructor', '__proto__'])
        assert.throws(() => icon(missing), /Unknown Fire icon/);
});
