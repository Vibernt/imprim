import { brandCopy, localeOf, t } from '../i18n/index.mjs';
import { realmId } from '../realms/realm.mjs';
import { liveAdmissionSql } from '../services/admission.mjs';
import { appRows } from './ui.mjs';

export const MAX_LISTED_APPS = 6;
const fields = 'c.id,c.branding,c.initiate_login_uri';
const launchable = 'c.realm_id=? AND c.initiate_login_uri IS NOT NULL';
const byName = "coalesce(nullif(json_extract(c.branding,'$.name'),''),c.id) COLLATE NOCASE,c.id";

function entry(env, client) {
    const brand = JSON.parse(client.branding);
    return { id: client.id, name: brand.name || client.id,
        summary: brandCopy(env, { ...brand, locale: brand.locale || env.REALM.branding?.locale, copy: { summary: brand.summary } }, 'summary'),
        mark: brand.mark || brand.logo_light || brand.logo_dark, href: client.initiate_login_uri };
}
export async function yourApps(env, userId) {
    const { results } = await env.DB.prepare(`SELECT ${fields},a.last_signed_in FROM clients c
        JOIN client_admissions a ON a.client_id=c.id AND a.user_id=?
        JOIN users u ON u.id=a.user_id AND u.realm_id=c.realm_id AND u.status='active' AND u.merged_into IS NULL
        WHERE ${launchable} AND (${liveAdmissionSql})
        ORDER BY (SELECT max(s.created) FROM app_sessions s WHERE s.user_id=a.user_id AND s.client_id=c.id) DESC,${byName}
        LIMIT 12`).bind(userId, realmId(env)).all();
    return results.map(client => ({ ...entry(env, client), last_signed_in: client.last_signed_in }));
}
export async function listedApps(env) {
    const { results } = await env.DB.prepare(`SELECT ${fields} FROM clients c
        WHERE ${launchable} AND c.listed=1 LIMIT ?`).bind(realmId(env), MAX_LISTED_APPS + 1).all();
    return results.length > MAX_LISTED_APPS ? [] : results.map(client => entry(env, client))
        .sort((a, b) => a.name.localeCompare(b.name, localeOf(env)));
}
export async function appSignIn(env, id) {
    const client = await env.DB.prepare(`SELECT ${fields} FROM clients c WHERE ${launchable} AND c.id=?`).bind(realmId(env), id).first();
    return client && entry(env, client);
}
export const appList = (env, apps, personal = false) =>
    apps.length ? appRows(personal ? t(env, 'Your apps') : t(env, 'Sign in to an app'), apps) : '';
