import { fill } from '../i18n/languages.mjs';
// `message` is English and is the error's message id; `vars` fill its `{name}` placeholders. People-facing pages and
// browser endpoints show the message translated (i18n/index.mjs, tError); logs and protocol responses keep English.
export class AppError extends Error {
    constructor(status, code, message, vars) { super(fill(message, vars)); this.status = status; this.code = code; this.msgid = message; this.vars = vars; }
}
export function invariant(condition, code, message, status = 400, vars) {
    if (!condition) throw new AppError(status, code, message, vars);
}
// A back-channel endpoint answered but did not accept the event; the status is kept for the delivery report.
export function assertDelivered(response, message) {
    if (response.ok && !response.redirected) return;
    throw Object.assign(new AppError(400, 'backchannel_failed', message), { httpStatus: response.status });
}
