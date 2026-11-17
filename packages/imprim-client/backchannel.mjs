// Authenticated event claims only. Applications own durable replay/effect transactions.
const logoutEvent = 'http://schemas.openid.net/event/backchannel-logout';
// Agent revocation is an RFC 8417 security event whose type is relative to the issuer (one per realm).
const revocationEvent = issuer => `${issuer}/events/agent-revoked`;
const nonempty = value => typeof value === 'string' && value.length > 0;
function eventClaims(header, claims, { issuer, clientId, clockSkewSeconds = 60 }, kind, fail) {
    if (!Number.isInteger(clockSkewSeconds) || clockSkewSeconds < 0 || clockSkewSeconds > 60)
        fail('configuration', 'Clock skew must be an integer from 0 to 60 seconds.');
    const now = Math.floor(Date.now() / 1000), eventName = kind === 'logout' ? logoutEvent : revocationEvent(issuer);
    const event = claims.events?.[eventName];
    if (header.typ !== (kind === 'logout' ? 'logout+jwt' : 'secevent+jwt') || claims.iss !== issuer || claims.aud !== clientId ||
        claims.nonce !== undefined || !nonempty(claims.jti) ||
        !claims.events || typeof claims.events !== 'object' || Array.isArray(claims.events) || Object.keys(claims.events).length !== 1 ||
        !event || typeof event !== 'object' || Array.isArray(event) || Object.keys(event).length !== 0 ||
        !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.exp <= claims.iat || claims.exp - claims.iat > 900 ||
        claims.exp <= now || claims.iat > now + clockSkewSeconds ||
        (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > now + clockSkewSeconds)))
        fail('invalid_token', 'Invalid back-channel token type, event, issuer, audience or time.');
}
function eventResource(value, fail, code = 'invalid_token') {
    let url;
    try { url = new URL(value); } catch { fail(code, 'Invalid resource URL.'); }
    if (typeof value !== 'string' || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        url.href !== value || /[\s\\]/.test(value) || /%(?:2f|5c|2e|00)/i.test(url.pathname)) fail(code, 'Invalid resource URL.');
    try { decodeURIComponent(url.pathname); } catch { fail(code, 'Invalid resource encoding.'); }
    return url;
}
export function validateResourcePrefixes(prefixes, fail) {
    if (prefixes === undefined) return;
    if (!Array.isArray(prefixes)) fail('configuration', 'resourcePrefixes must be an array.');
    for (const prefix of prefixes) eventResource(prefix, fail, 'configuration');
}
// User lifecycle events (0.6.0): one `${issuer}/events/<event>` with a small payload object.
export const USER_EVENTS = ['user-updated', 'user-blocked', 'user-unblocked', 'user-deleted', 'user-merged', 'mfa-reset'];
const workspaceMemberEvents = ['workspace-member-added', 'workspace-member-removed', 'workspace-role-changed'];
const workspaceEvents = [...workspaceMemberEvents, 'workspace-updated', 'workspace-products-changed', 'workspace-closed'];
function lifecycleEvent(header, claims, { issuer, clientId, clockSkewSeconds = 60 }, events, fail) {
    if (!Number.isInteger(clockSkewSeconds) || clockSkewSeconds < 0 || clockSkewSeconds > 60) fail('configuration', 'Clock skew must be an integer from 0 to 60 seconds.');
    const now = Math.floor(Date.now() / 1000), keys = claims.events && typeof claims.events === 'object' && !Array.isArray(claims.events) ? Object.keys(claims.events) : [];
    const name = keys.length === 1 && keys[0].startsWith(`${issuer}/events/`) ? keys[0].slice(issuer.length + 8) : null, payload = name && claims.events[keys[0]];
    if (header.typ !== 'secevent+jwt' || claims.iss !== issuer || claims.aud !== clientId || !nonempty(claims.jti) || claims.nonce !== undefined ||
        !events.includes(name) || !payload || typeof payload !== 'object' || Array.isArray(payload) ||
        !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.exp <= claims.iat || claims.exp - claims.iat > 900 || claims.exp <= now || claims.iat > now + clockSkewSeconds ||
        (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > now + clockSkewSeconds)) || !Number.isInteger(claims.toe) || claims.toe > claims.iat + clockSkewSeconds)
        fail('invalid_token', events === USER_EVENTS ? 'Invalid user event token.' : 'Invalid workspace event token.');
    return { name, payload };
}
function userEventClaims(header, claims, options, fail) {
    const { name, payload } = lifecycleEvent(header, claims, options, USER_EVENTS, fail);
    if (!nonempty(claims.sub) ||
        (payload.fields !== undefined && !(Array.isArray(payload.fields) && payload.fields.every(f => ['name', 'email'].includes(f)))) || (payload.into !== undefined && !nonempty(payload.into)))
        fail('invalid_token', 'Invalid user event token.');
    // toe orders events: apply the one with the latest toe for each person.
    return { sub: claims.sub, jti: claims.jti, event: name, data: payload, toe: claims.toe, iat: claims.iat, exp: claims.exp };
}
function workspaceEventClaims(header, claims, options, fail) {
    const { name, payload } = lifecycleEvent(header, claims, options, workspaceEvents, fail);
    const { workspace_id, version, role, products } = payload;
    if (typeof workspace_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(workspace_id) ||
        !Number.isSafeInteger(version) || version < 1 ||
        (workspaceMemberEvents.includes(name) ? !nonempty(claims.sub) : claims.sub !== undefined) ||
        ((name === 'workspace-member-added' || name === 'workspace-role-changed') && !['owner', 'admin', 'member', 'viewer'].includes(role)) ||
        (name === 'workspace-updated' && !nonempty(payload.name)) ||
        (name === 'workspace-products-changed' && !(Array.isArray(products) && products.every(product => typeof product === 'string' && /^[a-z][a-z0-9-]{1,39}$/.test(product)))))
        fail('invalid_token', 'Invalid workspace event token.');
    return { event: name, workspaceId: workspace_id, sub: claims.sub, version, payload, jti: claims.jti };
}
export function validateBackchannelClaims(header, claims, options, kind, fail) {
    if (kind === 'user') return userEventClaims(header, claims, options, fail);
    if (kind === 'workspace') return workspaceEventClaims(header, claims, options, fail);
    eventClaims(header, claims, options, kind, fail);
    if (kind === 'logout') {
        if ((claims.sub !== undefined && !nonempty(claims.sub)) || (claims.sid !== undefined && !nonempty(claims.sid)) ||
            (!claims.sub && !claims.sid)) fail('invalid_token', 'Logout requires sub or sid.');
        return { sub: claims.sub, sid: claims.sid, jti: claims.jti, iat: claims.iat, exp: claims.exp };
    }
    if (!['sub','grant_id','resource'].every(key => nonempty(claims[key]))) fail('invalid_token', 'Missing revocation claims.');
    const resource = eventResource(claims.resource, fail);
    if (options.resourcePrefixes !== undefined && !options.resourcePrefixes.some(value => {
        const prefix = eventResource(value, fail, 'configuration');
        return resource.origin === prefix.origin && (resource.pathname === prefix.pathname ||
            resource.pathname.startsWith(prefix.pathname.endsWith('/') ? prefix.pathname : prefix.pathname + '/'));
    })) fail('invalid_token', 'Resource is outside configured prefixes.');
    return { sub: claims.sub, jti: claims.jti, grantId: claims.grant_id, resource: claims.resource, iat: claims.iat, exp: claims.exp };
}
export function backchannelMethods(verify, fail) {
    const verifyLogoutToken = (token, options = {}) => verify(token, { logout: true, clockSkewSeconds: options.clockSkewSeconds });
    const verifyRevocationToken = (token, options = {}) => verify(token, { revocation: true, clockSkewSeconds: options.clockSkewSeconds });
    const verifyUserEventToken = (token, options = {}) => verify(token, { userEvent: true, clockSkewSeconds: options.clockSkewSeconds });
    const formFields = [
        ['logout_token', 'logout', verifyLogoutToken],
        ['revocation_token', 'revocation', verifyRevocationToken],
        ['event_token', 'user', verifyUserEventToken],
        ['workspace_token', 'workspace', (token, options = {}) => verify(token, { workspaceEvent: true, clockSkewSeconds: options.clockSkewSeconds })]
    ];
    async function verifyBackchannel(form, options) {
        if (!form || typeof form.getAll !== 'function') fail('invalid_response', 'FormData or URLSearchParams required.');
        const tokens = formFields.flatMap(([field, kind, verifyToken]) => form.getAll(field).map(token => ({ kind, verifyToken, token })));
        if (tokens.length !== 1) fail('invalid_response', 'Exactly one back-channel token required.');
        const [{ kind, verifyToken, token }] = tokens;
        if (!nonempty(token)) fail('invalid_response', 'A nonempty token string is required.');
        return { kind, claims: await verifyToken(token, options) };
    }
    async function readEvent(request, kind) {
        if (request.method !== 'POST' || request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded')
            fail('invalid_response', 'A form-encoded POST is required.');
        let form;
        try { form = await request.formData(); } catch { fail('invalid_response', 'Invalid back-channel form.'); }
        const event = await verifyBackchannel(form);
        if (event.kind !== kind) fail('invalid_token', 'Wrong back-channel event kind.');
        return event.claims;
    }
    return {
        verifyLogoutToken, verifyRevocationToken, verifyUserEventToken, verifyBackchannel,
        // { sub, event, data, toe, jti }: deduplicate jti; apply by latest toe; event is one of USER_EVENTS.
        async handleUserEvent(request) {
            const { sub, event, data, toe, jti } = await readEvent(request, 'user');
            return { sub, event, data, toe, jti };
        },
        async handleBackchannelLogout(request) {
            const { sub, sid, jti } = await readEvent(request, 'logout');
            return { sub, sid, jti };
        },
        async handleAgentRevocation(request) {
            const { sub, grantId, resource, jti } = await readEvent(request, 'revocation');
            return { sub, grant_id: grantId, resource, jti };
        }
    };
}
