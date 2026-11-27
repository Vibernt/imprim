import { html } from 'lit';
import { navigate } from '../../lib/router';
import { text } from './core-fields';
import { card, confirmPhrase, userPath } from './core-view';
import type { UserRecord } from './user-record';

export type Review = 'block' | 'reset-mfa' | 'merge' | 'delete';
export type UserAction = Exclude<Review, 'merge'> | 'unblock';

export const labels = {
  block: 'Block user', unblock: 'Unblock user', delete: 'Delete user',
  'reset-mfa': 'Reset two-step verification', merge: 'Merge into another user',
};

const consequences: Record<Review, string> = {
  block: 'Ends every session and agent grant.',
  delete: 'Permanently deletes the user and ends every session and agent grant.',
  'reset-mfa': 'Removes verification methods so the person can enrol again.',
  merge: 'Merging deletes this user.',
};

export const userActionsId = 'user-actions';
export const reviewField = (action: Review) => action === 'merge' ? 'surviving_id' :
  action === 'reset-mfa' ? 'reason' : 'confirm-user-action';

export function userConfirmation(user: UserRecord, action: Review, pending: boolean, cancel: () => void,
  apply: (action: Exclude<UserAction, 'unblock'>, body?: object) => void) {
  const fields = action === 'reset-mfa' ? text({
    id: 'reason', name: 'reason', label: 'Reason', required: true, minlength: 5, maxlength: 500,
    placeholder: 'Lost phone, identity checked by video call', hint: 'Kept in the audit log. The person is told by email.',
  }) : action === 'merge' ? text({
    id: 'surviving_id', name: 'surviving_id', label: 'Surviving user ID', required: true, mono: true,
  }) : undefined;
  return card(labels[action], html`${confirmPhrase({
    id: 'confirm-user-action', phrase: user.email, label: 'Type the user’s email', fields,
    action: action === 'merge' ? 'Review merge' : labels[action], pending, cancel,
    variant: action === 'merge' ? 'primary' : 'danger',
    submit: (_, data) => {
      if (action === 'merge') {
        const surviving_id = String(data.get('surviving_id'));
        void navigate(userPath(user.id) + '/merge?' + new URLSearchParams({ surviving_id }));
      } else {
        apply(action, action === 'reset-mfa' ? { reason: data.get('reason') } : {});
      }
    },
  })}`, consequences[action]);
}
