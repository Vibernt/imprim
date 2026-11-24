@AGENTS.md

# Working rules

The Worker uses native ESM with no runtime dependencies and no build step; its only outside import is Fire's modules, bundled from the pinned `fire-design` package. The account and admin interface in `apps/web` is Lit and Vite, built by `npm run build`. Fire v0.12.4 comes from the pinned `fire-design` package and is never edited. Use Web Crypto.
Keep route handlers, authentication, OIDC, effects and page rendering in separate small modules.
Use parameterized SQL, atomic single-use claims, and explicit failures. Never log tokens, codes or secrets.
Test with node:test and the real SQLite D1 harness; use negative tests at trust boundaries.
Use npm run test:quiet while iterating and npm run check before delivery. Report live verification separately.
