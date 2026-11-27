import { setup } from './workspaces.mjs';
import { accountSession, change, read } from './account-api.mjs';
import { seedAccountWorkspace, seedAccountWorkspaceMember } from './account-workspaces.mjs';

export const base = 'workspaces';
export const team = base + '/team';
export const invite = { email: 'invitee@example.com', role: 'member' };
export const ownerEmail = 'owner@example.com';

export async function fixture(t) {
    const w = await setup(t), { db } = w;
    const [owner, admin, member, viewer, stranger] = await Promise.all([
        ownerEmail, 'staff@example.com', 'member@example.com', 'viewer@example.com', 'admin@example.com'
    ].map(email => accountSession(w, email)));
    seedAccountWorkspace(db, 'team', 'Alpha team', { owner: owner.user.id, products: ['notes', 'tasks'] });
    for (const [who, role] of [[admin, 'admin'], [member, 'member'], [viewer, 'viewer']])
        seedAccountWorkspaceMember(db, 'team', who.user.id, role);
    const get = (path = base, who = owner) => read(w, path, who.cookie);
    const post = (action, body = {}, who = owner, path = team, headers = {}) => change(w, path + '/' + action, body, who.cookie, headers);
    const roster = () => db.prepare('SELECT user_id,role FROM workspace_members WHERE workspace_id=? ORDER BY user_id').all('team');
    const version = () => db.prepare('SELECT version FROM workspaces WHERE id=?').get('team').version;
    return { ...w, owner, admin, member, viewer, stranger, get, post, rawPost: w.post, roster, version };
}

