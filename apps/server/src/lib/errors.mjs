export class AppError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function invariant(condition, code, message, status = 400) {
    if (!condition) throw new AppError(status, code, message);
}
// A back-channel endpoint answered but did not accept the event; the status is kept for the delivery report.
export function assertDelivered(response, message) {
    if (response.ok && !response.redirected) return;
    throw Object.assign(new AppError(400, 'backchannel_failed', message), { httpStatus: response.status });
}
