// Draws the README and docs graphics as SVG, in Fire's light and dark looks, from one source.
//   node scripts/diagrams.mjs            writes docs/assets/diagrams/{overview,comparison}-{light,dark}.svg
// They follow Fire (docs/fire): one ink, one accent (ember), hairlines instead of boxes, mono eyebrows, the dot
// grid and corner marks, Geist type (embedded, so GitHub shows it too) and Imprim's dot-matrix wordmark and numerals.
// A palette may also use CSS custom properties (var(--…)), so a page can inline a graphic that follows its theme.
// Every line of text is measured against its box; a line that would overflow fails the build.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dotMatrix } from '../apps/server/src/pages/dots.mjs';

const SANS = "'Geist', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
// Fire's tokens (apps/server/public/fire/tokens.css), resolved for each scheme. Muted text is ink at 64%; the grid
// dots are faint ink, as Fire's texture rules set them.
export const PALETTES = {
    light: { bg: '#f9f9f9', surface: '#ffffff', sunken: '#f4f4f4', ink: '#262626', muted: '#737373', line: '#e8e8e8', strong: '#d4d4d4',
        accent: '#fa5d19', accentSoft: '#fff4ee', good: '#2fb457', partial: '#e8a917', none: '#c4c4c4', grid: '#c8c8c8', sans: SANS, mono: MONO },
    dark: { bg: '#0a0a0a', surface: '#141414', sunken: '#060606', ink: '#f5f5f5', muted: '#a3a3a3', line: '#2a2a2a', strong: '#3d3d3d',
        accent: '#fb6a2a', accentSoft: '#2b1d16', good: '#4ccd75', partial: '#f0c550', none: '#525252', grid: '#333333', sans: SANS, mono: MONO }
};

const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// A deliberately generous estimate of rendered width, so text that passes here fits in Geist and its fallbacks.
const widthOf = (text, size, mono) => text.length * size * (mono ? 0.62 : 0.57);

function fontFaces() {
    const face = (family, file) => `@font-face{font-family:'${family}';font-weight:100 900;src:url(data:font/woff2;base64,${
        readFileSync(new URL(`../apps/server/public/fire/fonts/${file}`, import.meta.url)).toString('base64')}) format('woff2')}`;
    return `<style>${face('Geist', 'geist-latin-wght-normal.woff2')}${face('Geist Mono', 'geist-mono-latin-wght-normal.woff2')}</style>`;
}

function canvas(c, prefix) {
    const parts = [];
    const api = {
        rect(x, y, w, h, { fill = 'none', stroke = 'none', r = 12, width = 1 } = {}) {
            parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" style="fill:${fill};stroke:${stroke};stroke-width:${width}"/>`);
        },
        text(x, y, lines, { size = 14, weight = 400, fill = c.ink, anchor = 'start', mono = false, spacing = 0, gap = 1.45, maxWidth, upper = false } = {}) {
            const list = (Array.isArray(lines) ? lines : [lines]).map(line => upper ? line.toUpperCase() : line);
            for (const line of list) {
                const width = widthOf(line, size, mono) + Math.max(0, spacing) * size * line.length;
                if (maxWidth && width > maxWidth) throw new Error(`${prefix}: "${line}" is about ${Math.round(width)}px, wider than ${maxWidth}px`);
            }
            const font = mono ? c.mono : c.sans;
            list.forEach((line, i) => parts.push(`<text x="${x}" y="${(y + i * size * gap).toFixed(1)}" text-anchor="${anchor}" style="font-family:${font};font-size:${size}px;font-weight:${weight};fill:${fill}${spacing ? `;letter-spacing:${spacing}em` : ''}">${esc(line)}</text>`));
        },
        // Fire's eyebrow: small mono capitals, tracked out.
        eyebrow(x, y, text, { fill = c.muted, anchor = 'start', maxWidth } = {}) {
            api.text(x, y, text, { size: 11, mono: true, upper: true, spacing: 0.06, fill, anchor, maxWidth, weight: 500 });
        },
        // A dotted flow line with an arrowhead: the dots echo the wordmark.
        flow(x1, y1, x2, y2) {
            parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" style="stroke:${c.accent};stroke-width:2.4;stroke-linecap:round;stroke-dasharray:0 6" marker-end="url(#${prefix}-arrow)"/>`);
        },
        line(x1, y1, x2, y2, { stroke = c.line, width = 1 } = {}) {
            parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" style="stroke:${stroke};stroke-width:${width}"/>`);
        },
        // Text in Imprim's dot matrix: lit dots in `fill`, unlit dots faint, `pitch` pixels per dot.
        matrix(x, y, text, pitch, fill = c.ink) {
            const m = dotMatrix(text);
            parts.push(`<g transform="translate(${x} ${y}) scale(${pitch})"><path d="${m.unlit}" style="fill:${fill};opacity:.14"/><path d="${m.lit}" style="fill:${fill}"/></g>`);
            return m.width * pitch;
        },
        // A step number: a small tile with the digit in the dot matrix.
        step(x, y, n) {
            parts.push(`<rect x="${x - 16}" y="${y - 16}" width="32" height="32" rx="9" style="fill:${c.surface};stroke:${c.accent};stroke-width:1.2"/>`);
            api.matrix(x - 7.5, y - 10.5, String(n), 3, c.accent);
        },
        // Fire's corner marks: a hairline cross on each corner of a box, pushed out by `gap`.
        corners(x, y, w, h, { stroke = c.strong, gap = 8 } = {}) {
            const arm = 4.5;
            for (const [cx, cy] of [[x - gap, y - gap], [x + w + gap, y - gap], [x - gap, y + h + gap], [x + w + gap, y + h + gap]])
                parts.push(`<path d="M${cx - arm} ${cy}H${cx + arm}M${cx} ${cy - arm}V${cy + arm}" style="fill:none;stroke:${stroke};stroke-width:1"/>`);
        },
        mark(x, y, kind) {
            if (kind === 'full') parts.push(`<circle cx="${x}" cy="${y}" r="6.5" style="fill:${c.good}"/>`);
            else if (kind === 'part') parts.push(`<circle cx="${x}" cy="${y}" r="5.8" style="fill:none;stroke:${c.partial};stroke-width:1.6"/><path d="M${x} ${y - 5.8} A5.8 5.8 0 0 0 ${x} ${y + 5.8} Z" style="fill:${c.partial}"/>`);
            else if (kind === 'none') parts.push(`<circle cx="${x}" cy="${y}" r="5.8" style="fill:none;stroke:${c.none};stroke-width:1.6"/>`);
            else parts.push(`<line x1="${x - 6}" y1="${y}" x2="${x + 6}" y2="${y}" style="stroke:${c.none};stroke-width:1.6"/>`);
        },
        done(w, h, title, description, { fonts = true } = {}) {
            return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="${prefix}-title ${prefix}-desc">
<title id="${prefix}-title">${esc(title)}</title><desc id="${prefix}-desc">${esc(description)}</desc>
${fonts ? fontFaces() : ''}
<defs>
<marker id="${prefix}-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9 z" style="fill:${c.accent}"/></marker>
<pattern id="${prefix}-grid" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="8" cy="8" r="1" style="fill:${c.grid}"/></pattern>
<radialGradient id="${prefix}-fade" cx="50%" cy="50%" r="62%"><stop offset="0" style="stop-color:#fff;stop-opacity:1"/><stop offset="1" style="stop-color:#fff;stop-opacity:0"/></radialGradient>
<mask id="${prefix}-mask"><rect width="${w}" height="${h}" style="fill:url(#${prefix}-fade)"/></mask>
</defs>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="16" style="fill:${c.bg};stroke:${c.line}"/>
<rect width="${w}" height="${h}" style="fill:url(#${prefix}-grid)" mask="url(#${prefix}-mask)"/>
${parts.join('\n')}
</svg>
`;
        }
    };
    return api;
}

// How Imprim works, in one picture: a person, their agent, the app, and what flows between them.
export function overview(c, { prefix = 'overview', fonts = true } = {}) {
    const d = canvas(c, prefix), W = 1200, H = 740, T = 36;
    const card = (x, y, w, h) => d.rect(x, y + T, w, h, { fill: c.surface, stroke: c.line });
    const title = (x, y, text) => d.text(x, y + T, text, { size: 19, weight: 500, spacing: -0.01, maxWidth: 210 });
    const body = (x, y, lines, maxWidth) => d.text(x, y + T, lines, { size: 14.5, fill: c.muted, maxWidth });
    const note = (x, y, lines, options = {}) => d.text(x, y + T, lines, { size: 13, fill: c.muted, gap: 1.35, ...options });
    d.eyebrow(40, 42, 'In one view');
    d.matrix(1160 - dotMatrix('IMPRIM').width * 2, 31, 'IMPRIM', 2, c.muted);

    // Person, top left.
    card(40, 70, 250, 200);
    d.eyebrow(62, 98 + T, 'Human');
    title(62, 126, 'Person');
    body(62, 156, ['Signs in once per brand', 'Approves one workspace', 'and named scopes', 'Sees and revokes each', 'agent at any time'], 210);
    // Imprim, top centre: the accent card, framed by corner marks.
    d.rect(440, 40 + T, 320, 330, { fill: c.accentSoft, stroke: c.accent, width: 1.2, r: 14 });
    d.corners(440, 40 + T, 320, 330, { stroke: c.accent });
    d.matrix(462, 64 + T, 'IMPRIM', 4, c.ink);
    d.eyebrow(462, 114 + T, 'OIDC · OAuth 2.1 · Workers + D1', { maxWidth: 280 });
    [['People', ['Email link, password, passkeys,', 'Google, GitHub, any OIDC; MFA']],
        ['Agents', ['Any agent, 60-second tokens,', 'rotating refresh, DPoP']],
        ['Machines', ['Signed keys, never shared secrets;', 'token exchange between apps']],
        ['Realms', ['Many brands on one deployment']]].forEach(([name, lines], i) => {
        const y = 148 + i * 56 + T;
        d.eyebrow(462, y, name, { fill: c.accent, maxWidth: 270 });
        d.text(462, y + 19, lines, { size: 14, maxWidth: 280, gap: 1.3 });
    });
    // The app, top right.
    card(910, 70, 250, 200);
    d.eyebrow(932, 98 + T, 'Resource');
    title(932, 126, 'Your MCP server');
    body(932, 156, ['Checks the token is for', 'this exact workspace', 'Matches scopes to the', 'person’s current role', 'Keeps its own sessions'], 210);
    // The agent, bottom centre.
    card(430, 510, 340, 140);
    d.eyebrow(452, 538 + T, 'Public client');
    title(452, 566, 'Agent');
    body(452, 596, ['Claude Code, Cursor, Codex, a CLI', 'Acts for the person, never as them'], 298);
    // The access token, bottom left: a sunken code well.
    d.rect(40, 430 + T, 250, 250, { fill: c.sunken, stroke: c.line });
    d.eyebrow(62, 460 + T, 'Access token · at+jwt', { maxWidth: 210 });
    [['sub', 'the person'], ['client_id', 'the agent'], ['grant_id', 'the consent'], ['aud', 'one workspace'], ['scope', 'the ceiling'], ['exp', '60 seconds']]
        .forEach(([key, value], i) => {
            const y = 494 + i * 30 + T;
            d.text(62, y, key, { size: 13.5, mono: true, fill: c.accent, maxWidth: 90 });
            d.text(158, y, value, { size: 14, maxWidth: 118 });
        });
    // Revocation, bottom right.
    card(910, 430, 250, 250);
    d.eyebrow(932, 460 + T, 'When the person revokes', { maxWidth: 210 });
    [['Refresh stops at once'], ['A signed event reaches', 'the app'], ['App refuses the grant'], ['The last token ends', 'within 60 seconds']].forEach((lines, i) => {
        const y = 496 + i * 46 + T;
        d.text(932, y, String(i + 1).padStart(2, '0'), { size: 12, mono: true, fill: c.accent, weight: 500 });
        d.text(960, y, lines, { size: 14, maxWidth: 186, gap: 1.3 });
    });

    // Flows, numbered in the order of one connection.
    d.flow(215, 274 + T, 438, 504 + T);           // 1: the person gives the agent the app's address
    d.step(318, 380 + T, 1);
    note(340, 326, ['gives it the', 'app’s address'], { maxWidth: 98 });
    d.flow(560, 506 + T, 560, 378 + T);           // 2: the agent asks Imprim for one workspace
    d.step(560, 442 + T, 2);
    note(540, 432, ['asks for one', 'workspace'], { anchor: 'end', maxWidth: 110 });
    d.flow(294, 170 + T, 434, 170 + T);           // 3: the person signs in and approves
    d.step(364, 170 + T, 3);
    note(364, 145, 'signs in, approves', { anchor: 'middle', maxWidth: 136 });
    d.flow(640, 376 + T, 640, 504 + T);           // 4: Imprim issues the token
    d.step(640, 442 + T, 4);
    note(662, 432, ['60-second token,', 'rotating refresh'], { maxWidth: 140 });
    d.flow(772, 556 + T, 1026, 278 + T);          // 5: the agent calls the app with it
    d.step(930, 383 + T, 5);
    note(954, 370, ['calls the app', 'with the token'], { maxWidth: 110 });
    d.flow(766, 170 + T, 904, 170 + T);           // 6: Imprim tells the app what changed
    d.step(835, 170 + T, 6);
    note(835, 145, 'signed events', { anchor: 'middle', maxWidth: 136 });
    note(835, 205, ['revoke, sign-out,', 'account changes'], { anchor: 'middle', maxWidth: 136, size: 12.5 });
    return d.done(W, H, 'Imprim in one view',
        'A person gives their agent an app address. The agent asks Imprim for one workspace, the person signs in and approves, and Imprim issues a 60-second token naming the person, the agent and the grant. The agent calls the app, which checks the workspace and the person’s current role. When the person revokes, refresh stops and a signed event tells the app.', { fonts });
}

// How Imprim's defaults compare with the main kinds of identity system.
export const COLUMNS = [['Imprim', 'people + agents'], ['Workforce IdP', 'e.g. Okta, Entra ID'], ['Developer auth', 'e.g. Auth0, Cognito'],
    ['Self-hosted IdP', 'e.g. Keycloak'], ['API keys', 'and personal tokens']];
export const ROWS = [
    ['Token names person, agent and grant', ['full', 'part', 'part', 'part', 'none']],
    ['Any agent connects, no pre-registration', ['full', 'part', 'part', 'part', 'na']],
    ['One token per workspace (exact audience)', ['full', 'part', 'part', 'part', 'none']],
    ['Agent tokens last 60 seconds by default', ['full', 'part', 'part', 'part', 'none']],
    ['Revocation pushed to the app, signed', ['full', 'part', 'part', 'part', 'none']],
    ['The person sees and revokes each agent', ['full', 'part', 'part', 'part', 'part']],
    ['Refresh rotation with reuse detection', ['full', 'full', 'full', 'full', 'na']],
    ['SAML, SCIM and directory sync', ['none', 'full', 'part', 'full', 'na'], 'planned'],
    ['Open source, runs in your own account', ['full', 'none', 'none', 'full', 'na']],
    ['Fully managed, nothing to run', ['none', 'full', 'full', 'none', 'na']]
];
export function comparison(c, { prefix = 'comparison', fonts = true } = {}) {
    const d = canvas(c, prefix), W = 1200, top = 146, rowH = 46, H = top + ROWS.length * rowH + 132;
    const x0 = 440, col = (W - 30 - x0) / COLUMNS.length, centre = i => Math.round(x0 + col * i + col / 2);
    d.eyebrow(40, 42, 'How it compares');
    d.matrix(1160 - dotMatrix('IMPRIM').width * 2, 31, 'IMPRIM', 2, c.muted);
    d.rect(x0 + 4, 68, col - 8, top + ROWS.length * rowH - 56, { fill: c.accentSoft, stroke: c.accent, width: 1.2, r: 12 });
    d.corners(x0 + 4, 68, col - 8, top + ROWS.length * rowH - 56, { stroke: c.accent, gap: 6 });
    COLUMNS.forEach(([name, note], i) => {
        if (i === 0) d.matrix(centre(0) - dotMatrix('IMPRIM').width * 1.5, 90, 'IMPRIM', 3, c.ink);
        else d.text(centre(i), 106, name, { size: 15, weight: 500, anchor: 'middle', maxWidth: col - 12 });
        d.text(centre(i), 128, note, { size: 12, anchor: 'middle', fill: i === 0 ? c.accent : c.muted, maxWidth: col - 12 });
    });
    ROWS.forEach(([label, marks, note], r) => {
        const y = top + r * rowH;
        d.line(30, y, W - 30, y);
        d.text(40, y + 29, label, { size: 14.5, maxWidth: x0 - 60 });
        marks.forEach((kind, i) => d.mark(centre(i), y + 24, kind));
        if (note) d.text(centre(0) + 13, y + 28, note, { size: 11, mono: true, fill: c.muted, maxWidth: 60 });
    });
    const legendY = top + ROWS.length * rowH + 56;
    d.line(30, legendY - 56, W - 30, legendY - 56);
    [['full', 'Built in and on by default'], ['part', 'Possible with configuration, add-ons or code'], ['none', 'Not provided'], ['na', 'Not applicable']]
        .forEach(([kind, text], i) => {
            const x = [48, 290, 668, 850][i];
            d.mark(x, legendY - 5, kind);
            d.text(x + 16, legendY, text, { size: 13, fill: c.muted, maxWidth: 360 });
        });
    d.text(40, legendY + 36, ['Kinds of system, not single products: each cell is the usual default in public documentation as of November 2026.',
        'Many products do more with configuration or paid add-ons.'], { size: 12, fill: c.muted, maxWidth: W - 80, gap: 1.4 });
    return d.done(W, H, 'How Imprim compares',
        'Imprim against workforce identity providers, developer authentication platforms, self-hosted identity providers and API keys, on agent delegation, audience, token lifetime, revocation, consent, refresh rotation, enterprise directory features, open source and managed hosting.', { fonts });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const out = new URL('../docs/assets/diagrams/', import.meta.url);
    mkdirSync(out, { recursive: true });
    for (const [theme, palette] of Object.entries(PALETTES)) {
        writeFileSync(new URL(`overview-${theme}.svg`, out), overview(palette));
        writeFileSync(new URL(`comparison-${theme}.svg`, out), comparison(palette));
    }
    console.log('Wrote docs/assets/diagrams/{overview,comparison}-{light,dark}.svg');
}
