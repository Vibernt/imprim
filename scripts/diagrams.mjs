// Draws the README and docs graphics as SVG, in a light and a dark version, from one source.
//   node scripts/diagrams.mjs            writes docs/assets/diagrams/{overview,comparison}-{light,dark}.svg
// A palette may also use CSS custom properties (var(--…)), so a page can inline a graphic that follows its theme.
// Every line of text is measured against its box; a line that would overflow fails the build.
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
export const PALETTES = {
    light: { bg: '#ffffff', panel: '#f6f7f9', ink: '#15181e', muted: '#566070', rule: '#d5dae2', accent: '#2b47c9', accentSoft: '#eef1fc',
        onAccent: '#ffffff', good: '#1f7a4d', partial: '#b7791f', none: '#9aa2b1', sans: SANS, mono: MONO },
    dark: { bg: '#0d1117', panel: '#161b22', ink: '#e6edf3', muted: '#9aa4b2', rule: '#30363d', accent: '#8ea2ff', accentSoft: '#1a2040',
        onAccent: '#0d1117', good: '#3fb950', partial: '#d29922', none: '#6e7681', sans: SANS, mono: MONO }
};

const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// A deliberately generous estimate of rendered width, so text that passes here fits in any common font.
const widthOf = (text, size, mono) => text.length * size * (mono ? 0.62 : 0.57);

function canvas(c, prefix) {
    const parts = [];
    const api = {
        rect(x, y, w, h, { fill = 'none', stroke = 'none', r = 10, width = 1, dash } = {}) {
            parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" style="fill:${fill};stroke:${stroke};stroke-width:${width}${dash ? `;stroke-dasharray:${dash}` : ''}"/>`);
        },
        // lines: one string or several; each is checked against maxWidth.
        text(x, y, lines, { size = 14, weight = 400, fill = c.ink, anchor = 'start', mono = false, spacing = 0, gap = 1.45, maxWidth, upper = false } = {}) {
            const list = Array.isArray(lines) ? lines : [lines];
            for (const line of list) {
                const shown = upper ? line.toUpperCase() : line;
                const width = widthOf(shown, size, mono) + spacing * size * shown.length;
                if (maxWidth && width > maxWidth) throw new Error(`${prefix}: "${line}" is about ${Math.round(width)}px, wider than ${maxWidth}px`);
            }
            const font = mono ? c.mono : c.sans;
            list.forEach((line, i) => parts.push(`<text x="${x}" y="${(y + i * size * gap).toFixed(1)}" text-anchor="${anchor}" style="font-family:${font};font-size:${size}px;font-weight:${weight};fill:${fill}${spacing ? `;letter-spacing:${spacing}em` : ''}">${esc(upper ? line.toUpperCase() : line)}</text>`));
        },
        line(x1, y1, x2, y2, { stroke = c.rule, width = 1, dash, arrow } = {}) {
            parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" style="stroke:${stroke};stroke-width:${width}${dash ? `;stroke-dasharray:${dash}` : ''}"${arrow ? ` marker-end="url(#${prefix}-arrow)"` : ''}/>`);
        },
        badge(x, y, label) {
            parts.push(`<circle cx="${x}" cy="${y}" r="12" style="fill:${c.accent}"/>`);
            parts.push(`<text x="${x}" y="${y + 4.5}" text-anchor="middle" style="font-family:${c.sans};font-size:13px;font-weight:700;fill:${c.onAccent}">${label}</text>`);
        },
        mark(x, y, kind) {
            if (kind === 'full') parts.push(`<circle cx="${x}" cy="${y}" r="8" style="fill:${c.good}"/>`);
            else if (kind === 'part') parts.push(`<circle cx="${x}" cy="${y}" r="7" style="fill:none;stroke:${c.partial};stroke-width:2"/><path d="M${x} ${y - 7} A7 7 0 0 0 ${x} ${y + 7} Z" style="fill:${c.partial}"/>`);
            else if (kind === 'none') parts.push(`<circle cx="${x}" cy="${y}" r="7" style="fill:none;stroke:${c.none};stroke-width:2"/>`);
            else parts.push(`<line x1="${x - 7}" y1="${y}" x2="${x + 7}" y2="${y}" style="stroke:${c.none};stroke-width:2"/>`);
        },
        raw(svg) { parts.push(svg); },
        done(w, h, title, description) {
            return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="${prefix}-title ${prefix}-desc">
<title id="${prefix}-title">${esc(title)}</title><desc id="${prefix}-desc">${esc(description)}</desc>
<defs><marker id="${prefix}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" style="fill:${c.accent}"/></marker></defs>
${parts.join('\n')}
</svg>
`;
        }
    };
    return api;
}

// How Imprim works, in one picture: a person, their agent, the app, and what flows between them.
export function overview(c, prefix = 'overview') {
    const d = canvas(c, prefix), W = 1200, H = 720;
    d.rect(0.5, 0.5, W - 1, H - 1, { fill: c.bg, stroke: c.rule, r: 16 });
    const title = (x, y, text) => d.text(x, y, text, { size: 21, weight: 700, maxWidth: 210 });
    const body = (x, y, lines, maxWidth) => d.text(x, y, lines, { size: 15, fill: c.muted, maxWidth });
    const label = (x, y, text, maxWidth) => d.text(x, y, text, { size: 11.5, weight: 700, fill: c.accent, spacing: 0.08, upper: true, maxWidth });

    // Person, top left.
    d.rect(40, 70, 250, 200, { fill: c.panel, stroke: c.rule });
    title(62, 106, 'Person');
    body(62, 138, ['Signs in once per brand', 'Approves one workspace', 'and named scopes', 'Sees and revokes each', 'agent at any time'], 210);
    // Imprim, top centre.
    d.rect(440, 40, 320, 330, { fill: c.accentSoft, stroke: c.accent, width: 2, r: 14 });
    d.text(462, 80, 'Imprim', { size: 26, weight: 800 });
    d.text(462, 103, 'OpenID Connect and OAuth 2.1', { size: 13.5, fill: c.muted, maxWidth: 280 });
    const rows = [['People', ['Email link, password, passkeys,', 'Google, GitHub, any OIDC; MFA']],
        ['Agents', ['Any agent, 60-second tokens,', 'rotating refresh, DPoP']],
        ['Machines', ['Signed keys, never shared secrets;', 'token exchange between apps']],
        ['Realms', ['Many brands on one deployment']]];
    rows.forEach(([name, lines], i) => {
        const y = 138 + i * 58;
        label(462, y, name, 270);
        d.text(462, y + 20, lines, { size: 14, maxWidth: 280, gap: 1.3 });
    });
    // The app, top right.
    d.rect(910, 70, 250, 200, { fill: c.panel, stroke: c.rule });
    title(932, 106, 'Your MCP server');
    body(932, 138, ['Checks the token is for', 'this exact workspace', 'Matches scopes to the', 'person’s current role', 'Keeps its own sessions'], 210);
    // The agent, bottom centre.
    d.rect(430, 510, 340, 130, { fill: c.panel, stroke: c.rule });
    title(452, 546, 'Agent');
    body(452, 576, ['Claude Code, Cursor, Codex, a CLI', 'Acts for the person, never as them', 'Holds no secret of its own'], 298);

    // The access token, bottom left.
    d.rect(40, 420, 250, 262, { fill: c.bg, stroke: c.accent, dash: '5 4' });
    label(62, 452, 'The access token', 210);
    [['sub', 'the person'], ['client_id', 'the agent'], ['grant_id', 'the consent'], ['aud', 'one workspace'], ['scope', 'the ceiling'], ['exp', '60 seconds']]
        .forEach(([key, value], i) => {
            const y = 486 + i * 32;
            d.text(62, y, key, { size: 14, mono: true, maxWidth: 90 });
            d.text(158, y, value, { size: 14.5, fill: c.muted, maxWidth: 118 });
        });
    // Revocation, bottom right.
    d.rect(910, 420, 250, 262, { fill: c.bg, stroke: c.rule });
    label(932, 452, 'When the person revokes', 210);
    ['Refresh stops at once', 'A signed event reaches', 'App refuses the grant', 'The last token ends'].forEach((text, i) => {
        const y = 490 + i * 46;
        d.raw(`<circle cx="942" cy="${y - 5}" r="10" style="fill:none;stroke:${c.accent};stroke-width:1.5"/>`);
        d.text(942, y - 0.5, String(i + 1), { size: 12, weight: 700, fill: c.accent, anchor: 'middle' });
        d.text(962, y, text, { size: 14.5, maxWidth: 190 });
    });
    d.text(962, 555, 'the app', { size: 14.5, maxWidth: 190 });
    d.text(962, 647, 'within 60 seconds', { size: 14.5, maxWidth: 190 });

    // Flows. 1: person gives the agent the app's address.
    d.line(215, 272, 442, 508, { stroke: c.accent, width: 2, arrow: true });
    d.badge(318, 375, 1);
    d.text(334, 352, ['gives it the', 'app’s address'], { size: 13.5, fill: c.muted, maxWidth: 102, gap: 1.3 });
    // 2: the agent asks Imprim for one workspace.
    d.line(560, 508, 560, 374, { stroke: c.accent, width: 2, arrow: true });
    d.badge(560, 440, 2);
    d.text(544, 425, ['asks for one', 'workspace'], { size: 13.5, fill: c.muted, anchor: 'end', maxWidth: 110, gap: 1.3 });
    // 3: the person signs in and approves.
    d.line(292, 170, 436, 170, { stroke: c.accent, width: 2, arrow: true });
    d.badge(364, 170, 3);
    d.text(364, 146, 'signs in, approves', { size: 13.5, fill: c.muted, anchor: 'middle', maxWidth: 140 });
    // 4: Imprim issues the token.
    d.line(640, 374, 640, 508, { stroke: c.accent, width: 2, arrow: true });
    d.badge(640, 440, 4);
    d.text(658, 425, ['60-second token,', 'rotating refresh'], { size: 13.5, fill: c.muted, maxWidth: 140, gap: 1.3 });
    // 5: the agent calls the app with it.
    d.line(772, 556, 1030, 274, { stroke: c.accent, width: 2, arrow: true });
    d.badge(930, 381, 5);
    d.text(972, 366, ['calls the app', 'with the token'], { size: 13.5, fill: c.muted, maxWidth: 110, gap: 1.3 });
    // 6: Imprim tells the app about revocation, sign-out and account changes.
    d.line(764, 170, 906, 170, { stroke: c.accent, width: 2, arrow: true });
    d.badge(835, 170, 6);
    d.text(835, 146, 'signed events', { size: 13.5, fill: c.muted, anchor: 'middle', maxWidth: 140 });
    d.text(835, 200, ['revoke, sign-out,', 'account changes'], { size: 12.5, fill: c.muted, anchor: 'middle', maxWidth: 140, gap: 1.3 });
    return d.done(W, H, 'Imprim in one view',
        'A person gives their agent an app address. The agent asks Imprim for one workspace, the person signs in and approves, and Imprim issues a 60-second token naming the person, the agent and the grant. The agent calls the app, which checks the workspace and the person’s current role. When the person revokes, refresh stops and a signed event tells the app.');
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
export function comparison(c, prefix = 'comparison') {
    const d = canvas(c, prefix), W = 1200, top = 112, rowH = 46, H = top + ROWS.length * rowH + 118;
    const x0 = 440, col = (W - 30 - x0) / COLUMNS.length, centre = i => Math.round(x0 + col * i + col / 2);
    d.rect(0.5, 0.5, W - 1, H - 1, { fill: c.bg, stroke: c.rule, r: 16 });
    d.rect(x0 + 4, 20, col - 8, H - 116, { fill: c.accentSoft, stroke: c.accent, width: 1.5, r: 12 });
    COLUMNS.forEach(([name, note], i) => {
        d.text(centre(i), 60, name, { size: i === 0 ? 18 : 15, weight: i === 0 ? 800 : 700, anchor: 'middle', fill: i === 0 ? c.accent : c.ink, maxWidth: col - 12 });
        d.text(centre(i), 82, note, { size: 12, anchor: 'middle', fill: c.muted, maxWidth: col - 12 });
    });
    ROWS.forEach(([label, marks, note], r) => {
        const y = top + r * rowH;
        d.line(30, y, W - 30, y);
        d.text(40, y + 29, label, { size: 15, maxWidth: x0 - 60 });
        marks.forEach((kind, i) => d.mark(centre(i), y + 24, kind));
        if (note) d.text(centre(0) + 14, y + 28, note, { size: 11.5, fill: c.muted, maxWidth: 60 });
    });
    const legendY = top + ROWS.length * rowH + 40;
    d.line(30, legendY - 40, W - 30, legendY - 40);
    [['full', 'Built in and on by default'], ['part', 'Possible with configuration, add-ons or code'], ['none', 'Not provided'], ['na', 'Not applicable']]
        .forEach(([kind, text], i) => {
            const x = [48, 290, 668, 850][i];
            d.mark(x, legendY - 5, kind);
            d.text(x + 18, legendY, text, { size: 13.5, fill: c.muted, maxWidth: 360 });
        });
    d.text(40, legendY + 36, ['Kinds of system, not single products: each cell is the usual default in public documentation as of November 2026.',
        'Many products do more with configuration or paid add-ons.'], { size: 12, fill: c.muted, maxWidth: W - 80, gap: 1.4 });
    return d.done(W, H, 'How Imprim compares',
        'Imprim against workforce identity providers, developer authentication platforms, self-hosted identity providers and API keys, on agent delegation, audience, token lifetime, revocation, consent, refresh rotation, enterprise directory features, open source and managed hosting.');
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
