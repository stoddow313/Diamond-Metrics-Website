# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Run: `npm run dev` (scripts/dev.js) starts the API and the Vite site together, moves the API off :3001 when another process holds it, and forwards Stripe test-mode webhooks when the Stripe CLI is present. README.md "Running locally" has the flags and the Stripe variables.
- Before handing off: `npm test` (node:test over server/*.test.js; two media test files need a system ffmpeg at /opt/homebrew/bin/ffmpeg or `FFMPEG_PATH`), `npm run lint`, `npm run build`.
- Server pattern: per area, a pure logic module, a data-access store and route modules (`mountX(app, deps)`), e.g. server/tournamentOrderLogic.js, tournamentOrderStore.js, tournamentCheckoutRoutes.js. Schema changes are additive blocks in server/db.js. Mount a new route module in both server/index.js and server/intakeTestHarness.js; a route that needs the raw body (the Stripe webhook) goes before the global `express.json` in both. Errors are `{ error }` JSON. Test files set `DM_DB_PATH` before importing db.js.
- The repository is public: secrets live only in environment variables (Render dashboard; render.yaml declares them with `sync: false` and no value). So do Stripe Price IDs: production's are the four `STRIPE_LIVE_PRICE_*` Render settings, local runs use a test key and `STRIPE_TEST_PRICES`, and the key's mode must match its Prices (server/tournamentOrderLogic.js `priceSettings`; server/tournamentConfig.test.js fails on a real-shaped Price ID or live key in any tracked file). Decisions go in docs/COMMAND_TDR.md, operating notes in docs/COMMAND_OPS.md.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
