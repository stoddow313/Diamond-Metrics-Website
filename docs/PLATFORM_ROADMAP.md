# Diamond Metrics — Platform Roadmap & Implementation Plan

**Drafted:** July 2026 · **Status:** Approved plan, pre-implementation
**Sources of truth:** "Diamond Metrics Team & Tournament Analytics Platform — Product and Development Requirements" (MVP Requirements, July 2026) and stakeholder requests (payments page, footage upload queue).

This document is the working plan for the next platform expansion. Each phase ships
as its own PR referencing this file. Decisions made along the way are recorded in
the Decision Log at the bottom so the plan stays truthful.

---

## 1. Where the codebase stands today

- **Frontend:** React 19 + Vite SPA, Tailwind v4, deployed on Vercel (auto-deploys
  `main` via GitHub). Public profiles (`/p/:slug`), prestige Pro Day card, player
  portal (`/me`), admin dashboard, marketing site.
- **API:** Express + better-sqlite3 on Render (`diamond-metrics-api`,
  srv-d98hqrq8qa3s73fhohag), SQLite + uploads on a persistent disk at `/var/data`.
  **No auto-deploy** — trigger via Render API after each merge.
- **Auth:** admin sessions + invite-claimed player accounts (`player_users`),
  separate session tables, bearer tokens. Enforcement is server-side.
- **Data model:** `players` → `games` (per-player performance records typed
  game/practice/showcase/bullpen/athletic_testing/pro_day; pro days link to shared
  `events` rows) → `stat_entries` (one row per metric per game; null-safe).
  `player_ratings` snapshots carry benchmark/calculation provenance.
- **Engines:** `server/metricCatalog.js` (single source of metric truth — drives
  admin entry, CSV import, profile rendering) and `server/ratingEngine.js`
  (pure, versioned, 26 tests; PG_2024_V1 benchmarks + provisional 13U).
- **Imports:** client-side CSV/XLSX per player, header-forgiving,
  update-not-duplicate on (date+opponent), row-level errors.
- **Patterns to reuse:** additive boot-time migrations in `db.js`; pure calculation
  modules with node:test suites; catalog-driven forms; invite/claim account flow;
  the profile visual system (cards/tabs/chart primitives in
  `src/components/profile/`).

## 2. Workstreams

Two quick independent tracks, then five platform phases.

| Stream | Size | Risk | Depends on |
|---|---|---|---|
| Track A — Payments page | S | Low | Stripe keys from owner |
| Track B — Footage upload queue | M | Low | Cloudflare R2 credentials |
| Phase 1 — Foundation (orgs/teams/rosters/roles) | M | **High (design)** | — |
| Phase 2 — Event structure (tournaments/games/imports) | L | Medium | Phase 1 |
| Phase 3 — Connected views (dashboards + navigation) | M | Low | Phase 2 |
| Phase 4 — Analytics (aggregates/leaderboards) | L | Medium | Phase 3 |
| Phase 5 — Publication (recaps/share/publish) | S–M | Low | Phase 3 |

Recommended first release cut (per requirements doc §13): **Phases 1–3 plus a
small set of validated Phase-4 aggregates.**

---

## 3. Track A — Payments page (Stripe Checkout)

**Goal:** sell program packages / Pro Day registration / film analysis from the
site with orders recorded in our own database.

**Approach**
- Stripe Checkout (Stripe-hosted card form → no PCI scope for us). No bare
  Payment Links: we want order records.
- `products` config (start hardcoded server-side; admin CRUD later).
- API: `POST /api/checkout/session` (creates Stripe session),
  `POST /api/webhooks/stripe` (signature-verified; records `orders` row:
  product, payer email, amount, stripe ids, status).
- DB: `orders` table (additive).
- UI: `/pricing` page (marketing style) + success/cancel pages + admin Orders view.
- Env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` on Render (owner supplies).

**Acceptance:** test-mode purchase completes → order row appears in admin →
webhook signature validated → refund/failure statuses recorded.

## 4. Track B — Footage upload queue (replaces email)

**Goal:** parents/coaches upload game footage from the site; admin works a queue
instead of an inbox.

**Approach**
- **Storage:** Cloudflare R2 (S3-compatible, ~$0.015/GB-mo, zero egress).
  Browser uploads go **direct to R2 via presigned URLs** — the API never carries
  video bandwidth. Multipart presign for files >100 MB.
- DB: `footage_uploads` (id, player_id nullable, event label, uploader
  name/email, object key, size, content_type, status: new → in_review →
  processed/rejected, notes, created_at).
- API: `POST /api/footage/presign` (validates type/size, returns presigned PUT),
  `POST /api/footage/complete`, admin list/status routes; portal route so claimed
  accounts upload against their own player automatically.
- UI: upload page (portal + tokenized public link per player), progress bar,
  admin **Footage Queue** with filters and status transitions.
- Env: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
- **Forward-compatible** with the requirements doc's Video Evidence entity and the
  profile Videos tab (same bucket, same records).

**Acceptance:** 2 GB file uploads from a phone without touching the API's memory;
queue statuses persist; unauthorized users cannot list or fetch uploads.

---

## 5. Team & Tournament platform

### 5.1 Non-negotiable data rules (from the requirements doc)

1. No permanent single `team_id` on players — dated roster membership only.
2. Event rosters + guest players never mutate the season roster.
3. Teams ↔ tournaments connect through entry records (division-scoped).
4. Each metric stored once; aggregated upward. No duplication per view.
5. Null stays null. Missing ≠ zero (already a codebase invariant).
6. Privacy enforced at API level, not just UI.

### 5.2 Key modeling decision — "Game" collision

The doc's **Game** = a shared record between two team entries. Our existing
`games` table = a **per-player performance context** (which is exactly the doc's
"Performance Context" entity). Decision: **keep `games` as-is** and add a separate
shared `tournament_games` table; per-player context rows gain an optional
`tournament_game_id`. Player Game Appearances become explicit rows. Zero
migration of existing stat data; satisfies single-source-of-truth.

### 5.3 Phase 1 — Foundation (M, high design risk)

**Schema (all additive):**
- `organizations` (name, type, location, logo)
- `teams` (org_id, name, age_group, level, slug, logo, active)
- `seasons` (label, start_date, end_date, status)
- `roster_memberships` (player_id, team_id, season_id, start/end dates, jersey,
  positions, role, status) — overlapping memberships allowed; archive, never delete.
- Accounts: generalize to support **coach** and **director** roles —
  `user_accounts` (or extend `player_users`) + `team_users` / `tournament_users`
  assignment tables. Existing admin + player auth untouched.

**API/UI:** admin CRUD for orgs/teams/seasons/rosters; resource-based permission
middleware (`canViewTeam`, `canManageTeam`, …) introduced **here** and used by
every subsequent endpoint. Coach invite-claim reuses the player invite pattern.

**Tests:** roster history, overlapping membership, archive behavior,
permission boundaries incl. direct-URL/API access.

### 5.4 Phase 2 — Event structure (L)

**Schema:** `tournaments` (name, slug, dates, location, organizer, branding,
visibility, publication status), `divisions`, `tournament_entries` (team ↔
tournament/division; seed, pool, placement, record), `event_rosters` (entry ↔
players; guest flag, event jersey), `tournament_games` (division, home/away
entry, datetime, field, scores, status), `player_game_appearances`.
`stat_entries` gains an `excluded` flag; `games` gains `tournament_game_id`.

**Admin workflows (doc §8):** guided setup (org → team → season → roster →
tournament → divisions → entries → event rosters → games), then metric
association.

**Server-side CSV imports** (new pattern, replacing client-only): templates for
rosters, entries, event rosters, games, contextualized metrics; validation with
row-level errors + downloadable error report; **dry-run preview** (creates /
updates / duplicates / rejects); idempotent re-import via external source IDs;
import audit records; duplicate-player flagging (name + DOB/grad) with
link-to-existing. Full merge workflow deferred (protected, audited — later).

### 5.5 Phase 3 — Connected views (M)

- `/teams/:slug` — Overview (identity, record, headline metrics with sample
  labels, latest event, completeness indicator), Roster (sortable; event view
  labels guests/DNPs), Events; Performance/Video/Reports tabs stubbed to states.
- `/tournaments/:slug` — Overview (branding, coverage statement, participating
  team cards), Divisions, Teams, Games.
- Player profile gains **Teams** and **Events** sections; performance rows show
  represented team/opponent/date; career/season/team/tournament filters.
- Filters live in the URL and persist across team↔player navigation.
- Every page ships loading / empty / partial / unpublished / access-denied states.
- Visual language: reuse profile card/tab/chart components; mobile-first.

### 5.6 Phase 4 — Analytics (L)

- **`server/aggregates.js`** — pure module in the rating-engine mold: every
  figure carries numerator, denominator, and sample; unit/context compatibility
  enforced; nulls excluded not zeroed; admin-excluded observations respected;
  filters use event dates, not record-creation dates. One module feeds UI,
  exports, and API so values can never disagree.
- Team performance tables (results, hitting, pitching, defense, athleticism per
  doc §4), player comparison (position + min-opportunity filters, CSV export),
  coverage indicators ("18 of 24 games analyzed").
- Leaderboards with **configurable minimum samples**; below-threshold entries
  labeled "Limited sample", never ranked.
- **No team/tournament rating by averaging player overalls** — requires explicit
  Diamond Metrics approval of a formula first (doc §7).
- Cache expensive tournament aggregates with invalidation on source change.

### 5.7 Phase 5 — Publication (S–M)

Director-editable recap (title, summary, champions, notable performances,
leaders, highlights), private preview → publish/unpublish, revocable share
links, print-ready CSS, audit log of publication/access/roster changes.

### 5.8 Testing & quality bar (every phase)

`npm test` (node:test) additions per phase: roster history, guest players,
event/game context, aggregation numerators/denominators, partial coverage,
minimum-sample qualification, permission boundaries (direct API access),
responsive/empty states verified in the browser before each PR. Lint + build
green before every push. E2E verification with seeded multi-team fixtures.

---

## 6. Risks

1. **Permissions matrix** (coach window-of-membership visibility, director
   scope, field-level limits) is the highest-consequence area — introduced once
   in Phase 1 middleware, used everywhere after. Never bolt on later.
2. **Aggregation credibility** — mitigated by the single pure module + tests.
3. **SQLite** is adequate for MVP scale (admin-write, public-read); revisit if
   tournament read traffic spikes; disk already persistent.
4. **Scope discipline** — doc explicitly defers live scoring, registration,
   payments-in-tournaments, AI insights, marketplaces. Track A payments is a
   separate site feature, not tournament registration.
5. **Render deploys are manual** — every merged phase needs an API deploy
   trigger + verification (existing runbook).

## 7. Decisions needed from the owner (recommendations attached)

| # | Question | Recommendation (default if unanswered) |
|---|---|---|
| 1 | Authoritative player identity | Existing `players` table; imports link-to-existing on name+DOB/grad |
| 2 | MVP analyzes full games, testing events, or both? | Model both; seed leaderboards from testing/Pro Day metrics first |
| 3 | Coach visibility beyond team-window performance | Public bio + rostered-window performance; never DOB/contact |
| 4 | Directors self-serve setup vs DM admins | DM admins set up; directors view + publish |
| 5 | Public pages / minors consent policy | Everything private by default; publishing is an explicit admin/director act |
| 6 | Minimum samples per leaderboard metric | Admin-configurable thresholds; "Limited sample" labels until values chosen |
| 7 | PDF export in MVP | Print-ready web views only |
| 8 | Team rating formula | Not displayed until a formula is approved |

## 8. Sequencing

```
Track B (footage queue)  ─┐
Track A (payments)        ├─ independent, ship first (pending credentials)
                          ┘
Phase 1 → Phase 2 → Phase 3 → (release cut) → Phase 4 → Phase 5
```

Each phase = one branch + one PR, opened with: files/migrations touched, tests
added, verification evidence. Owner merges; API deploy triggered + verified
after every merge that touches `server/`.

## 9. Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-07-28 | Keep `games` as per-player Performance Context; add shared `tournament_games` | Avoids migrating all stat data; matches doc's context entity |
| 2026-07-28 | R2 direct-upload architecture for footage | 1 GB Render disk + API bandwidth unfit for video |
| 2026-07-28 | Stripe Checkout over Payment Links | Order records must exist in our DB |
| 2026-07-30 | Phases 1+2 shipped admin-gated; coach/director *claim flows* deferred to Phase 3 | No non-admin surface exists yet, so no permission exposure; `team_users`/`tournament_users` assignment tables created now so the schema is stable |
| 2026-07-30 | Divisions hard-delete only when empty; entries/memberships archive | Divisions are containers; everything with history archives |
| 2026-07-31 | Deferral reversed: coach/director access + server-side imports shipped to match the doc's Phase 1–2 sequence | Owner prioritized doc parity; staff portal is the read surface the Phase-3 dashboards will replace |
| 2026-07-31 | Import duplicate rule: external id → name+DOB → name+grad year; bare name match always requires admin resolution | Doc §8: no silent duplicate creation on spelling alone |
| 2026-07-31 | Event-roster and metrics imports never create players | Player identity enters only via the season-roster import (with dedupe) or admin UI |
| 2026-08-03 | Phase 3 shipped: /teams/{slug} + /tournaments/{slug} dashboards, profile Teams/Events sections | Team dashboards private (admin/assigned staff/own players); tournaments public only when published+public; §5 coverage statement on every tournament view |
| 2026-08-03 | Phase-3 team overview shows record/coverage counts only — §4 headline metrics wait for the Phase-4 aggregates module | Release-cut discipline: no ad-hoc aggregate math outside the shared module |
