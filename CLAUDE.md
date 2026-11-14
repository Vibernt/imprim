@AGENTS.md

# Working rules

Use native .mjs modules and Web Crypto. No runtime packages or generated frontend build.
Keep route handlers, authentication, OIDC, effects and page rendering in separate small modules.
Use parameterized SQL, atomic single-use claims, and explicit failures. Never log tokens, codes or secrets.
Test with node:test and the real SQLite D1 harness; use negative tests at trust boundaries.
Use npm run test:quiet while iterating and npm run check before delivery. Report live verification separately.
