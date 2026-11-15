# Repository rules

Read README.md, docs/ARCHITECTURE.md and docs/ROADMAP.md first. Read docs/PROTOCOL.md before changing protocol behavior.
- Native ESM, no runtime dependencies, no build step. Keep modules small and grouped by concern.
- Preserve imported principal ids as subjects. Apps retain authorization, memberships and their own sessions.
- Never bypass client, browser, Origin, CSRF, admission or single-use boundaries. Add negative tests for each change.
- No network calls inside database transactions. No mocked production success or automatic fallback.
- Explain a failed dependency and any proposed fallback; the owner decides whether to use it.
- Run npm run test:quiet and npm run check. Report uncovered work and unexecuted live checks.
- State the next best action. Plans must settle implementation decisions; ask about genuine ambiguities.
- Do not commit, push, deploy or change secrets without the maintainer's authorization.

## UI: use the Fire design system

- All UI is built with Fire (`apps/server/public/fire`). Read `docs/fire/GUIDE.md` before writing any UI and
  `docs/fire/WRITING.md` before writing any text that appears in it, and look up classes in
  `docs/fire/VOCABULARY.md`. Render components with `apps/server/src/pages/ui.mjs`; copy any other markup from the
  Fire docs, never from memory.
- Use only `fd-` classes that exist in the vocabulary. No custom CSS, no `<style>` blocks, no `style` attributes (the
  CSP forbids them), no pixel values and no widths or heights in markup. Lay out with `fd-stack`, `fd-row`,
  `fd-grid`, `fd-column`, `data-gap`, `data-cols` and `data-span`.
- Never edit files inside `apps/server/public/fire`.
- Build every state: empty, loading, error, disabled. Check light and dark, 1440px and 375px, and keyboard use.
- If Fire lacks something, follow GUIDE.md section 7: look again, compose from existing parts, and if it is a real gap,
  add a request to `docs/fire/REQUESTS.md`, say so, and continue with a stopgap in `localCss`
  (`apps/server/src/pages/layout.mjs`) using `x-` classes and Fire tokens only.

## UI copy: follow WRITING.md

- Write for the gaps only: if the layout, a label or a value already says it, do not write it.
- One job per element, inside the word budgets (WRITING.md section 3). Buttons are a verb, or a verb and its object.
  Placeholders are realistic examples. Hints say one thing: the effect, the default, the limit or an example.
- Empty states say what will appear and how. Errors say what happened and what to do. Success says what is now true.
- Sentence case. Digits with units. Identifiers in mono. No exclamation marks, no "please", "simply", "just", "Oops".
- Security, money and irreversible actions get complete short sentences. Run WRITING.md section 9 before finishing.
