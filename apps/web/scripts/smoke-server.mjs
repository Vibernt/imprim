// Serve the built app with the real Worker and SQLite test harness on a loopback HTTP origin.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { world, login, turnstile } from '../../../tests/support/world.mjs';
import { adminLogin } from '../../../tests/support/admin.mjs';
import { TestHTMLRewriter } from '../../../tests/support/html-rewriter.mjs';

const dist = new URL('../dist/', import.meta.url);
const root = new URL('../../../', import.meta.url);
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const staticAsset = path => {
    if (/^\/ui\/static\/[\w.-]+$/.test(path)) return new URL(path.slice(1), dist);
    if (/^\/fire\/(?:[\w-]+\/)*[\w.-]+$/.test(path)) return new URL('node_modules/fire-design' + path, root);
    if (/^\/imprim\/[\w.-]+$/.test(path)) return new URL('apps/server/public' + path, root);
};

export async function smokeServer(t, role) {
    const w = await world(t);
    w.env.DB.db.prepare(`UPDATE realms SET config=json_set(json_remove(config,'$.turnstile'),'$.branding',json(?))`)
        .run(JSON.stringify({ look: { palette: 'glacier', density: 'compact', type: 'book' } }));
    let cookieHeader;
    if (role) {
        turnstile(t);
        w.env.DB.db.prepare("UPDATE admins SET role=? WHERE email='admin@example.com'").run(role);
        cookieHeader = (await adminLogin(w)).cookie;
        w.env.DB.db.exec("UPDATE realms SET config=json_set(config,'$.workspaces','on') WHERE id='default'");
        w.env.DB.db.exec("UPDATE clients SET workspaces='shared', product='notes' WHERE id='app'");
    } else {
        const { cookie, flow } = await login(w, t);
        cookieHeader = flow.cookie + '; ' + cookie;
    }
    const shell = await readFile(new URL('index.html', dist), 'utf8');
    w.env.ASSETS = { fetch: request => {
        if (new URL(request.url).pathname !== '/ui/index.html') throw new Error('Unexpected ASSETS path');
        return new Response(shell, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    } };
    const previous = globalThis.HTMLRewriter;
    globalThis.HTMLRewriter = TestHTMLRewriter;
    t.after(() => { globalThis.HTMLRewriter = previous; });

    const server = createServer(async (request, reply) => {
        try {
            const path = staticAsset(new URL(request.url, origin).pathname);
            if (path) {
                const bytes = await readFile(path);
                reply.writeHead(200, { 'content-type': mime[extname(path.pathname)] }).end(bytes);
                return;
            }

            const headers = new Headers(request.headers);
            if (headers.get('origin') === origin) headers.set('origin', w.env.ISSUER);
            const chunks = [];
            for await (const chunk of request) chunks.push(chunk);
            const response = await w.call(request.url, {
                method: request.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
            });
            const outgoing = Object.fromEntries(response.headers);
            if (outgoing.location?.startsWith(w.env.ISSUER + '/')) outgoing.location = origin + outgoing.location.slice(w.env.ISSUER.length);
            if (outgoing['set-cookie']) outgoing['set-cookie'] = response.headers.getSetCookie();
            reply.writeHead(response.status, outgoing).end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
            console.error(error);
            reply.writeHead(500).end('Test server failed');
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    // localhost, not 127.0.0.1: Chromium accepts Secure (and so __Host-) cookies over plain HTTP only on localhost.
    const origin = `http://localhost:${server.address().port}`;
    // Browser contexts close before the server does, so a request still in flight ends as aborted rather than refused.
    const contexts = new Set();
    t.after(async () => { for (const context of contexts) await context.close().catch(() => {}); });
    t.after(() => new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
    }));
    const cookies = cookieHeader.split('; ').map(pair => {
        const [name, value] = pair.split('=');
        // Host and path, not url: Chromium refuses a __Host- cookie given as an http:// url, even on localhost.
        return { name, value, domain: 'localhost', path: '/', secure: true, sameSite: 'Lax',
            httpOnly: name !== '__Host-vi_csrf' };
    });
    return { ...w, origin, cookies, track: context => { contexts.add(context); return context; } };
}
