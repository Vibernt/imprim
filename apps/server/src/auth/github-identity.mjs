import { providerIdentity } from './provider-identity.mjs';
export const githubIdentity = (env, client, profile, session, pending) => providerIdentity(env, client, 'github', profile, session, pending);
