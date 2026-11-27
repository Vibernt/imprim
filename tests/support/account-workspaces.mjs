export function seedAccountWorkspace(db, id, name, { kind = 'team', owner = null, status = 'active', realm = 'default', products = ['notes'] } = {}) {
    const now = Date.now();
    db.prepare('INSERT INTO workspaces(id,realm_id,kind,name,status,personal_owner,created) VALUES(?,?,?,?,?,?,?)')
        .run(id, realm, kind, name, status, kind === 'personal' ? owner : null, now);
    const product = db.prepare('INSERT INTO workspace_products(workspace_id,product,created) VALUES(?,?,?)');
    for (const key of products) product.run(id, key, now);
    if (owner) seedAccountWorkspaceMember(db, id, owner, 'owner', now);
    return id;
}

export function seedAccountWorkspaceMember(db, id, sub, role = 'member', joined = Date.now()) {
    db.prepare('INSERT INTO workspace_members(workspace_id,user_id,role,created,updated) VALUES(?,?,?,?,?)')
        .run(id, sub, role, joined, joined);
}
