import test from 'node:test';
import assert from 'node:assert/strict';
import { agentWorld } from './support/agents.mjs';
import { adminLogin } from './support/admin.mjs';
for (const reason of ['missing sid','wrong user','origin','csrf','stale auth','ordinary user','audit failure']) test(`admin session revocation refuses ${reason} without effects`, async t => {
    const w = await agentWorld(t), admin = await adminLogin(w);
    w.env.DB.db.prepare('INSERT INTO app_sessions VALUES(?,?,?,?)').run('app', w.user.id, w.signed.session.sid, Date.now());
    let id = w.user.id, sid = w.signed.session.sid, headers = {};
    if (reason === 'missing sid') sid = undefined;
    if (reason === 'wrong user') id = 'another-user';
    if (reason === 'origin') headers.origin = 'https://evil.example';
    if (reason === 'csrf') headers['x-csrf-token'] = 'wrong';
    if (reason === 'stale auth') w.env.DB.db.exec("UPDATE sessions SET auth_time=0 WHERE admin_until IS NOT NULL");
    if (reason === 'audit failure') w.env.DB.db.exec("CREATE TRIGGER fail_session_audit BEFORE INSERT ON audit WHEN NEW.event='admin_revoke_session' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
    const response = reason === 'ordinary user' ? await w.post(`/admin/api/users/${id}/revoke-session`, { sid }, w.cookie, { 'x-csrf-token': w.csrf }) :
        await admin.post(`users/${id}/revoke-session`, { sid }, headers);
    assert.equal(response.status, reason === 'audit failure' ? 500 : reason === 'missing sid' ? 400 : reason === 'wrong user' ? 404 : 403);
    assert.ok(w.env.DB.db.prepare('SELECT 1 FROM sessions WHERE sid=?').get(w.signed.session.sid));
    assert.equal(w.env.DB.db.prepare('SELECT count(*) n FROM logout_outbox').get().n, 0);
    assert.equal(w.env.DB.db.prepare("SELECT count(*) n FROM audit WHERE event='admin_revoke_session'").get().n, 0);
});
