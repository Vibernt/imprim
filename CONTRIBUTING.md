# Contributing to Imprim

Thank you for helping. Imprim is an identity provider, so the bar for changes is correctness first. These rules
keep it that way.

## Process

1. **Open an issue first** for anything bigger than a typo or an obvious bug. Describe the problem, the behaviour
   you propose, and the standard it follows (an RFC or OpenID spec section) if it is a protocol change. We agree the
   design in the issue before code is written. Security problems go through private reporting instead
   ([SECURITY.md](SECURITY.md)).
2. **Fork and branch** from `main`. Keep one concern per pull request.
3. **Write the change and its tests.** Run both checks before you push:

   ```bash
   npm run test:quiet
   ```

   ```bash
   npm run check
   ```

4. **Open a pull request** using the template. Say what changed, why, which negative tests prove the boundary,
   and anything you could not verify (for example live Cloudflare behaviour).
5. **Review.** A maintainer reviews every change. A change to a trust boundary (sign-in, tokens, consent, admission,
   keys, admin) needs a second reviewer. CI must pass.
6. **Merge.** Maintainers squash-merge. Releases go to staging before production ([docs/DEPLOY.md](docs/DEPLOY.md)).

By contributing, you agree that your contribution is licensed under the [MIT licence](LICENSE).

## Engineering rules

- Native ES modules, Web Crypto, no runtime dependencies, no build step. `npm run check` enforces this.
- Small modules grouped by concern: routes, authentication, OIDC, agents, admin, pages and services stay separate.
- Parameterised SQL only. Single-use values are claimed atomically (`DELETE … RETURNING` or a fenced `INSERT … SELECT`).
- No network calls inside a D1 batch. No mocked success and no automatic fallback: fail explicitly and say why.
- Never log tokens, codes, links, secrets or email addresses.
- Every change at a trust boundary gets a **negative test**: the wrong client, state, audience, realm, browser,
  origin, CSRF token, replay, or race must fail.
- Tests use `node:test` and the real SQLite harness in `tests/support`. Node 22.13 or later.
- Keep `sub` stable. Apps own authorisation; Imprim only proves identity and records consent.
- Update the docs in the same pull request when behaviour changes (`docs/PROTOCOL.md` for anything on the wire).

## Working with a coding agent

`AGENTS.md` and `CLAUDE.md` hold the same rules for coding agents. A good starting prompt:

> Read AGENTS.md, docs/ARCHITECTURE.md and docs/PROTOCOL.md. Then implement issue #N in small modules with negative
> tests at every trust boundary. Run `npm run test:quiet` and `npm run check`, and report anything you could not
> verify.
