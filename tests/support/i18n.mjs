import assert from 'node:assert/strict';
import { catalogues } from '../../apps/server/src/i18n/index.mjs';
import { forgetRealms } from '../../apps/server/src/realms/realm.mjs';
// A test-only language that wraps every message in ⟦ ⟧. Text on a page that is not wrapped did not go through the
// catalogue. It is never shipped or offered outside tests.
export const PSEUDO = 'en-XA';
export function registerPseudo() {
    const wrap = id => `⟦${id}⟧`;
    catalogues.set(PSEUDO, new Proxy({}, {
        get: (_, id) => typeof id === 'string' ? wrap(id) : undefined,
        getOwnPropertyDescriptor: (_, id) => typeof id === 'string' ? { value: wrap(id), writable: false, enumerable: true, configurable: true } : undefined
    }));
    return () => catalogues.delete(PSEUDO);
}
// Makes the pseudo language the realm's default, so every request without Accept-Language uses it.
export function usePseudo(w) {
    w.env.DB.db.prepare("UPDATE realms SET config=json_set(config,'$.branding.locale',?) WHERE id='default'").run(PSEUDO);
    forgetRealms(w.env);
}
const MONTHS = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Mon|Tue|Wed|Thu|Fri|Sat|Sun|AM|PM|GMT|UTC)$/;
const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
// Words left once every ⟦…⟧ is removed. Allowed: data (`allowed` words: names, emails, hosts), codes, dates, numbers.
export function untranslated(text, allowed = []) {
    let rest = text.replace(/https?:\/\/[^\s<>"⟦⟧]+/g, ' '), previous;
    do { previous = rest; rest = rest.replace(/⟦[^⟦⟧]*⟧/g, ' '); } while (rest !== previous);
    const ok = new Set(allowed.flatMap(value => String(value).split(/[^\p{L}\p{N}@._-]+/u)).filter(Boolean));
    return rest.split(/[^\p{L}\p{N}@._-]+/u).filter(word => word && /\p{L}/u.test(word) && !ok.has(word) && !MONTHS.test(word)
        && !/@|\d/.test(word) && !/^[A-Z0-9]{2,8}(-[A-Z0-9]{2,8})*$/.test(word) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(word));
}
// Visible text and labelling attributes of a page, scripts and inline SVG removed.
export function visibleText(html) {
    const body = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<svg[\s\S]*?<\/svg>/g, ' ');
    const attrs = [...body.matchAll(/\s(?:aria-label|placeholder|alt|title)="([^"]*)"/g)].map(m => decode(m[1]));
    return [decode(body.replace(/<[^>]+>/g, ' ')), ...attrs].join('\n');
}
export function assertTranslated(text, allowed, where) {
    const words = untranslated(text, allowed);
    assert.deepEqual([...new Set(words)], [], `${where}: text outside the catalogue`);
}

export const fireLabels = html => JSON.parse(html.match(/<script type="application\/json" data-fd-labels>([^<]*)<\/script>/)[1]);
