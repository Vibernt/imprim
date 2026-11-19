export type Role = 'owner' | 'admin' | 'member' | 'viewer';
interface Summary {
  id: string;
  name: string;
  kind: 'team' | 'personal';
  status: 'active' | 'closed';
  products: string[];
}
export interface Workspace extends Summary {
  editable: boolean;
  can_invite: boolean;
  can_grant_owner: boolean;
  members: { id: string; email: string; role: Role; manageable: boolean }[];
  invitations: { id: string; email: string; role: Role; expires_at: number }[];
  resources: { client_id: string; resource: string }[];
  holds: { client_id: string; reason: string }[];
  audit: { actor: string | null; event: string; created: number }[];
}
export interface ListPage {
  enabled: true;
  workspaces: (Summary & { members: number })[];
  next: string | null;
}
export type WorkspacePage = { enabled: false } | ListPage | { enabled: true; workspace: Workspace };
export type Action = 'create' | 'rename' | 'products' | 'invite' | 'revoke-invitation' | 'role' | 'remove-member' | 'close';
export type Submit = (action: Action, event: SubmitEvent) => void;
export const root = '/admin/workspaces';
export const workspacePath = (id: string) => root + '/' + encodeURIComponent(id);
