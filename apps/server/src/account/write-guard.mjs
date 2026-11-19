// D1 batches are atomic. Assert the preceding guarded write took effect before any dependent writes.
export const requireChange = env => env.DB.prepare('INSERT INTO admin_assertions(ok) VALUES(changes()=1)');
export const writeGuardFailed = error => [error.message, error.cause?.message]
    .some(message => message?.includes('CHECK constraint failed: admin_assertions'));
