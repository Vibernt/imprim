export class IdentityError extends Error { readonly code: string; readonly description?: string; constructor(code: string, message?: string, description?: string); }
export const JWKS_FRESH_MS: number;
// startLogin also accepts { acrValues?: string; maxAge?: number } for step-up (0.4.0).
export const JWKS_STALE_MS: number;
export interface Claims { iss: string; aud: string | string[]; sub: string; exp: number; iat: number; nonce?: string; sid?: string; jti?: string; auth_time?: number; email?: string; email_verified?: boolean; amr?: string[]; [key: string]: unknown; }
export interface ClientOptions { issuer: string; clientId: string; clientSecret?: string; redirectUri?: string; resourcePrefixes?: string[]; fetch?: typeof globalThis.fetch; }
export interface LoginValues { state: string; nonce: string; codeVerifier: string; }
export interface LoginStart extends LoginValues { url: string; }
export interface AccessClaims extends Claims { aud: string; client_id: string; grant_id: string; scope: string; jti: string; }
export interface ResourceMetadataOptions { resource: string; scopes: string[]; }
export interface ResourceMetadata { resource: string; authorization_servers: string[]; scopes_supported: string[]; bearer_methods_supported: ['header']; }
export interface ChallengeOptions { resourceMetadataUrl: string; error?: 'invalid_request' | 'invalid_token' | 'insufficient_scope'; }
export function wwwAuthenticate(options: ChallengeOptions): string;
export interface EventOptions { clockSkewSeconds?: number; }
export interface EventClientOptions extends ClientOptions, EventOptions {}
export interface LogoutClaims { sub?: string; sid?: string; jti: string; iat: number; exp: number; }
export interface RevocationClaims { sub: string; jti: string; grantId: string; resource: string; iat: number; exp: number; }
export type BackchannelEvent = { kind: 'logout'; claims: LogoutClaims } | { kind: 'revocation'; claims: RevocationClaims };
export function verifyLogoutToken(token: string, options: EventClientOptions): Promise<LogoutClaims>;
export function verifyRevocationToken(token: string, options: EventClientOptions): Promise<RevocationClaims>;
export function verifyBackchannel(form: FormData | URLSearchParams, options: EventClientOptions): Promise<BackchannelEvent>;
export interface IdentityClient {
    verifyLogoutToken(token: string, options?: EventOptions): Promise<LogoutClaims>;
    verifyRevocationToken(token: string, options?: EventOptions): Promise<RevocationClaims>;
    verifyBackchannel(form: FormData | URLSearchParams, options?: EventOptions): Promise<BackchannelEvent>;
    verifyAccessToken(token: string, options: { audience: string; clockSkewSeconds?: number }): Promise<AccessClaims>;
    protectedResourceMetadata(options: ResourceMetadataOptions): ResourceMetadata;
    wwwAuthenticate(options: ChallengeOptions): string;
    startLogin(options?: { state?: string; nonce?: string; prompt?: string; loginHint?: string; method?: 'email' | 'github' | 'google' }): Promise<LoginStart>;
    handleCallback(url: string | URL, values: LoginValues): Promise<Claims>;
    verifyIdToken(jwt: string, options: { nonce: string; maxAge?: number }): Promise<Claims>;
    handleAgentRevocation(request: Request): Promise<{ sub: string; grant_id: string; resource: string; jti: string }>;
    handleBackchannelLogout(request: Request): Promise<{ sub?: string; sid?: string; jti: string }>;
    logoutUrl(options?: { idTokenHint?: string; postLogoutRedirectUri?: string; state?: string }): Promise<string>;
    inviteEmail(email: string): Promise<{ accepted: boolean; expires_at: number }>;
}
export function createClient(options: ClientOptions): IdentityClient;
