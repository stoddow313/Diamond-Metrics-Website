# Diamond Metrics

Marketing site + player-profile platform. React (Vite) frontend with a local Node/Express + SQLite backend.

## Running locally

```bash
npm install
npm run dev        # starts the API (:3001) and the web app (:5173) together
```

- `npm run server` — API only
- `npm run dev:web` — Vite only

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
