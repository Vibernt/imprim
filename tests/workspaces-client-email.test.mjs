import test from 'node:test';
import assert from 'node:assert/strict';
import { sendWorkspaceInvitation } from '../apps/server/src/workspaces/email.mjs';
import { world } from './support/world.mjs';

const workspace = 'Research <img src=x onerror=alert(1)> & "Ops"';
const escaped = 'Research &lt;img src=x onerror=alert(1)&gt; &amp; &quot;Ops&quot;';
const link = 'https://app.example.com/start?from=invite&source=notes';
const translations = {
    en: ['Invitation to', 'invited you to join', 'Products in this workspace', 'Sign in'],
    es: ['Invitación a', 'te ha invitado a unirte a', 'Productos de este espacio de trabajo', 'Iniciar sesión'],
    fr: ['Invitation à rejoindre', 'vous a invité à rejoindre', 'Produits de cet espace de travail', 'Se connecter'],
    de: ['Einladung zu', 'hat Sie eingeladen', 'Produkte in diesem Arbeitsbereich', 'Anmelden'],
    'pt-BR': ['Convite para', 'convidou você para participar de', 'Produtos deste espaço de trabalho', 'Entrar']
};

async function fixture(t) {
    const w = await world(t), db = w.env.DB.db;
    db.prepare('INSERT INTO users(id,email,created) VALUES(?,?,?)').run('inviter', 'lee@example.com', 0);
    db.prepare('INSERT INTO users(id,email,created) VALUES(?,?,?)').run('recipient', 'dana@example.com', 0);
    db.prepare("INSERT INTO workspaces(id,realm_id,kind,name,created) VALUES(?,'default','team',?,0)").run('team-one', workspace);
    const product = db.prepare('INSERT INTO workspace_products(workspace_id,product,created) VALUES(?,?,0)');
    product.run('team-one', 'projects');
    product.run('team-one', 'notes');
    db.prepare("UPDATE clients SET workspaces='shared',product='notes',initiate_login_uri=? WHERE id='app'").run(link);
    db.prepare("UPDATE clients SET workspaces='shared',product='projects',initiate_login_uri='https://projects.example.com/sign-in',branding=? WHERE id='other'")
        .run(JSON.stringify({ name: 'A Projects' }));
    db.prepare(`INSERT INTO workspace_invitations(id,workspace_id,email,role,invited_by,via_client,created,expires_at)
        VALUES(?,?,?,?,?,?,?,?)`).run('invitation', 'team-one', 'dana@example.com', 'member', 'inviter', 'app', Date.now(), Date.now() + 60_000);
    const send = (changes = {}, env = w.env) => sendWorkspaceInvitation(env, {}, {
        invitationId: 'invitation', workspaceId: 'ignored-workspace', email: 'wrong@example.com', role: 'owner',
        inviterEmail: 'wrong@example.com', viaClient: 'other', ...changes
    });
    return { ...w, db, send };
}

test('workspace invitation renders text and branded HTML in all five languages using committed details', async t => {
    const w = await fixture(t);
    for (const [locale, [subject, intro, products, button]] of Object.entries(translations)) {
        w.db.prepare('UPDATE users SET locale=? WHERE id=?').run(locale, 'recipient');
        await w.send();
        const mail = w.mails.at(-1);
        assert.equal(mail.to, 'dana@example.com');
        assert.equal(mail.subject, `${subject} ${workspace}`);
        for (const value of ['lee@example.com', workspace, intro, products, 'notes', 'projects', link])
            assert.ok(mail.text.includes(value), `${locale} text is missing ${value}`);
        for (const value of ['Vibernt', 'lee@example.com', escaped, intro, products, 'notes', 'projects', `>${button}</a>`])
            assert.ok(mail.html.includes(value), `${locale} HTML is missing ${value}`);
        assert.match(mail.html, new RegExp(`<html lang="${locale}"`));
        assert.match(mail.html, /class="im-button-text" href="https:\/\/app\.example\.com\/start\?from=invite&amp;source=notes"/);
        assert.equal(mail.html.match(/class="im-button-text"/g).length, 1);
        assert.ok(!mail.html.includes('<img src=x'));
        assert.ok(!mail.text.includes('wrong@example.com'));
    }
    assert.equal(w.mails.length, 5);
});

test('account and console invitations choose the inviter’s latest product app, then sort by app display name', async t => {
    const w = await fixture(t), { db } = w;
    const projects = 'https://projects.example.com/sign-in';
    db.exec("UPDATE workspace_invitations SET via_client=NULL");
    await w.send();
    assert.ok(w.mails.at(-1).text.includes(projects));
    const admission = db.prepare('INSERT INTO client_admissions(user_id,client_id,created,last_signed_in) VALUES(?,?,0,?)');
    admission.run('inviter', 'app', 42);
    admission.run('inviter', 'other', 41);
    await w.send();
    assert.ok(w.mails.at(-1).text.includes(link));
    db.exec("UPDATE workspace_invitations SET via_client='other'");
    await w.send();
    assert.ok(w.mails.at(-1).text.includes(projects), 'app-sent invitations use the inviting app');
    db.exec('UPDATE workspace_invitations SET via_client=NULL,invited_by=NULL');
    await assert.rejects(w.send(), { code: 'workspace_invitation_sender' });
    const admin = db.prepare('INSERT INTO users(id,email,created) VALUES(?,?,0)');
    admin.run('console-admin', 'admin@example.com');
    admission.run('console-admin', 'app', 43);
    const consoleActor = { inviterEmail: 'admin@example.com', inviterId: 'console-admin' };
    await w.send(consoleActor);
    assert.ok(w.mails.at(-1).text.includes('admin@example.com invited you'));
    assert.ok(w.mails.at(-1).text.includes(link), 'console uses the signed-in administrator’s admission');
    db.exec('UPDATE clients SET initiate_login_uri=NULL');
    await assert.rejects(w.send(consoleActor), { code: 'no_sign_in_address' });
    db.exec("UPDATE workspace_invitations SET via_client='app',invited_by='inviter'");
    await assert.rejects(w.send(), { code: 'no_sign_in_address' });
    db.prepare("UPDATE clients SET initiate_login_uri=? WHERE id='app'").run(w.env.ISSUER + '/login?next=%2Fadmin');
    await assert.rejects(w.send(), { code: 'no_sign_in_address' });
    assert.equal(w.mails.length, 4);
});

test('workspace invitation refuses missing, cross-realm, expired, accepted, revoked and closed records', async t => {
    const w = await fixture(t);
    await assert.rejects(w.send({ invitationId: "missing' OR 1=1 --" }), { code: 'workspace_invitation_unavailable' });
    await assert.rejects(w.send({}, { ...w.env, REALM: { id: 'other-realm' } }), { code: 'workspace_invitation_unavailable' });
    w.db.prepare('UPDATE workspace_invitations SET expires_at=0').run();
    await assert.rejects(w.send(), { code: 'workspace_invitation_unavailable' });
    w.db.prepare('UPDATE workspace_invitations SET expires_at=?,accepted_at=1').run(Date.now() + 60_000);
    await assert.rejects(w.send(), { code: 'workspace_invitation_unavailable' });
    w.db.prepare('UPDATE workspace_invitations SET accepted_at=NULL,revoked_at=1').run();
    await assert.rejects(w.send(), { code: 'workspace_invitation_unavailable' });
    w.db.prepare('UPDATE workspace_invitations SET revoked_at=NULL').run();
    w.db.prepare("UPDATE workspaces SET status='closed'").run();
    await assert.rejects(w.send(), { code: 'workspace_invitation_unavailable' });
    assert.equal(w.mails.length, 0);
});

test('workspace invitation fails explicitly on unavailable sender, unsafe URLs, binding and delivery errors', async t => {
    const w = await fixture(t);
    await assert.rejects(w.send({}, { ...w.env, EMAIL: undefined }), { code: 'email_config' });
    for (const url of ['javascript:alert(1)', 'http://app.example/start', 'https:app.example', 'https://user:pass@app.example', 'https://app.example/a b']) {
        w.db.prepare('UPDATE clients SET initiate_login_uri=? WHERE id=?').run(url, 'app');
        await assert.rejects(w.send(), { code: 'workspace_invitation_link' });
    }
    w.db.prepare('UPDATE clients SET initiate_login_uri=? WHERE id=?').run(link, 'app');
    w.db.prepare('UPDATE workspace_invitations SET via_client=?').run('missing-app');
    await assert.rejects(w.send(), { code: 'workspace_invitation_sender' });
    w.db.prepare('UPDATE workspace_invitations SET via_client=?').run('app');
    let sends = 0;
    const providerError = new Error('Provider unavailable');
    const env = { ...w.env, EMAIL: { async send() { sends++; throw providerError; } } };
    await assert.rejects(w.send({}, env), error => error === providerError);
    assert.equal(sends, 1);
    assert.equal(w.mails.length, 0);
});
