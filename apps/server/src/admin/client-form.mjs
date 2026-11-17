// The console's client form, turned into the object the admin API takes. Nobody types JSON in the form: a list arrives
// one value per line, names with values as "name = value" lines, a switch as a checked box, a group as one box per
// choice. A value that starts with [ or { is read as JSON, which is what Fire's controls post when they carry
// data-format="json" (docs/fire/GUIDE.md section 5, "Forms").
import { invariant } from '../lib/errors.mjs';
const LISTS = ['redirect_uris', 'post_logout_uris', 'allowed_domains', 'google_hosted_domains', 'agent_allowlist', 'agent_resource_prefixes'];
// Groups of checkboxes, each box named `group.choice`. The order of the boxes is the order saved.
const GROUPS = ['sign_in_methods', 'agent_registration_methods'];
const NUMBERS = ['dev', 'agent_max_grant_days', 'version', 'mfa_trusted_device_days', 'agent_token_rate'];
// A switch posts its "on" value when checked and nothing otherwise: [on, off].
export const SWITCHES = { dev: ['1', 0], agent_access: ['on', 'off'], user_events: ['on', 'off'], agent_consent_mfa: ['required', 'off'], agent_dpop: ['required', 'optional'], classic_oidc: ['on', 'off'] };
const lines = text => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
const jsonOr = (text, open, otherwise) => text.trimStart().startsWith(open) ? JSON.parse(text) : otherwise(text);
function pairs(text) {
    const out = {};
    for (const line of lines(text)) {
        const at = line.indexOf('=');
        invariant(at > 0, 'invalid_request', `Write each line as "name = value". This one has no name: ${line.slice(0, 60)}`);
        out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    return out;
}
// body: the posted fields, already unique (lib/http.mjs). A form from the editor carries editor=1, which says every
// setting was on the page: a missing switch is then off and a missing group is empty. Other posts change only the
// fields they name.
export function clientFromForm(body) {
    const out = {};
    for (const [key, value] of Object.entries(body)) {
        if (key === 'editor') continue;
        const group = GROUPS.find(name => key.startsWith(`${name}.`));
        try {
            if (group) (out[group] ??= []).push(key.slice(group.length + 1));
            else if (LISTS.includes(key) || GROUPS.includes(key)) out[key] = jsonOr(value, '[', lines);
            else if (key === 'agent_scope_catalogue') out[key] = jsonOr(value, '{', pairs);
            // Each app's scopes are written with spaces between them.
            else if (key === 'token_exchange_from') out[key] = Object.fromEntries(Object.entries(jsonOr(value, '{', pairs))
                .map(([id, scopes]) => [id, typeof scopes === 'string' ? scopes.split(/[\s,]+/).filter(Boolean) : scopes]));
            else if (key === 'branding') out[key] = JSON.parse(value);
            else if (NUMBERS.includes(key)) out[key] = Number(value);
            else out[key] = value;
        } catch (error) {
            if (error.code) throw error;
            invariant(false, 'invalid_request', `${key} isn’t valid JSON. Check its brackets and quotes.`);
        }
    }
    if (body.editor === '1') {
        for (const name of GROUPS) out[name] ??= [];
        for (const [name, [, off]] of Object.entries(SWITCHES)) out[name] ??= off;
    }
    return out;
}
