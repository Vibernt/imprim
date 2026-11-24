// Test-only subset of Cloudflare HTMLRewriter, for the known app shell. It rejects unknown operations.
import assert from 'node:assert/strict';

const BOOT = 'script[src="/fire/boot.js"]';
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

export class TestHTMLRewriter {
    #handlers = new Map();

    on(tag, handler) {
        assert.ok(['html', 'head', BOOT].includes(tag), `Unsupported test selector: ${tag}`);
        this.#handlers.set(tag, handler);
        return this;
    }

    transform(response) {
        const stream = new ReadableStream({
            start: async controller => {
                let html = await response.text();
                for (const [tag, handler] of this.#handlers) {
                    if (tag === BOOT) {
                        const script = '<script src="/fire/boot.js"></script>';
                        assert.ok(html.includes(script), 'The shell has no boot.js script.');
                        let before = '';
                        handler.element({ before(content, options) { assert.equal(options.html, true); before += content; } });
                        html = html.replace(script, () => before + script);
                        continue;
                    }
                    const pattern = new RegExp(`<${tag}\\b([^>]*)>`);
                    assert.match(html, pattern);
                    let opening = pattern.exec(html)[1], appended = '';
                    handler.element({
                        setAttribute(name, value) {
                            opening = opening.replace(new RegExp(`\\s+${name}="[^"]*"`), '') + ` ${name}="${escape(value)}"`;
                        },
                        append(content, options) {
                            assert.equal(options.html, true);
                            appended += content;
                        }
                    });
                    html = html.replace(pattern, () => `<${tag}${opening}>`).replace(`</${tag}>`, () => appended + `</${tag}>`);
                }
                controller.enqueue(new TextEncoder().encode(html));
                controller.close();
            },
        });
        return new Response(stream, { headers: response.headers, status: response.status });
    }
}
