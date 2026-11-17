// Fixture for tests/i18n.test.mjs: two message ids the check refuses (template literals), and fine ones.
const t = (env, id) => id, invariant = () => {}, name = 'x';
export const one = env => t(env, `Hello ${name}`);
export const two = ok => invariant(ok, 'invalid_request', `${name} required.`);
export const fine = (env, ok) => [t(env, 'Hello {name}'), invariant(ok, 'invalid_request', 'Fine.')];
