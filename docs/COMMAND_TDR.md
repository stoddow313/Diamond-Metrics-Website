# Diamond Metrics Command — Technical Decision Record

Discovery response to the V1 handoff (Living PRD v0.9 · Build Roadmap 2026-08-17 ·
Metric Recipe Appendix v0.1). Scope of this document: repo discovery findings,
proposed architecture decisions, Phase 1 vertical slice, and open questions.
No code has been written against this plan yet.

## 0. Discovery findings (current system)

| Area | Current state |
|---|---|
| Stack | React 19 + Vite + Tailwind v4 SPA (Vercel) · Express + better-sqlite3 (Render starter, single instance) |
| Database | SQLite on 1 GB persistent disk at /var/data; additive boot-time migrations (`addColumnIfMissing`) — no migration framework, no scheduled backups |
| Auth | Three session tables: `admins` (internal, no role column), `staff_users` (customer coaches/directors), `player_users` (families). Single login endpoint tries each. `requireAdmin` / `requireStaff` middleware |
| Domain model | organizations → teams → seasons → dated `roster_memberships` → players; tournaments → divisions → `tournament_entries` → `event_rosters` (guests) → `tournament_games`; per-player `games` (performance context, links `tournament_game_id`/`event_id`) → `stat_entries` (game_id, metric_key, value, excluded) |
| Metric path | `metricCatalog.js` (code-defined registry incl. `zeroMeansUnmeasured`) → `stat_entries` → read-time aggregation (`aggregates.js`, DM_AGG_V1 stamps) + Pro Day rating engine (versioned benchmarks, stored `player_ratings`) → profiles/dashboards |
| Imports | Client-parsed CSV → JSON rows → server `importEngine.js` (dry-run plan, duplicate resolution, idempotent apply, `import_audits`) |
| Publish gates | `players.is_public`, tournament `published+visibility`, team dashboards private by default; approved values ARE `stat_entries` rows |
| Media | Player photos only, stored on the 1 GB disk. No video anywhere. No background jobs, no queue, no transcoding, no error monitoring |
| Environments | Prod only (Vercel + Render). Local dev. No staging |

Verdict: the shared data foundation the roadmap requires **already exists** —
organizations/teams/dated rosters/events/games/metrics/publication state are one
connected model with audit habits (import_audits, review-style history on
ratings, excluded flags). Command extends it; nothing needs a parallel store.

## 1. Schema and API changes

**Database stays SQLite for Phase 1** (matches conventions; volumes are small —
a fully tagged game is ~1–2k rows). WAL mode + busy timeout; the media worker
is a second writer, which WAL handles at this scale. Postgres migration trigger
is defined, not taken: >1 web instance, >5 concurrent analysts, or sustained
write contention. Nightly SQLite snapshot to R2 becomes mandatory (there is no
backup today).

**New tables (all additive, namespaced `cmd_` except shared upgrades):**

- `sports`, `rulesets` — baseball seeded; event rules (innings/time/run rule) hang off ruleset. Referenced by tournaments/games instead of hard-coding.
- `metric_registry` — DB registry replacing code-only catalog as source of truth for Command: stable metric key (superset of existing `metricCatalog` keys), recipe_version, unit, precision, availability tier (A/B/C/D/X), capture requirements, dependencies, active state. Existing `metricCatalog.js` keys become seed rows so published keys stay identical.
- `analysis_orders` + `metric_requirements` — package/custom order → activated metric codes, priority, capture requirement, enabled flag.
- `analysis_jobs` — org/team/event/game refs, order, assigned analyst, independent `metric_release_status` and `game_record_status`, blocker reason, timestamps.
- `video_feeds` — job ref, label/angle, capture profile, storage key (R2), original metadata (duration, codec, nominal+effective fps, dimensions, rotation, VFR flag), ingestion status (uploaded/queued/processing/ready/failed/retrying), manual offset, quality notes.
- `media_renditions` — feed ref, kind (proxy/thumbnail/clip), storage key, fps, dimensions, status. Evidence clips are renditions with event refs + pre/post-roll params.
- `media_jobs` — the background-work queue table (probe/proxy/clip), idempotent by (feed, kind, params-hash).
- `radar_readings` — immutable source rows (file hash + row index for idempotency), player, velocity, pitch_or_exit, context, source timestamp, match status (matched/unmatched/invalid), confirmed event ref, note.
- `game_events` — the ordered event log: job/game ref, sequence, parent ref (half-inning → PA → pitch/play chain), event type (enum), player refs, payload (typed JSON per template), selected feed, timecode/clip bounds, creator, correction chain (superseded_by), status. Running attempts are `game_events` rows of type `running_attempt` (attempt_type home_to_first/steal) so Rookie and Full Game share one spine.
- `measurements` — event ref, type, start/end frame, fps used, elapsed, formula version, validity, feed ref, clip ref.
- `metric_results` — requirement ref, player, game/event, value/unit, method (radar_verified/frame_timed/video_estimated/manual), status (draft/ready_for_review/approved/published/unavailable), unavailable reason (controlled enum), evidence refs, calculation version.
- `review_actions` — target (any cmd record), reviewer, decision, note, prev/current state snapshot.
- `capture_profiles`, `cmd_notifications`, `consent_records` (org/order-level media + sharing consent), `game_record_sources` (GameChanger import raw + validation state; Phase 2 consumer).
- `cmd_telemetry_events` — upload-to-ready, stage timing, unavailable/match/return rates.

**Shared-table upgrades (additive columns):**
- `admins.role` — `admin | analyst | reviewer` (default admin). Internal people stay in the internal table; analysts get workspace access without publish. Roadmap allows one person to review+publish in V1 — role checks permit that for admin.
- `stat_entries.method`, `stat_entries.metric_result_id` — the **metric-release adapter** writes/updates stat_entries under the existing `(game_id, metric_key)` key. Profiles, aggregates, rating engine, dashboards keep working unchanged on day one; method labels become displayable later without a second metric database. Corrections update the same row; history lives in `metric_results` + `review_actions`.
- `metricCatalog.js` additions: `steal_time` (new sellable key), method-aware display handled at read time.

**API:** new `/api/command/*` namespace following current Express/transaction
patterns; internal-role middleware; idempotent ingest endpoints (content-hash
dedupe for feeds/radar/scorecards); every state change writes `review_actions`
or telemetry. Publication endpoints: `POST /api/command/jobs/:id/release-metrics`
(per-metric release) and later `release-game-record` (box score) — the two-release
model from the roadmap, mapped onto the existing publish gates.

## 2. Video: upload, storage, proxy, retention, cost

- **Storage: Cloudflare R2.** Zero egress fees (decisive for video review traffic), S3-compatible multipart API, per-object storage classes. The 1 GB Render disk never touches media. (R2 was already the chosen provider for the deferred footage-queue track.)
- **Upload: browser → R2 direct, presigned multipart, resumable.** Chunked (~50 MB parts), per-part retry, progress UI, pause/resume; API only issues presigns and registers metadata. Duplicate detection by size+hash. Same path serves internal analysts and authorized customer uploads (one intake queue).
- **Processing: a dedicated Render background worker** (new service, same repo) polling `media_jobs`: ffprobe technical inspection (duration/codec/nominal+effective FPS/rotation/**VFR detection**), then ffmpeg renditions — 720p H.264 CFR faststart proxy + thumbnail strip — streamed to/from R2. Evidence clips cut asynchronously by the same worker. Failure states surface on the feed with safe retry (idempotent by job hash).
- **Frame accuracy:** proxies are constant-frame-rate; measurements always record the **effective FPS of the measured rendition** plus normalization provenance; originals retained for audit. VFR originals are flagged and frame-timed metrics are blocked until the CFR proxy exists (satisfies the roadmap's VFR rule; the proxy is the normalization). Browser stepping via `requestVideoFrameCallback`, keyboard frame keys, and R2 Range requests. This is the highest-risk UX piece → prototyped first inside Milestone 2 with an explicit accept/reject gate.
- **Managed alternative rejected for now:** Cloudflare Stream/Mux ($5+/1k min stored, delivery fees, limited frame-step control). R2+worker ≈ raw $0.015/GB-mo, full FPS control. Provider adapter seam kept so this stays reversible.
- **Cost model (pilot: 100 games ≈ 2 h 1080p60 each):** originals ~8–15 GB + proxy ~1.5 GB per game → ~1.2–1.7 TB ≈ **$18–26/mo storage, $0 egress**; worker instance $7–25/mo; total well under $60/mo at pilot volume. 4K/120 Pro Day feeds roughly 3–4× per-game storage.
- **Retention (proposed default, pending product sign-off):** originals → R2 Infrequent Access 30 days after publication, deleted at 24 months unless the order specifies archival; proxies + published evidence clips retained while the job/profile references them; consent revocation or deletion request purges media + presigned access immediately (auditable deletion records). All media access via short-TTL signed URLs, role-checked.

## 3. Integration plan (profiles, dashboards, releases)

- **Metric release (Phase 1):** approved `metric_results` → adapter → existing per-player `games` + `stat_entries` rows (method-tagged). Profiles, Pro Day cards, team/tournament dashboards, and the rating engine consume them with zero changes. Verified-method badges on profile/dashboard displays ride a later UI pass reading `stat_entries.method`.
- **Two-release model:** metric release updates player metrics immediately after QA; box-score/game/team/tournament statistics wait for `release-game-record` (Phase 2), which writes `bs_*` stat_entries + `tournament_games` scores through the validated game record. Customer UI states "full review pending" between the two (dashboards already carry coverage language).
- **Evidence clips on customer surfaces:** Phase 1 publishes **numbers only**; clips remain internal/role-gated pending the consent/display product decision (question below).
- **Notifications (Phase 1 scope, owner-directed):** auditable notification events written on workflow transitions — `footage_received`, `review_started`, `metrics_ready`, `full_review_pending`, `full_review_complete`, `paid_metric_unavailable` — stored per job with audience + payload, surfaced in Command, and dispatched through a transactional-email adapter. **Provider recommendation: Resend** (simple API, per-message pricing, domain verification only); the adapter ships now with a logging backend and activates by setting `RESEND_API_KEY` + a from-address — no workflow redesign. Recipients: order contact email + authorized team staff.
- **No duplicate entities:** jobs bind to existing organizations/teams/rosters/tournament_games; bulk tournament triage reuses the Phase-3 entities and import-engine duplicate rules.

## 4. Phase 1 vertical slice — Rookie workflow

Six PR-sized milestones, each independently verifiable in the test env; the
shared event/metric model is laid in M1 so nothing is Rookie-only:

| M | Contents | Gate |
|---|---|---|
| 1 | cmd schema + roles + metric registry (seeded incl. steal_time) + orders/requirements + job CRUD + production queue UI | Job created against existing team/game; requirements activate from order |
| 2 | R2 direct multipart upload + worker (probe/proxy/thumbnails/clips) + feed states + **frame-step prototype acceptance** | 2 h file uploads resumably; proxy streams; frame stepping verified accurate vs known-FPS test clip; VFR flagged |
| 3 | Radar CSV import (immutable rows, idempotent) **and manual radar entry** (player, velocity, pitch/exit classification, pitch type, context, note, unmatched/invalid status), radar queue UI, match/confirm/invalidate, radar-verified velocity results | Sample Pocket Radar CSV → confirmed matches → draft velocity results with evidence; manual readings follow the same immutability + match rules |
| 4 | Analysis workspace (player, feed selector, timeline, keyboard) + running queues + measurement drawer (H2F, steal) with save-and-advance + unavailable pathway | Clean candidate measured in ≤15 s; frames/FPS/version stored as evidence |
| 5 | Capture-readiness gate, automated QA flags, review/publish screen, **metric-release adapter**, correction/supersede flow, audit surfaces | Rookie acceptance test: valid-capture game start→publish with no spreadsheet/CSV handoff; results live on the real profile |
| 6 | Pilot hardening: telemetry (stage timing, unavailable/match/return rates), SQLite nightly R2 backup, Sentry + structured logs, staging env, bulk job creation for tournaments | Pilot games processed; timing dashboard shows the measured median |

**Estimate.** At our demonstrated cadence (working sessions + your same-day PR
merges): M1–M2 ≈ one week of sessions together (M2 carries the prototype risk),
M3–M5 ≈ one more, M6 ≈ 2–3 sessions. Realistic wall-clock: **~2–3 weeks to a
pilot-ready Rookie workflow**, assuming sample footage + a real Pocket Radar CSV
arrive before M2/M3 acceptance. The 30-minute median is measured after pilot
iteration, per the roadmap — not promised up front. Phases 2–5 of the delivery
sequence are estimated per-phase after Phase 1 pilots, as instructed.

## 5. Risks, assumptions, open items

**Technical risks (owned by engineering):**
- Browser frame-accuracy is the make-or-break UX; mitigated by CFR proxies + rVFC + explicit M2 gate before workspace build.
- VFR phone footage is common; all frame math uses effective FPS of the measured rendition, never nominal.
- SQLite dual-writer (web+worker): WAL + busy timeout fine at pilot scale; Postgres trigger documented.
- No backups exist today — nightly snapshot ships in Phase 1 regardless.
- Long field uploads on bad networks — resumable multipart is non-negotiable; tested with throttled connections.
- Minors' media: default-private, role-gated, short-TTL signed URLs, auditable deletion; no public clip exposure in Phase 1.
- Render starter plan may need a bump for the worker; staging env added (small fixed cost).

**Assumptions:** ≤5 concurrent analysts in Phase 1; footage arrives as files (no livestream); GameChanger source is Phase 2; single reviewer role acceptable per roadmap; existing dark admin UI conventions are the Command UI baseline (new `/command` route group, internal-role gated).

**Waiting on samples:** real Pocket Radar CSV export(s), 2–3 representative game files (incl. one 30 fps and one VFR phone capture), a GameChanger scorecard export, roster file. M3/M2 acceptance tests are written against these.

## 5a. Metric-release mapping (atomic Command records → existing profile records)

Implemented in `server/metricRelease.js` (pure, versioned `DM_RELEASE_V1`, tested)
and consumed by the M5 release adapter. Principles: `metric_results` keeps **every**
individual reading/attempt with evidence and validity; `stat_entries` receives only
**approved display rollups**; unavailable results stay unavailable with a reason and
never become zeroes or enter denominators.

| Command metric | Atomic records kept | Published rollups → existing keys |
|---|---|---|
| Pitch velocity — radar | every valid confirmed reading (+ invalid/unmatched rows retained, excluded) | `max_velo` = max(valid), `avg_velo` = mean(valid); valid-reading count stored as sample metadata |
| Exit velocity — radar (later phase) | every valid matched BIP reading | `max_exit_velo` = max, `avg_exit_velo` = mean, valid count |
| Home-to-first | every valid attempt (frames, FPS, elapsed) + unavailable attempts with reason | best (min) time → `home_to_first`; average + attempt count as metadata |
| Steal time | every valid attempt incl. failed steals (timing is outcome-independent) + unavailable attempts | best (min) time → `steal_time`; average + attempt count as metadata |

Rollup rows land in the existing per-player `games`/`stat_entries` path (method-tagged,
linked to their `metric_result_id`), so profiles/dashboards/rating engine read them
unchanged. A job with only unavailable results publishes **no** stat_entries row for
that metric — absence, never zero.

## 7. Phase 2 — Core scorekeeping (decision record, 2026-09-08)

**Increment (roadmap §8):** game → half inning → plate appearance → pitch/play
event; box-score foundation and standard-stat rollups. **Gate:** ordinary game
corrections are auditable; scorebook-derived stats are clearly distinguished
from measured/estimated metrics. Acceptance tests §7.6 (full-game correction)
and §7.7b (substitutions, inherited runners, re-entry) become real.

### 7.1 Decisions

| Area | Decision | Why |
|---|---|---|
| Event storage | Reuse `cmd_events` (typed rows, parent links, `superseded_by`). New types: `lineup`, `half_inning`, `plate_appearance`, `pitch`, `runner`, `substitution`, `game_final`. No new event table. | The M4 spine was built for this ("Phase 2 adds pitch/PA/play types to the SAME table"). One ordered stream per job means one correction model and one audit trail. |
| Derived state and stats | **Replay, never store.** `replayJob()` folds the active events into game state (inning, outs, count, bases with responsible pitcher, score, lineups, pitcher of record) and per-player box-score tallies (`bs_*`), deterministically, versioned `CMD_SCOREBOOK_V1`. | A correction upstream recalculates everything downstream by construction — no stale tallies, no duplicate tags. It also makes the engine a pure function that is exhaustively testable. |
| Corrections | Supersede, never edit in place: a corrected event gets a new row at the same sequence and parent; the old row is `superseded`; children re-parent; the audit row carries previous and new payload. Voiding is a supersede with no replacement. | Roadmap §3.2 "latest approved correction supersedes the prior published value while preserving version history and a reason". |
| Disputed events | `status = 'needs_review'` with a note. Excluded from tallies and from release; surfaced as a QA flag. Clear results still publish. | Roadmap §4.2 "disputed events remain needs_review and excluded from dependent calculations". |
| Runner advancement | Explicit `runner` events per runner (advance / stolen base / caught stealing / pickoff / wild pitch / passed ball / error / out / scored). Home runs auto-score everyone. The UI proposes the conventional advances for a result; the scorer confirms. | Baseball advancement is contextual; automation would guess. Explicit events are what a reviewer can audit. |
| Earned runs and inherited runners | Every runner carries the pitcher responsible for them (the pitcher of record when they reached). A run is charged to that pitcher regardless of who is pitching when it scores. Unearned when the runner reached or scored on an error/passed ball or the scorer flags it. | §7.7b "pitcher substitution/inherited runners retain correct attribution". |
| Substitutions | `substitution` events: pinch hitter, pinch runner, courtesy runner (P/C, per ruleset), defensive change, pitching change, re-entry (`starters_once` per ruleset). Lineups are replayed, not stored. | Youth rules (re-entry, courtesy runners, EH/DH) are ruleset config, not code. |
| Opponent side | Opponent batters and runners are label-only (`#12`) — no player rows, nothing publishes for them. Our pitcher's line needs their plate appearances, so both halves are scored. | Roadmap: never create duplicate or speculative player records. |
| Publication | The live scorebook is a **`live_internal` game-record source**. Validation replays the events into the same per-player stat rows a GameChanger import produces; the existing game-record release publishes `bs_*` with `method = 'scorebook_derived'`. One release path for imports and live scoring. | Roadmap §6 "publish box-score statistics only through a validated game-record release"; gate "scorebook-derived stats clearly distinguished". |
| Corrections after release | A correction to a released record re-runs the game-record release immediately (audited) when the record is still valid; the profile never shows a superseded value. | Roadmap §3.2 forbids stale profile values. Metric corrections already behave this way. |
| Game over | The engine suggests game over from the ruleset (regulation innings, run rule, walk-off); the scorer records `game_final` with a reason. The record cannot be validated until final. | Time limits and umpire decisions are not knowable from events. |

### 7.2 Out of scope for the first slice

Pitch location and heatmaps, 150+ standard-stat parity, splits, box-score
outputs for opponents, automatic game-over, and any suggestion that changes a
result without the scorer.

## 8. Customer footage submission (decision record, 2026-10-01)

**Source:** *Customer Footage Submission Developer Requirements* (cited §n in
the code). **Built:** the §11 P0 scope — Submit Footage CTA, sign in / create
account, guided intake, consent records, resumable upload, processing states,
customer confirmation and status, Will's queue, identity candidates, duplicate
warnings, create/link Command job, audit log. The §12 acceptance scenarios are
`server/footageIntakeAcceptance.test.js` (§12.1–§12.7). It is a CRM-lite
layer on the existing records, not a second database: every submission ends in
the same players, teams, orders, jobs, feeds and audit trail Command uses.

### 8.1 Decisions

| Area | Decision | Why |
|---|---|---|
| Switch | `DM_INTAKE_ENABLED` (`1` on, `0` off; default on outside production, **off in production until set**). Customer routes and self-serve sign-up mount only when on; Command's intake, Team and `/api/intake/config` always mount, and every CTA reads the config. | Ships dark: the legal wording and email provider must be in place before customers see it. |
| One person, one identity | `customer_accounts` keyed by normalized email. A coach-portal or player-portal login resolves to the same contact by email (provisioned, no second password). Internal `admins` never submit. | §1 "one customer record"; §8 never a second contact without review. |
| Will's access | New internal role **`fulfillment`**: reads Command, works the intake queue, creates/links jobs; cannot approve or release, execute deletions or clear escalations. Admins create internal logins on **Command → Team**; the default owner of new submissions is an admin setting. | §2 least privilege; the owner gave no email for Will, so his login is created in-product. |
| Drafts | A server-side draft (form JSON + step) exists from the first screen after sign-in, autosaves, and survives sign-out, refresh and an interrupted upload. `/submit` keeps the source page, package, player and order from the link. | §3 steps 1–3, §4 "save and resume". |
| Packages | Rookie; Pro (accepted and fulfilled as Rookie, with a customer note and a fulfillment note, until its modules ship); Hall of Fame (an inquiry — no upload, sales follow-up); Custom (free text that Will scopes). | Owner decision 2026-10-01; §7 "do not promise advanced results"; §5 "do not invent a custom workflow". |
| Payment | Submit first; Will confirms payment on the record. Optional receipt/order number; a `payment unconfirmed` flag on the queue. No checkout here. | Owner decision 2026-10-01; §11 defers checkout. |
| Rights and consent | `intake_rights` is immutable (triggers block UPDATE and DELETE). Each acceptance stores the policy version, a SHA-256 of the exact wording served, `pending_legal`, the affirmed attestation, permitted uses, contact permission, retention days and deadline, restrictions, the athletes covered, the filming-guide version, actor, IP and user agent. Changing role requires accepting again; revocation appends a `revoke` row. | §4 step 4, §5, §10 "versioned data, not a static checkbox". |
| Upload | The Command direct-to-R2 multipart path through one shared client engine (50 MB parts, retries, stall timeout, ETag check, labelled stages). Resume by choosing the same file (fingerprint = SHA-256 of the first MB + size); completed parts are never re-sent. A repeat of the same file is refused in the submission and pointed out across the customer's submissions; another customer's copy is visible to staff only. | §6 reliability; §8 file-hash duplicates. |
| Technical check | Probe only on landing (`server/intakeMedia.js`, three attempts; broken files fail at once). The customer sees plain findings (resolution, frame rate, orientation, short clip, missing side angle for Pro); diagnostics stay internal. A file found unreadable after submitting moves the request to *Needs customer action* so the customer can replace it. | §6 technical validation, §7 capture QA. |
| Hand-off | Will creates or links the job. Each video becomes a `cmd_video_feeds` row on the **same stored object** (no copy) carrying submission, file, rights record, deletion date and uploader, then runs the normal probe → proxy pipeline. An identical live feed is reused; a deleted or unfinished one never is. Files added after linking attach on request. Named athletes join the job roster (`cmd_job_participants`); guests become job placeholders; a coach gains a team link, never athlete ownership; a parent's, guardian's or adult athlete's confirmed link becomes "my athletes". | §9 one source of truth; §2 coach limits. |
| Identity | Candidates scored on name, short forms, one-letter typos, birth or grad year, and roster for the game date, with confidence and reasons. Nothing links automatically; a new player when a reasonable match exists needs a written reason; new players are private. | §8 identity resolution, "no automatic merge for ambiguous minors". |
| Duplicates | Contact (verified email, normalized phone, name), game (same team ± 1 day, opponent/event; the opponent's job for the same game is flagged, not linkable), other submissions of the same game, and file hash. | §8 duplicate prevention rules. |
| Status | The stored intake stage plus a fulfillment stage derived from the job's two release tracks, so the queue can never disagree with Command. The customer sees received → checking → analysis → metrics ready, with the full game record as its own line. | §3 step 7, §9 metrics before box score, §12.6. |
| Customer view | An allowlist: no internal notes, match confidence, diagnostics, staff names, payment state or anyone else's data. Customer-visible events are separate from internal notes on one immutable timeline. | §10. |
| Email | The Resend adapter. Without a provider, account links are logged in non-production only, and staff may mark an email verified with a recorded note (audited). | Owner decision 2026-10-01. |
| Audit | `intake_events` is append-only (DELETE blocked; the only permitted UPDATE redacts what a customer wrote when their account is closed). | §10 immutable event log. |
| Deletion | Request (customer or staff) → inventory of the account, submissions, files, Command feeds, derived renditions, jobs, evidence, public profiles and retention exceptions → an admin executes the chosen actions → each step's outcome is recorded. | §10 controlled deletion workflow, §12.7. |
| Retention | 180 days by default (`DM_INTAKE_RETENTION_DAYS`), an explicit deletion date on every file and feed. Nothing deletes automatically in this release: files past their date are listed for a request. The R2 lifecycle on `originals/` (730 days) is the backstop. | §6 retention; deleting customer media is a decision a person makes. |
| Test isolation | A test account's submissions are synthetic end to end; a test submission never joins a real job (or the reverse); notifications are suppressed. | §9 synthetic data. |
| Abuse limits | In-memory fixed windows on sign-in, sign-up, verification, password reset, drafts and writes (`DM_RATE_LIMITS=0` disables, for tests). | Self-serve sign-up is public. |

### 8.2 Deferred (§11 P1/P2)

Email provider activation, request-for-information templates, households and
team management, staff dashboards and reporting, configurable turnaround copy,
automatic retention deletion, self-serve checkout, external CRM sync, and
sharing evidence clips with customers (clips stay internal per 2026-08-20).

## 9. Tournament checkout — QR "Find your player" (decision record, 2026-10-06)

**Source:** the *Diamond Metrics Tournament Checkout Developer Handoff*
(2026-10-06, cited "handoff §n"), Will's pages from
`feature/find-your-player-landing`, and the studio PRD (R1–R10). **Built:**
Will's three pages merged onto `main`; `POST /api/create-checkout-session`,
`POST /api/stripe/webhook`, `POST /api/post-purchase-intake`; tournament
orders as their own records; a read-only **Tournament orders** list in
Command. The handoff's §7 test list is
`server/tournamentCheckoutAcceptance.test.js`; go-live steps are
COMMAND_OPS §3.18.

### 9.1 Decisions

| Area | Decision | Why |
|---|---|---|
| Orders | `tournament_orders` rows of their own, not intake submissions or customer accounts. A pending order (guardian, player, email, phone, tournament, package, Price, time) is saved before Stripe hears of it. Its random `TO-XXXX-XXXX` id is Stripe's `client_reference_id` and the only metadata besides the package key; names, phone and tournament stay in our database. | Handoff §4–§5; a QR buyer has no account or consent record (A17). |
| Price | The browser sends a package key. A live key (`sk_live_`/`rk_live_`) charges only handoff §1's live Price IDs (in code; they are not secret); a test key charges only `STRIPE_TEST_PRICES`; anything else refuses before saving. Amounts and Price IDs from the browser are ignored. | Handoff §1, §7. |
| Paid | Only `checkout.session.completed` with `payment_status: paid`, its `Stripe-Signature` verified over the raw body (the route sits ahead of `express.json`), for the order's own session. One transaction: the event id is recorded first (`stripe_events`), then pending → paid once, with the session, PaymentIntent, amount, currency, status, event id and arrival time, and one "paid" history row. Foreign sessions and other events are acknowledged and ignored; a database failure answers 500 so Stripe retries. The success redirect, the details step and Command never mark paid. | Handoff §2, §5. |
| Details step | Saved for a webhook-paid order, or when Stripe itself reports that session paid for that order (the parent was faster than the webhook; the order stays unpaid until the webhook lands). An unknown or unpaid link gets one refusal, so the reply never reveals whether an order exists. A later send from the same link replaces the details. | Handoff §3 "verified payment"; A19. |
| Command | **Tournament orders**, right after Intake, for every internal role: paid orders only, newest paid first, read-only. Unpaid and abandoned checkouts are never listed or counted. | A16; actions come later (9.2). |
| Return addresses | `DM_PUBLIC_BASE_URL` (production: `https://diamondmetrics.ai`, the handoff's addresses). Outside production when it is unset, the calling page's `Origin`, else `http://localhost:5173`. Production never reads `Origin`. | A27. Spike S1: Stripe test mode accepts `.local`, LAN and localhost addresses, so a phone on the studio's link comes back to it. |
| Live webhook | Registered at the Render address, not through Vercel's `/api` rewrite. | A11: no proof the rewrite keeps the body and signature intact. |
| Cancel | The page keeps the five details and the package in the tab's `sessionStorage` just before Stripe, restores them onto the package step at `?checkout=cancelled`, and clears them once the details step succeeds. A fresh tab opens empty without the "still here" notice. | A20. |
| Limits | 60 checkouts per address per 10 minutes and 10 per email per hour; 60 details calls per address per 10 minutes; the webhook is never limited. | A26: many parents share a carrier's address at one field. |
| Logs | Ids only (order, session, event). Stripe's error messages are not logged, because they can echo the email. | Minors' data; handoff §4. |
| Payment methods | v1 assumes methods that settle at checkout. A completed session that is not yet paid stays pending, with a warning in the log. | A30; delayed methods are 9.2. |
| Local runs | `npm run dev` forwards Stripe test webhooks through the Stripe CLI and moves the API off :3001 when another process holds it. | Spike S1; one command runs the whole flow. |

### 9.2 Deferred

Fulfillment states and notes on tournament orders; linking an order to a
player or job; a Diamond Metrics confirmation email; refund and dispute
status from Stripe events; a staff-managed tournament list; delayed payment
methods (`checkout.session.async_payment_*`); reconciliation of paid
sessions whose webhook never arrived; marking test orders; checking the order
when the success page opens; deletion and retention for tournament orders;
season packages through Checkout; one customer record across orders and
intake; a consent checkbox; an order detail page with its history.

## 6. Decision log

| Date | Decision | Status |
|---|---|---|
| 2026-10-06 | **Tournament checkout (QR "Find your player") built** — Will's pages merged; checkout at the server's price; Stripe's signed webhook is the only paid signal; player details only after a verified payment; read-only Tournament orders in Command (§9) | Built — go live per COMMAND_OPS §3.18 before 2026-10-09 |
| 2026-10-06 | Tournament orders are their own records, matched by order id and session, never by name or email; the Command list is read-only in v1 | Decided (A16, A17) |
| 2026-10-06 | Prices follow the key: a live key charges only the handoff's live prices, a test key only `STRIPE_TEST_PRICES` | Decided |
| 2026-10-06 | The live webhook endpoint is the Render address, not the Vercel `/api` rewrite | Decided (A11) |
| 2026-10-01 | **Customer footage submission (P0) built behind `DM_INTAKE_ENABLED`** — accounts, guided intake, consent records, resumable upload, technical check, status, Will's queue, identity and duplicate signals, create/link job, deletion workflow (§8) | Shipped dark — enable after the legal text and email provider |
| 2026-10-01 | Packages: Rookie, Pro (fulfilled as Rookie with notes until its modules ship), Hall of Fame (inquiry, no upload), Custom (scoped by staff) | Confirmed by owner |
| 2026-10-01 | Payment: submit first; fulfillment confirms payment; optional order reference; unconfirmed payment is a queue flag | Confirmed by owner |
| 2026-10-01 | Email: Resend adapter; until it is live, staff may verify an email manually with a recorded note | Confirmed by owner |
| 2026-10-01 | New internal role `fulfillment` for Will; admins create internal logins on Command → Team; default owner of new submissions is an admin setting | Confirmed by owner |
| 2026-10-01 | Uploaded files stay on the submission until hand-off, then become Command feeds on the same stored object; deleted or unfinished feeds are never reused | Decided |
| 2026-10-01 | Footage terms ship as versioned draft wording (`2026-10-draft-1`, `pending_legal`); every acceptance is identifiable once legal approves the final text | **Pending legal** |
| 2026-08-20 | Analysts/reviewers are roles on the internal `admins` table; one person may review+publish in V1 | Confirmed by owner |
| 2026-08-20 | `steal_time` added as a new public metric key (profiles Running tab); radar pitch velocity publishes to existing `max_velo`/`avg_velo` | Confirmed by owner |
| 2026-08-20 | Phase 1 publishes numbers only; evidence clips stay internal/role-gated | Confirmed by owner |
| 2026-08-20 | Retention default: originals → infrequent access at 30 days, delete at 24 months; proxies/clips retained while referenced | Confirmed by owner |
| 2026-08-20 | Command lives at `/command` (internal-only route group, shared dark system) | Confirmed by owner |
| 2026-08-20 | Order-level consent checkbox at job setup, auditable | Working approach — **pending review with Cam**; legal language to follow |
| 2026-08-20 | Sample plan: Dropbox test/Pro Day footage for pipeline; synthetic burned-in frame-counter clip for the M2 frame-accuracy gate; Pocket Radar CSV expected from next tournament (gates M3 acceptance only) | Agreed |
| 2026-08-20 | Owner approval: proceed M1–M2 incl. frame-accuracy gate; retention approach approved as specified | Approved |
| 2026-08-20 | M3 gains manual Pocket Radar entry (player, velocity, pitch/exit, pitch type, context, note, unmatched/invalid) alongside CSV | Directed |
| 2026-08-20 | Customer notification system moves INTO Phase 1: six auditable event types + Resend-ready email adapter (in-app events now, email activates by env config) | Directed |
| 2026-08-20 | Explicit release mapping documented (§5a) and implemented as versioned pure module before M5; unavailable never becomes zero | Directed |
| 2026-08-20 | GameChanger scorecard stays a supported game-record source at job setup (non-blocking for Rookie); raw upload preserved pending validation | Directed |
| 2026-08-20 | 2–3-week estimate scope confirmed: controlled pilot-ready Rookie workflow only; scorekeeping/advanced modules/tournament scale estimated after pilot | Aligned |
| 2026-08-21 | M4 built: `cmd_events` spine + `cmd_measurements`; running queue with frame-marked measurement drawer; 90-ft speed derived per appendix; unavailable is a first-class reasoned outcome (null value) | Shipped (PR #33) |
| 2026-08-21 | M5 built: capture-readiness QA flags (consent + unreviewed results block approval); per-result reviewer decisions; release adapter publishes DM_RELEASE_V1 rollups into `games`/`stat_entries` with `method` + `metric_result_id` provenance (`games.command_job_id` keys one game per player per job); corrections supersede with full history (`superseded_by` chains, `withdrawn` for invalidated evidence); `paid_metric_unavailable` notification with reasons, deduped across re-releases | Shipped |
| 2026-08-21 | Phase 1 acceptance test passing: Rookie job → radar + frame-timed evidence → review → release → public profile, no CSV handoff; unavailable never publishes and never zeros | Verified |
| 2026-08-21 | M6 built: structured JSON logs + dependency-free Sentry forwarding (`SENTRY_DSN`), pipeline telemetry (stage p50/p90, turnaround, radar match / unavailable / review-return rates, media durations), nightly SQLite online-backup snapshots to the storage adapter with retention, `/command/ops` dashboard, bulk tournament job creation, staging + runbook in docs/COMMAND_OPS.md | Shipped |
| 2026-09-10 | **Phase 2 reviewer safeguards.** Scheduled regulation length on the job (5–9, default 7) gates a `regulation` final; early ends need a reason + audit note; run rule stays a suggestion. Our starting pitcher required (retroactive `setStartingPitcher` correction) or an audited unknown-pitcher exception before the record validates; our substitutions must be rostered players. Score tab laid out as a one-viewport workspace (compact player + at-bat; secondary content collapsed or behind tabs) | Decided |
| 2026-09-08 | **Phase 2 follow-ups — innings as outs, profile box score, game result.** `bs_outs` replaces `bs_ip` everywhere it is stored (engine publication, GameChanger import, boot migration); the catalog carries every appendix field with a batting/pitching/fielding group; the profile shows grouped totals with rates; `cmd_game_results` publishes score / line score / team totals with the record from a final live scorebook | Decided |
| 2026-09-08 | **Phase 2 block 3 — events ↔ internal metrics.** Pitches may carry `pitch_type` and `radar_reading_id`; a linked reading is matched to the pitcher of record via `classifyReading` (single source of truth for velocity). `time_home_to_first` on a play and `time_steal` on a runner event create running attempts at the tagged moment (`attempt_id` on the payload). Scorebook payload exposes readings, pitch types and activated modules | Decided |
| 2026-09-08 | **Phase 2 block 2 (first slice) — tagging from footage.** The scorebook embeds `FeedPlayer`; every event row is stamped with `selected_feed_id`, `timecode_s` and default `clip_start_s`/`clip_end_s`; pitches carry their own moments; play-by-play and scrubber markers jump to the footage; clips adjustable and audited. Second slice (same day): `state_adjustment` event (outs / score / bases / batting-order pointer, reason required, applied in sequence, `state_adjusted` info issue), dispute reasons incl. unclear footage, clip editor | Decided |
| 2026-09-08 | **Phase 2 block 1 — calculation contract.** Engine stores every appendix box-score field (batting/baserunning/pitching/fielding), derives rates as null-on-zero, rebuilds the count from pitches (`count_mismatch`), credits fielders from scoring notation, charges WP/BK/PB once per play, counts inherited runners, applies forced advances by rule, keeps a line score and team totals, and withholds an earned run awaiting scorer judgment from publication (`er_needs_judgment`). Contract tests in `server/scorebookContract.test.js` | Decided |
| 2026-09-08 | **Phase 2 started.** Scorebook events on `cmd_events`; replay-derived state and tallies (`CMD_SCOREBOOK_V1`); supersede-based corrections with immediate re-release; live scorebook as a `live_internal` game-record source through the existing release adapter (§7) | Decided |
| 2026-08-21 | **Dedicated Render worker deferred, not delivered.** A Render persistent disk attaches to exactly one service, so a separate worker cannot share the API's SQLite file. Pilot runs the inline worker; the dedicated worker is gated on the Postgres migration (TDR §1). Escalation path if transcoding starves latency: larger API instance first. | Decided — supersedes the M6 "dedicated worker service" line item |
