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
export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer';
export type WorkspaceKind = 'team' | 'personal';
export type WorkspaceEventName = 'workspace-member-added' | 'workspace-member-removed' | 'workspace-role-changed' |
    'workspace-updated' | 'workspace-products-changed' | 'workspace-closed';
export interface WorkspaceEventClaims {
    event: WorkspaceEventName;
    workspaceId: string;
    sub: string | undefined;
    version: number;
    payload: { workspace_id: string; version: number; role?: WorkspaceRole; name?: string; products?: string[] };
    jti: string;
}
export type BackchannelEvent = { kind: 'logout'; claims: LogoutClaims } | { kind: 'revocation'; claims: RevocationClaims } |
    { kind: 'user'; claims: UserEventClaims } | { kind: 'workspace'; claims: WorkspaceEventClaims };
export interface WorkspaceSummary { workspace_id: string; name: string; kind: WorkspaceKind; created_via: 'signup' | null; products: string[]; version: number; }
export interface WorkspaceDetails extends WorkspaceSummary { status: 'active' | 'closed'; }
export interface WorkspaceMembership extends WorkspaceSummary { role: WorkspaceRole; }
export interface WorkspaceMember { sub: string; email: string; role: WorkspaceRole; }
export interface WorkspaceInvitationReceipt { invitation_id: string; expires_at: number; }
export interface WorkspaceInvitation extends WorkspaceInvitationReceipt { email: string; role: WorkspaceRole; }
export interface WorkspaceActor { actorToken: string; }
export type CreateWorkspaceOptions = WorkspaceActor & (
    { kind?: 'team'; name: string; products: string[]; firstOwnerEmail: string } | { kind: 'personal'; name: string }
);
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
    handleCallback(url: string | URL, values: LoginValues, options: { idToken: true }): Promise<{ claims: Claims; idToken: string }>;
    handleCallback(url: string | URL, values: LoginValues, options?: { idToken?: false | undefined }): Promise<Claims>;
    verifyIdToken(jwt: string, options: { nonce: string; maxAge?: number }): Promise<Claims>;
    handleAgentRevocation(request: Request): Promise<{ sub: string; grant_id: string; resource: string; jti: string }>;
    handleBackchannelLogout(request: Request): Promise<{ sub?: string; sid?: string; jti: string }>;
    handleUserEvent(request: Request): Promise<{ sub: string; event: UserEventName; data: UserEventClaims['data']; toe: number; jti: string }>;
    logoutUrl(options?: { idTokenHint?: string; postLogoutRedirectUri?: string; state?: string }): Promise<string>;
    inviteEmail(email: string): Promise<{ accepted: boolean; expires_at: number }>;
    user(sub: string): Promise<{ sub: string; email: string; email_verified: boolean; name: string | null }>;
    listGrants(options: { resource: string; sub?: string; limit?: number; cursor?: string | null }): Promise<{ grants: AgentGrant[]; next_cursor: string | null }>;
    revokeGrant(grantId: string): Promise<{ grant_id: string; revoked: true }>;
    introspect(token: string, options?: { tokenTypeHint?: 'access_token' | 'refresh_token' }): Promise<Introspection>;
    memberships(sub: string): Promise<{ memberships: WorkspaceMembership[] }>;
    joinableWorkspaces(options: WorkspaceActor): Promise<{ workspaces: WorkspaceSummary[] }>;
    workspace(id: string): Promise<WorkspaceDetails>;
    workspaceMembers(id: string, options?: { limit?: number; cursor?: string | null }): Promise<{ members: WorkspaceMember[]; next_cursor: string | null; version: number }>;
    createWorkspace(options: CreateWorkspaceOptions): Promise<unknown>;
    renameWorkspace(id: string, options: WorkspaceActor & { name: string }): Promise<unknown>;
    setWorkspaceProducts(id: string, options: WorkspaceActor & { add: string[]; remove: string[] }): Promise<unknown>;
    inviteToWorkspace(id: string, options: WorkspaceActor & { email: string; role: WorkspaceRole }): Promise<WorkspaceInvitationReceipt>;
    workspaceInvitations(id: string): Promise<{ invitations: WorkspaceInvitation[] }>;
    revokeWorkspaceInvitation(id: string, invitationId: string, options: WorkspaceActor): Promise<unknown>;
    setMemberRole(id: string, sub: string, options: WorkspaceActor & { role: WorkspaceRole }): Promise<unknown>;
    removeMember(id: string, sub: string, options: WorkspaceActor): Promise<unknown>;
    closeWorkspace(id: string, options: WorkspaceActor & { confirm?: string }): Promise<unknown>;
    holdWorkspace(id: string, reason: string): Promise<unknown>;
    releaseWorkspace(id: string, reason?: string): Promise<unknown>;
    registerWorkspaceResource(id: string, resource: string): Promise<unknown>;
    unregisterWorkspaceResource(id: string, resource: string): Promise<unknown>;
}
export type AgentAssurance = 'key' | 'redirect' | 'claimed' | 'none';
export interface AgentGrant {
    grant_id: string; sub: string; agent: string; agent_name: string; agent_verified: boolean; agent_assurance?: AgentAssurance;
    scope: string; created: number; last_used: number | null; expires_at: number;
}
export type Introspection = { active: false } | {
    active: true; token_type: 'Bearer' | 'DPoP'; iss: string; sub: string; aud: string; scope: string; client_id: string; grant_id: string;
    exp: number; iat: number; grant_issued_at?: number; agent_assurance?: AgentAssurance; act?: { sub: string }; cnf?: { jkt: string };
};
export function createClient(options: ClientOptions): IdentityClient;
