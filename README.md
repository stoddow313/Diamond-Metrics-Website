# Diamond Metrics

Marketing site + player-profile platform. React (Vite) frontend with a local Node/Express + SQLite backend.

## Running locally

```bash
npm install
npm run dev        # starts the API (:3001) and the web app (:5173) together
```

- `npm run server` — API only
- `npm run dev:web` — Vite only
- `PORT=5901 HOST=0.0.0.0 npm run dev -- --host 0.0.0.0 --port 5901` serves the site on every interface, for a phone on `http://<this-mac>.local:5901`. The site proxies `/api` to the API, so the browser sees one origin.
- When another process already holds :3001, `npm run dev` moves the API to a free port and points the site's proxy at it (`DM_API_PORT` / `DM_API_PROXY` still override).

### Tournament checkout (Stripe test mode)

The QR checkout at `/find-your-player` reads its Stripe settings from the shell that runs `npm run dev`, never from a file — this repository is public:

- `STRIPE_SECRET_KEY` — a test-mode key (`sk_test_…`). Without it checkout refuses and everything else runs.
- `STRIPE_TEST_PRICES` — the four one-time USD test prices: `{"individual_basic":"price_…","individual_pro":"price_…","tournament_basic":"price_…","tournament_pro":"price_…"}`.
- `STRIPE_WEBHOOK_SECRET` — leave unset locally when the [Stripe CLI](https://docs.stripe.com/stripe-cli) is installed (`brew install stripe/stripe-cli/stripe`, or `STRIPE_CLI=/path/to/stripe`): `npm run dev` then runs `stripe listen` itself and hands its signing secret to the API, so test payments are marked paid. Set it only when you run `stripe listen --forward-to localhost:3001/api/stripe/webhook` yourself.

Stripe returns the parent to the page they started on (`DM_PUBLIC_BASE_URL` overrides it; production sets `https://diamondmetrics.ai`). Pay with the test card `4242 4242 4242 4242`, any future expiry and any CVC.

The key decides the mode. Production uses a live key and reads its four live Price IDs from `STRIPE_LIVE_PRICE_INDIVIDUAL_BASIC`, `STRIPE_LIVE_PRICE_INDIVIDUAL_PRO`, `STRIPE_LIVE_PRICE_TOURNAMENT_BASIC` and `STRIPE_LIVE_PRICE_TOURNAMENT_PRO`, set only in Render (the full list is docs/COMMAND_OPS.md §3.18, "Render environment"); no Price ID lives in code. Never set those locally: a test key beside a live Price setting, or a live key beside `STRIPE_TEST_PRICES`, refuses every checkout and says so in the API's log at startup. A checkout whose Price would not charge the card's amount, once, in US dollars is refused. **Command → Operations → Stripe prices → Check now** shows each Price as Stripe has it.

## Admin

Log in at `/login` with the seeded admin account:

- **Email:** `admin@diamondmetrics.ai`
- **Password:** `diamond-admin-2026` (override with `DM_ADMIN_PASSWORD` env var before first run)

The admin dashboard (`/admin`) lets you create player profiles, set bio/attribute ratings, log games, and enter per-game stats. Every stat captured is defined in [server/metricCatalog.js](server/metricCatalog.js) — add a metric there and it appears in the admin entry form and profile automatically.

## Public profiles

Each player gets a public, shareable profile at `/p/<slug>` (e.g. `/p/william-stoddard`). Profiles roll up per-game stat entries into headline numbers (max/avg per metric) and trend series. Hero metrics adapt to position (position player / pitcher / catcher). A player's public page can be disabled via the "Public profile enabled" toggle in the admin editor.

## Backend

- Express + better-sqlite3; DB file lives at `server/data/diamond-metrics.db` (gitignored)
- Auth: scrypt-hashed passwords, bearer session tokens (30-day expiry)
- Data model: `players` → `games` → `stat_entries` (one row per game+metric, so the stat set is flexible without schema changes)

## Sidelined UI

The original dummy coach dashboard (`/app`) and film-review admin are parked — see the commented block in [src/App.jsx](src/App.jsx) to restore them.
