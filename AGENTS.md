# Repository rules

Read README.md, docs/ARCHITECTURE.md and docs/ROADMAP.md first. Read docs/PROTOCOL.md before changing protocol behavior.
- The Worker uses native ESM with no runtime dependencies and no build step; its only outside import is Fire's modules, bundled from the pinned `fire-design` package. The account and admin interface in `apps/web` is Lit and Vite, built by `npm run build`. Fire v0.13.2 comes from the pinned `fire-design` package and is never edited. Keep modules small and grouped by concern.
- Preserve imported principal ids as subjects. Apps retain authorization and their own sessions. Apps keep their own memberships unless they opt in to [shared workspaces](docs/WORKSPACES.md), where Imprim manages membership and base roles.
- Never bypass client, browser, Origin, CSRF, admission or single-use boundaries. Add negative tests for each change.
- No network calls inside database transactions. No mocked production success or automatic fallback.
- Explain a failed dependency and any proposed fallback; the owner decides whether to use it.
- Run npm run test:quiet and npm run check. Report uncovered work and unexecuted live checks.
- State the next best action. Plans must settle implementation decisions; ask about genuine ambiguities.
- Do not commit, push, deploy or change secrets without the maintainer's authorization.

## Interface: the Fire design system

- For any interface work, use the `fire` skill if you have it; otherwise read and follow `docs/fire/AGENT-RULES.md` first. It names the other files to read.
- Every screen follows a Fire reference screen. Say which one before you build.
- Never restyle an fd- class. Own tokens and classes carry the prefix im-. When Fire lacks something, build it to
  Fire's standard, write the proposal with `npx fire propose new` and show it to the maintainer; agents do not file it.
  Record it in docs/fire/REQUESTS.md.
- Imprim only: render components with `apps/server/src/pages/ui.mjs`. Two layouts: a single task is a centred screen
  (`page()` in `apps/server/src/pages/layout.mjs`); anything a person returns to sits in the app shell
  (`shellPage()` in `apps/server/src/pages/shell.mjs`). Sign-in and consent screens load no Fire JavaScript. No
  `style` attributes at all: the CSP forbids them.
