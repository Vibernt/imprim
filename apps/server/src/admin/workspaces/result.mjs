// A POST result for the existing form URL. The Lit console uses the JSON error and shows a toast.
import { adminPage } from '../pages.mjs';
import { callout, linkButton } from '../../pages/ui.mjs';

export function workspaceEmailFailure(path) {
    const response = adminPage('Invitation email failed', callout('The invitation is saved',
        'Email delivery failed. Check email delivery before inviting this address again.', { tone: 'danger' }) +
        linkButton('View workspace', path, { variant: 'outline' }), { active: 'workspaces' });
    return new Response(response.body, { status: 503, headers: response.headers });
}
