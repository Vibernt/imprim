// RFC 9728 resource metadata and RFC 6750 challenges. The issuer is supplied by createClient.
export function resourceMetadata(issuer, { resource, scopes } = {}, fail) {
    validateResourceUrl(resource, fail);
    if (!Array.isArray(scopes) || new Set(scopes).size !== scopes.length || !scopes.every(scope => typeof scope === 'string' && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope))) fail('configuration', 'Invalid resource scopes.');
    return { resource, authorization_servers: [issuer], scopes_supported: [...scopes], bearer_methods_supported: ['header'] };
}
export function validateResourceUrl(value, fail) {
    let url;
    try { url = new URL(value); } catch { fail('configuration', 'Invalid resource URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.href !== value || /[\s\\]/.test(value)) fail('configuration', 'A canonical HTTPS URL is required.');
}
export function challengeHeader({ resourceMetadataUrl, error } = {}, fail) {
    validateResourceUrl(resourceMetadataUrl, fail);
    if (/["\x00-\x20\x7f]/.test(resourceMetadataUrl)) fail('configuration', 'Unsafe metadata URL.');
    if (error !== undefined && !['invalid_request','invalid_token','insufficient_scope'].includes(error)) fail('configuration', 'Invalid bearer error.');
    return `Bearer resource_metadata="${resourceMetadataUrl}"${error ? `, error="${error}"` : ''}`;
}
export function validateAccessClaims(header, claims, audience, issuer, fail, clockSkewSeconds = 60) {
    if (!Number.isInteger(clockSkewSeconds) || clockSkewSeconds < 0 || clockSkewSeconds > 60)
        fail('configuration', 'Clock skew must be an integer from 0 to 60 seconds.');
    validateResourceUrl(audience, fail);
    const now = Math.floor(Date.now() / 1000);
    if (header.typ !== 'at+jwt' || claims.iss !== issuer || claims.aud !== audience ||
        !['sub','client_id','grant_id','jti','scope'].every(name => typeof claims[name] === 'string' && claims[name].length > 0) ||
        !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.exp <= now || claims.iat > now + clockSkewSeconds ||
        claims.exp <= claims.iat || claims.exp - claims.iat > 60 ||
        (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > now + clockSkewSeconds)) ||
        !claims.scope.split(' ').every(scope => /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope))) fail('invalid_token', 'Invalid access-token claims, time, type, or audience.');
    return claims;
}
