import { providerIdentity } from './provider-identity.mjs';
export const githubIdentity = (env, client, profile, session) => providerIdentity(env, client, 'github', profile, session);
