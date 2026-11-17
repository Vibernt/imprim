# Repository rules

Read README.md, docs/ARCHITECTURE.md and docs/ROADMAP.md first. Read docs/PROTOCOL.md before changing protocol behavior.
- Native ESM, no runtime dependencies, no build step. Keep modules small and grouped by concern.
- Preserve imported principal ids as subjects. Apps retain authorization and their own sessions. Apps keep their own memberships unless they opt in to [shared workspaces](docs/WORKSPACES.md), where Imprim manages membership and base roles.
- Never bypass client, browser, Origin, CSRF, admission or single-use boundaries. Add negative tests for each change.
- No network calls inside database transactions. No mocked production success or automatic fallback.
- Explain a failed dependency and any proposed fallback; the owner decides whether to use it.
- Run npm run test:quiet and npm run check. Report uncovered work and unexecuted live checks.
- State the next best action. Plans must settle implementation decisions; ask about genuine ambiguities.
- Do not commit, push, deploy or change secrets without the maintainer's authorization.

## Interface: the Fire design system

- For any interface work, read and follow `docs/fire/AGENT-RULES.md` first. It names the other files to read.
- Fire is in `apps/server/public/fire`. Never edit it.
- Gaps in Fire go in `docs/fire/REQUESTS.md`. Stopgap styles go in `localCss` (`apps/server/src/pages/layout.mjs`),
  with `x-` classes and Fire tokens only.
- Imprim only: render components with `apps/server/src/pages/ui.mjs`. Two layouts: a single task is a centred screen
  (`page()` in `apps/server/src/pages/layout.mjs`); anything a person returns to sits in the app shell
  (`shellPage()` in `apps/server/src/pages/shell.mjs`). Sign-in and consent screens load no Fire JavaScript. No
  `style` attributes at all: the CSP forbids them.
