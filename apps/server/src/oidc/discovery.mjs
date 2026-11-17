import { offeredBy } from '../i18n/index.mjs';
export function discovery(env) {
    const issuer = env.ISSUER;
    return {
        registration_endpoint: `${issuer}/register`, device_authorization_endpoint: `${issuer}/device_authorization`,
        client_id_metadata_document_supported: true,
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`, jwks_uri: `${issuer}/.well-known/jwks.json`, end_session_endpoint: `${issuer}/logout`,
        introspection_endpoint: `${issuer}/introspect`, revocation_endpoint: `${issuer}/revoke`,
        introspection_endpoint_auth_methods_supported: ['client_secret_basic'], revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'private_key_jwt', 'none'],
        response_types_supported: ['code'], response_modes_supported: ['query'], grant_types_supported: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code', 'client_credentials', 'urn:ietf:params:oauth:grant-type:token-exchange'],
        backchannel_logout_supported: true, backchannel_logout_session_supported: true,
        subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['ES256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'private_key_jwt', 'none'], token_endpoint_auth_signing_alg_values_supported: ['ES256', 'RS256'], dpop_signing_alg_values_supported: ['ES256', 'RS256', 'EdDSA'], code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'email', 'profile'],
        claims_supported: ['iss','aud','azp','sub','iat','exp','email','email_verified','amr','acr','auth_time','sid','nonce','name'],
        acr_values_supported: ['urn:imprim:acr:sf', 'urn:imprim:acr:mfa'],
        authorization_response_iss_parameter_supported: true,
        request_parameter_supported: false, request_uri_parameter_supported: false,
        claims_parameter_supported: false,
        // The languages pages and emails are offered in (OIDC Discovery); ui_locales picks among them.
        ui_locales_supported: offeredBy(env.REALM?.branding || {})
    };
}
