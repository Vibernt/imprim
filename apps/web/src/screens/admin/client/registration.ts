import { checks, formSection, list, text } from '../core-fields';
import { METHODS, ordered } from '../sign-in-methods';
import type { ClientFields } from './model';

export const redirectField = (client: ClientFields) => list({
  id: 'f-redirect_uris', label: 'Redirect URLs', name: 'redirect_uris', values: client.redirect_uris, required: true,
  rows: 3, pattern: '^https?://', placeholder: 'https://notes.example.com/callback',
  hint: 'Exact URLs. People return here after signing in.',
});

export const signInMethods = (client: ClientFields, providers: Record<string, string>) => checks({
  id: 'f-sign_in_methods', label: 'Sign-in methods', name: 'sign_in_methods',
  options: ordered(client.sign_in_methods, { ...METHODS, ...providers }), chosen: client.sign_in_methods,
  hint: 'The sign-in page shows them in this order. A method you turn on goes last.',
});

export function registrationSections(defaults: ClientFields, providers: Record<string, string>) {
  return [
    formSection('register-app', 'App', 'How people recognise this app on Imprim.',
      text({ id: 'f-display_name', label: 'Display name', name: 'display_name', required: true, maxlength: 200, placeholder: 'Team notes' }),
      text({ id: 'f-id', label: 'Client ID', name: 'id', value: defaults.id, required: true, mono: true,
        pattern: '[A-Za-z0-9_\\-]{1,200}', placeholder: 'notes', hint: 'Letters, numbers, dashes and underscores. It can’t change later.' })),
    formSection('register-sign-in', 'Sign-in', 'Where people return and how they sign in.',
      redirectField(defaults), signInMethods(defaults, providers)),
  ];
}
