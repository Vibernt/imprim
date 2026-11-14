## What and why

<!-- The change, the issue it closes, and the standard it follows if it touches the protocol. -->

## Checklist

- [ ] `npm run test:quiet` and `npm run check` pass
- [ ] Negative tests for every trust boundary this touches (wrong client, realm, audience, state, origin, replay, race)
- [ ] No runtime dependency, no network call inside a D1 batch, no secret or token in logs
- [ ] Docs updated (`docs/PROTOCOL.md` for wire changes)

## Not verified

<!-- Anything that needs a live Cloudflare, browser or provider check. -->
