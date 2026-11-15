export class IdentityError extends Error { readonly code: string; readonly description?: string; constructor(code: string, message?: string, description?: string); }
export const JWKS_FRESH_MS: number;
export const JWKS_STALE_MS: number;
export interface Claims { iss: string; aud: string | string[]; sub: string; exp: number; iat: number; nonce?: string; sid?: string; jti?: string; auth_time?: number; email?: string; email_verified?: boolean; amr?: string[]; acr?: string; [key: string]: unknown; }
export interface ClientOptions { issuer: string; clientId: string; clientSecret?: string; redirectUri?: string; resourcePrefixes?: string[]; fetch?: typeof globalThis.fetch; }
export interface LoginValues { state: string; nonce: string; codeVerifier: string; }
export interface LoginStart extends LoginValues { url: string; }
// cnf.jkt is present on a DPoP-bound token; dpop_jti is the verified proof's id, for the app to deduplicate (0.5.0).
export interface AccessClaims extends Claims { aud: string; client_id: string; grant_id: string; scope: string; jti: string; cnf?: { jkt: string }; dpop_jti?: string; }
// The request's DPoP proof: its header value, and the method and URL the request was made with (0.5.0).
export interface DpopProof { proof: string; method: string; url: string; }
export interface ResourceMetadataOptions { resource: string; scopes: string[]; }
export interface ResourceMetadata { resource: string; authorization_servers: string[]; scopes_supported: string[]; bearer_methods_supported: ['header']; }
export interface ChallengeOptions { resourceMetadataUrl: string; error?: 'invalid_request' | 'invalid_token' | 'insufficient_scope'; }
export function wwwAuthenticate(options: ChallengeOptions): string;
export interface EventOptions { clockSkewSeconds?: number; }
export interface EventClientOptions extends ClientOptions, EventOptions {}
export interface LogoutClaims { sub?: string; sid?: string; jti: string; iat: number; exp: number; }
export interface RevocationClaims { sub: string; jti: string; grantId: string; resource: string; iat: number; exp: number; }
// User lifecycle events (0.6.0). `toe` is when the change happened: apply the latest for each person.
export type UserEventName = 'user-updated' | 'user-blocked' | 'user-unblocked' | 'user-deleted' | 'user-merged' | 'mfa-reset';
export interface UserEventClaims { sub: string; jti: string; event: UserEventName; data: { fields?: ('name' | 'email')[]; into?: string }; toe: number; iat: number; exp: number; }
export type BackchannelEvent = { kind: 'logout'; claims: LogoutClaims } | { kind: 'revocation'; claims: RevocationClaims } | { kind: 'user'; claims: UserEventClaims };
export function verifyLogoutToken(token: string, options: EventClientOptions): Promise<LogoutClaims>;
export function verifyRevocationToken(token: string, options: EventClientOptions): Promise<RevocationClaims>;
export function verifyBackchannel(form: FormData | URLSearchParams, options: EventClientOptions): Promise<BackchannelEvent>;
export interface IdentityClient {
    verifyLogoutToken(token: string, options?: EventOptions): Promise<LogoutClaims>;
    verifyRevocationToken(token: string, options?: EventOptions): Promise<RevocationClaims>;
    verifyUserEventToken(token: string, options?: EventOptions): Promise<UserEventClaims>;
    verifyBackchannel(form: FormData | URLSearchParams, options?: EventOptions): Promise<BackchannelEvent>;
    // A DPoP-bound token needs `dpop`; `requireDpop` refuses a bearer token.
    verifyAccessToken(token: string, options: { audience: string; clockSkewSeconds?: number; dpop?: DpopProof; requireDpop?: boolean }): Promise<AccessClaims>;
    protectedResourceMetadata(options: ResourceMetadataOptions): ResourceMetadata;
    wwwAuthenticate(options: ChallengeOptions): string;
    // acrValues and maxAge ask for step-up (0.4.0): 'urn:imprim:acr:mfa' demands a second factor in this session.
    startLogin(options?: { state?: string; nonce?: string; prompt?: string; loginHint?: string; method?: 'email' | 'password' | 'github' | 'google'; acrValues?: string; maxAge?: number }): Promise<LoginStart>;
    handleCallback(url: string | URL, values: LoginValues): Promise<Claims>;
    verifyIdToken(jwt: string, options: { nonce: string; maxAge?: number }): Promise<Claims>;
    handleAgentRevocation(request: Request): Promise<{ sub: string; grant_id: string; resource: string; jti: string }>;
    handleBackchannelLogout(request: Request): Promise<{ sub?: string; sid?: string; jti: string }>;
    handleUserEvent(request: Request): Promise<{ sub: string; event: UserEventName; data: UserEventClaims['data']; toe: number; jti: string }>;
    logoutUrl(options?: { idTokenHint?: string; postLogoutRedirectUri?: string; state?: string }): Promise<string>;
    inviteEmail(email: string): Promise<{ accepted: boolean; expires_at: number }>;
}
export function createClient(options: ClientOptions): IdentityClient;
