// Every email Imprim sends, as data: English message ids (translated per recipient by i18n) and the shape the text and
// HTML parts are built from (render.mjs). The plain-text part in English is exactly what Imprim has always sent.
//
//   subject   the subject; `prefix` puts the realm's name and a colon in front, as security notices always have
//   heading   the HTML part's heading (the text part has none)
//   before    paragraphs before the link; after: paragraphs after it
//   link      the var holding the URL to open, shown as a button (`button` is its label) and, in text, on its own line
//   review    the HTML part offers "Review your account" (security notices)
//   security  the "If this was not you" paragraph
//   footer    the brand's footer lines in the text part (the HTML part always has its footer)
// Vars named *_url are links in the HTML part; `time` is a timestamp, written in the recipient's language.
import { msg } from '../../i18n/index.mjs';
const notice = (subject, heading, ...before) => ({ subject, prefix: true, heading, before, review: true, security: true, footer: true });
export const EMAILS = Object.freeze({
    sign_in_link: { subject: msg('Sign in to {name}'), heading: msg('Sign in to {name}'), button: msg('Sign in'), link: 'link', footer: true,
        before: [msg('Open this link in the browser where you started, then choose Sign in. It expires in 15 minutes.')],
        after: [msg('Ignore this email if you did not request it.')] },
    password_link: { subject: msg('Set your password for {name}'), heading: msg('Set your password for {name}'), button: msg('Set your password'), link: 'link', footer: true,
        before: [msg('Open this link in the browser where you started, then choose Continue, then set your password. It expires in 15 minutes.')],
        after: [msg('Ignore this email if you did not request it.')] },
    email_change_link: { subject: msg('confirm your new email'), prefix: true, heading: msg('Confirm your new email'), button: msg('Confirm your new email'), link: 'link', footer: false,
        before: [msg('Open this link in the browser where you asked for the change, then choose Confirm. It expires in 15 minutes.')],
        after: [msg('Ignore this email if you did not ask for it.')] },
    new_sign_in: notice(msg('new sign-in'), msg('New sign-in to your account'), msg('Your account was signed in from {device} on {time}.')),
    new_sign_in_at: notice(msg('new sign-in'), msg('New sign-in to your account'), msg('Your account was signed in from {device} in {place} on {time}.')),
    password_changed: notice(msg('your password was changed'), msg('Your password was changed'), msg('Your password was changed on {time}. Other signed-in sessions were signed out.')),
    password_set: notice(msg('a password was set on your account'), msg('A password was set on your account'), msg('A password was set for your account on {time}. Other signed-in sessions were signed out.')),
    mfa_reset: notice(msg('your two-factor authentication was reset'), msg('Your two-factor authentication was reset'),
        msg('An administrator reset two-factor authentication on your account (reason: {reason}). You were signed out and will set it up again at your next sign-in.')),
    recovery_code_used: notice(msg('a recovery code was used'), msg('A recovery code was used'),
        msg('A recovery code was used to sign in. You have one fewer left; generate a new set at /account/mfa if you are running low.')),
    agent_connected: notice(msg('an agent was connected'), msg('An agent was connected'),
        msg('"{agent}" can now act for you in {app} ({workspace}) with: {scopes}. Review or revoke it at {agents_url}.')),
    passkey_added: notice(msg('a passkey was added'), msg('A passkey was added'), msg('A passkey ("{name}") was added to your account.')),
    passkey_removed: notice(msg('a passkey was removed'), msg('A passkey was removed'), msg('The passkey "{name}" was removed from your account.')),
    factor_added: notice(msg('a second factor was added'), msg('A second factor was added'),
        msg('An authenticator app ("{name}") was added to your account. Remembered browsers were signed out of their second-factor exemption.')),
    factor_removed: notice(msg('a second factor was removed'), msg('A second factor was removed'), msg('The authenticator "{name}" was removed from your account.')),
    recovery_codes_regenerated: notice(msg('new recovery codes were generated'), msg('New recovery codes were generated'), msg('Your recovery codes were replaced. The old ones no longer work.')),
    email_change_requested: notice(msg('email change requested'), msg('Someone asked to change your email'),
        msg('Someone signed in to your account asked to change its email to {email}. Nothing changes until that address is confirmed.')),
    email_changed: notice(msg('your email was changed'), msg('Your email was changed'),
        msg('Your account\'s email changed from {old} to {new}. If you did not do this, contact the app you use.')),
    account_deleted: notice(msg('your account was deleted'), msg('Your account was deleted'), msg('Your account was deleted and you were signed out everywhere.'))
});
export const SECURITY = msg('If this was not you, sign in with an email link at {login_url}, then review your account at {account_url}.');
export const WORDS = Object.freeze({ review: msg('Review your account'), paste: msg('Or open this link:'), help: msg('Help: {contact}'),
    privacy: msg('Privacy'), terms: msg('Terms'), poweredBy: msg('Powered by') });
// Device descriptions (lib/device.mjs), translated where they are shown.
export const DEVICE_WORDS = [msg('Browser'), msg('Command line'), msg('{browser} on {system}')];
