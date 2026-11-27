export const quote = value => `'${String(value).replaceAll("'", "''")}'`;
export const realmIdShape = value => typeof value === 'string' && /^[a-z0-9-]{1,40}$/.test(value);
export const requireChange = 'INSERT INTO admin_assertions(ok) VALUES(changes()=1);';

export function platformAppUserGuard(realm, email, allowAppUser) {
    const message = 'A platform roster entry bars this address from apps. The address must have no app admission or workspace membership in this realm.';
    if (allowAppUser) {
        const warning = 'WARNING: Adding a platform administrator even if this address has app access in this realm.';
        console.error(warning);
        return [`-- ${warning}`];
    }
    return [`-- ${message}`,
        `INSERT INTO admin_assertions(ok) VALUES(NOT EXISTS(
    SELECT 1 FROM users u WHERE u.realm_id=${realm} AND u.email=${email} AND (
        EXISTS(SELECT 1 FROM client_admissions a WHERE a.user_id=u.id)
        OR EXISTS(SELECT 1 FROM workspace_members m WHERE m.user_id=u.id)
    )
));`];
}

export function operatorAudit(realm, event, target, detail = {}) {
    const payload = quote(JSON.stringify({ ...detail, source: 'operator-cli' }));
    return `INSERT INTO audit(event,actor,target,detail,created,realm_id)
VALUES(${quote(event)},'operator-cli',${target ?? 'NULL'},${payload},unixepoch()*1000,${realm});`;
}
