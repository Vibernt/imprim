export function seedSignupRequest(db) {
    const id = crypto.randomUUID(), email = 'applicant@example.net', name = 'Applicant team', now = Date.now();
    db.exec(`UPDATE realms SET config=json_set(config,'$.workspaces','on','$.signup','approval') WHERE id='default';
        UPDATE clients SET workspaces='shared',product='notes',self_signup='on',signup_policy='invited' WHERE id='app'`);
    db.prepare(`INSERT INTO signup_requests(id,realm_id,client_id,product,email,workspace_name,locale,created,verified_at)
        VALUES(?,'default','app','notes',?,?,'en',?,?)`).run(id, email, name, now, now);
    return { id, email, name };
}
