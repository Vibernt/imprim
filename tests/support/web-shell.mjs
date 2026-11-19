import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TestHTMLRewriter } from './html-rewriter.mjs';

export async function useWebShell(t, env) {
    const index = await readFile(new URL('../fixtures/web/index.html', import.meta.url), 'utf8');
    const previous = globalThis.HTMLRewriter;
    globalThis.HTMLRewriter = TestHTMLRewriter;
    t.after(() => { globalThis.HTMLRewriter = previous; });
    env.ASSETS = { fetch(request) {
        assert.equal(new URL(request.url).pathname, '/ui/index.html');
        return new Response(index, { headers: { 'content-type': 'text/html' } });
    } };
}
