# Repository rules

Read README.md, docs/ARCHITECTURE.md and docs/ROADMAP.md first; PLAN.md is the original approved design. Read docs/PROTOCOL.md before changing protocol behavior.
- Native ESM, no runtime dependencies, no build step. Keep modules small and grouped by concern.
- Preserve imported principal ids as subjects. Apps retain authorization, memberships and their own sessions.
- Never bypass client, browser, Origin, CSRF, admission or single-use boundaries. Add negative tests for each change.
- No network calls inside database transactions. No mocked production success or automatic fallback.
- Explain a failed dependency and any proposed fallback; the owner decides whether to use it.
- Run npm run test:quiet and npm run check. Report uncovered work and unexecuted live checks.
- State the next best action. Plans must settle implementation decisions; ask about genuine ambiguities.
- Do not commit, push, deploy, change secrets, or modify the Assay source repository without authorization.
