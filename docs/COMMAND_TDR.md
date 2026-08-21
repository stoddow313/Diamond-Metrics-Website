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

## 6. Decision log

| Date | Decision | Status |
|---|---|---|
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
| 2026-08-21 | **Dedicated Render worker deferred, not delivered.** A Render persistent disk attaches to exactly one service, so a separate worker cannot share the API's SQLite file. Pilot runs the inline worker; the dedicated worker is gated on the Postgres migration (TDR §1). Escalation path if transcoding starves latency: larger API instance first. | Decided — supersedes the M6 "dedicated worker service" line item |
