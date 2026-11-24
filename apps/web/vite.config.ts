import { defineConfig, type HtmlTagDescriptor, type Plugin } from 'vite';
import { lazyFireTweaks } from './scripts/lazy-fire-tweaks.mjs';
import { firstPaintFont } from './scripts/first-font.mjs';

// Keep the production CSP and preload the default interface face. The Worker supplies the realm's look.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const slim = (file: string) => decodeURIComponent(new URL(`./.fire-slim/${file}`, import.meta.url).pathname);

/** boot.js, moved to the end of <head> after Vite's stylesheet (Fire 0.12.3; from Fire's lit-vite starter). */
function bootLast(html: string) {
  const tag = /[ \t]*<script src="[^"]*fire\/boot\.js"><\/script>\r?\n/.exec(html)?.[0];
  if (!tag) throw new Error('index.html: no boot.js script to put after the stylesheets');
  return html.replace(tag, '').replace(/[ \t]*<\/head>/, (end) => tag + end);
}

function fireHtml(): Plugin {
  let base = '/';
  return {
    name: 'fire-html',
    configResolved(config) { base = config.base; },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const policy = ctx.server ? '' : `    <meta http-equiv="Content-Security-Policy" content="${CSP}" />\n`;
        const tags: HtmlTagDescriptor[] = [];
        const font = ctx.bundle && firstPaintFont(slim(''));
        const asset = font && Object.values(ctx.bundle!).find((out) => out.type === 'asset' && out.originalFileNames.some((name) => name.endsWith(`/${font}`)));
        if (asset) tags.push({ tag: 'link', injectTo: 'head', attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: base + asset.fileName, crossorigin: true } });
        else if (ctx.bundle) this.warn('no font to preload: fire slim reports no Latin regular face for the theme');
        const out = html.replace('<!-- csp -->\n', policy);
        return { html: ctx.server ? out : bootLast(out), tags };
      },
    },
  };
}

export default defineConfig(({ command, mode }) => ({
  base: '/',
  plugins: [fireHtml(), lazyFireTweaks()],
  optimizeDeps: { exclude: ['fire-design'] },
  // `vite build --mode full` builds with the whole of Fire (to compare). fire-design/elements stays as it is: it
  // shares Fire's module files with the slim entry. Fire's wrappers load
  // fire.js by a relative path (../../fire/fire.js), so that is pointed at the slim entry too.
  resolve: command === 'build' && mode !== 'full' ? { alias: [
    { find: /^fire-design$/, replacement: slim('fire.js') },
    { find: /^fire-design\/css$/, replacement: slim('fire.css') },
    { find: /^(?:\.\.\/)+fire\/fire\.js$/, replacement: slim('fire.js') },
  ] } : {},
  server: { host: '127.0.0.1' },
  build: {
    assetsDir: 'ui',
    target: 'es2022',
    // Fire's tokens use light-dark(), which Chrome 123, Firefox 120 and Safari 17.5 understand. Vite's default CSS
    // target is older, so lightningcss would rewrite every light-dark() into a custom-property toggle that follows
    // the page's theme only, and a `color-scheme: light` on one element (the QR code in a dark page) would be ignored.
    cssTarget: ['chrome123', 'edge123', 'firefox120', 'safari17.5'],
    // Fire's shared chunk is about 590 kB before gzip. The size budgets in package.json ("fire": { "budget" }),
    // which `npm run check` enforces, are the limit that counts.
    chunkSizeWarningLimit: 650,
    // dist/.vite/manifest.json: the chunks each route needs. scripts/check.mjs reads it for the size budget.
    manifest: true,
    rolldownOptions: {
      output: {
        // Each screen is a chunk of its own through its import() in src/routes.ts, named after its folder. Lit,
        // Fire and src/lib (what screens import from the app) go in shared chunks of their own, so a change to one
        // screen changes that screen's file and the entry's (which names it), and no other file name.
        codeSplitting: {
          groups: [
            { name: 'lit', test: /[\\/]node_modules[\\/](?:lit|lit-html|lit-element|@lit[\\/]reactive-element)[\\/]/, priority: 3 },
            { name: 'fire', test: /[\\/](?:\.fire-slim[\\/]fire\.js|fire[\\/](?:fire\.js|elements\.js|js[\\/](?!tweaks\.js$)))/, priority: 2 },
            { name: 'app', test: /[\\/]src[\\/]lib[\\/]/, priority: 1 },
          ],
        },
        assetFileNames: 'ui/static/[name]-[hash][extname]',
        entryFileNames: 'ui/static/[name]-[hash].js',
        chunkFileNames: 'ui/static/[name]-[hash].js',
      },
    },
  },
}));
