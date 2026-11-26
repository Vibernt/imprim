// The address is for display only. Keep it out of URLs, and only on this browser for a short time.
import { cookie, cookies } from './session.mjs';

const name = '__Host-vi_check_email';
export function checkEmailCookie(id, email) {
    return cookie(name, new URLSearchParams({ id, email }).toString(), 120);
}
export function checkEmailAddress(request, id) {
    const state = new URLSearchParams(cookies(request)[name]);
    const email = state.get('email');
    return state.get('id') === id && email && email.length <= 254 ? email : null;
}
