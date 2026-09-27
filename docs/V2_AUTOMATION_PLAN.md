# Diamond Metrics V2 — Postgame Ball Tracking & Automation: Build Plan

**Drafted:** 2026-09-21 · **Status:** Plan for owner review — no V2 code has been written
**Responds to:** "Diamond Metrics V2 Ball Tracking and Automation Vision" (founder working brief + dream-state
capability map + 21-section Technical Build Specification)
**Companion docs:** `docs/COMMAND_TDR.md` (V1 decisions) · `docs/COMMAND_OPS.md` (V1 runbook) · `docs/PLATFORM_ROADMAP.md`
**Baseline:** `main` @ `1a3762c`, 233 server tests passing

This is the V2 equivalent of the Command TDR: what the repo already gives us, what V2 adds, in what order, behind
which gates — and a traceability matrix (§18) mapping **every requirement in the brief** to the part of this plan that
satisfies it. Requirement IDs used throughout: **B-n** = founder brief, **D-n** = dream-state section, **S§-n** =
Technical Build Specification section §.

---

## 0. Summary

### 0.1 What is being asked
Turn a long postgame upload into a **reviewable pitch timeline**: the system finds every likely pitch, proposes the key
frames (first movement, release, plate arrival / catcher reception, bat contact) with confidence, and the analyst
verifies instead of scrubbing. The first releasable number is **pitcher time to home** (video measured). Velocity,
batted-ball classification, exit velocity / launch angle and pitch path follow — each only when its capture tier,
calibration and benchmark evidence earn it. Automation never publishes; V1 stays the system of record.

### 0.2 Three structural decisions this plan is built on

1. **V2 is a proposal layer; V1 is the record.** Model output lands in new `cmd_automation_*` tables and nowhere else.
   Nothing reaches `cmd_metric_results` except through an analyst action, and nothing reaches a profile except through
   the existing release adapter (`server/releaseLogic.js:376`). This is structural, not procedural: the scorebook's
   `loadEvents()` whitelists its event types (`server/scorebook.js:690`), so V2's new `pitch_timing` event type is
   invisible to the replay engine — V2 *cannot* create a counted pitch (B-5, D-20).
2. **Inference runs outside Render as a stateless GPU worker.** Render has no GPUs, and a Render disk attaches to one
   service, so nothing else can open the SQLite file (OPS §1). The worker therefore speaks HTTPS to the API with a
   machine token — the same principal pattern as the Field Live relay (`server/liveRoutes.js:52`) — and touches R2 only
   through short-TTL presigned URLs. No database access, no storage credentials, no third-party inference API ever sees
   a minor's footage. V2 forces **no** Postgres migration.
3. **Build the manual workflow first; automation pre-fills it.** The Pitch Timeline page ships first in *manual mode*.
   That one screen is simultaneously (a) a sellable `time_to_home` workflow, (b) the labeling tool, (c) the stopwatch
   that measures the "V1 manual baseline" the 40 % gate is judged against (B-55), and (d) the review UI the models
   later pre-populate. **Every milestone delivers value even if a model never clears its gate.**

### 0.3 Feasibility verdict by metric and capture tier  (S15-1)

| Target | Standard · behind home 1080p60 | Pro · side 4K/120 | Calibrated multi-angle | Consequence for the plan |
|---|---|---|---|---|
| Pitch-window discovery (≥ 95 % recall) | Feasible now — fixed mound / plate ROIs, pose + motion + audio, scorebook timecodes as priors | Feasible now — if mound and plate are both in frame | Feasible now | The first thing the spike proves; a false positive is cheap, a miss is not |
| First movement (median ≤ 3 frames) | Feasible with data — the target is aggressive; the ceiling is analyst agreement, not the model | Feasible with data — same ceiling | Feasible with data | Measure the human ceiling first (A6) and judge the model against it; publish stretch deliveries only |
| Ball release | Feasible with data — only when the ball is ≥ 6–8 px at the mound (≈ 2× framing); otherwise inferred from pose and flagged as inferred | Feasible with data — the arm-side view is the best view | Feasible with data + calibration | Range-or-unavailable stays; never an input to a Standard-tier customer number |
| Catcher reception (median ≤ 3 frames) | Feasible with data — **only when the glove is visible**; from low and directly behind, the catcher's back and the umpire hide it | Feasible with data — the camera-side batter can occlude | Feasible with data + calibration | Camera placement joins the Standard contract (§5.3); the glove-visible fraction is a week-one measurement |
| Bat contact | Feasible with data — audio-proposed, visually confirmed; ± 1 frame is irreducible (contact lasts < 1.5 ms) | Feasible with data — open-side batters | Feasible with data + calibration | Audio proposes, never defines |
| Pitcher time to home | Feasible now — manually today; assisted once both endpoints clear their gates | Feasible now | Feasible now | The first customer metric; roughly 5× tighter than a hand stopwatch (± 0.24 s) |
| Velocity — per pitch | Not defensible — realistic ± 4–8 mph at 95 % | Feasible with data + calibration — trajectory fit, ≈ ± 2 mph | Feasible with data + calibration | Internal research signal only at Standard tier |
| Velocity — outing average | Feasible with data + calibration — ± 2–3 mph after a one-constant fit to Pocket Radar, labelled estimated | Feasible with data + calibration | Feasible with data + calibration | The only Standard-tier velocity product worth pursuing — and never a *maximum* (§6.3) |
| Spray sector | Feasible with data + calibration — bearing from home is well observed | Not defensible — alone | Feasible now | V2-D, analyst-confirmed |
| Batted-ball type | Feasible with data — a classifier, not a measured angle | Feasible with data | Feasible now | V2-D |
| Exit velocity / launch angle | Not defensible | Research only — one side view foreshortens by the spray angle | Feasible with data + calibration | V2-E needs the home camera's bearing as well as the side view |
| Pitch path / movement | Not defensible | Research only | Research only — triangulation needs ≤ 1–1.5 ms sync | V2-F |

Sources and confidence for these verdicts are in §8.2, §6.3 and §10.3. Published anchors are thin for amateur
single-camera baseball — **there is no validated public result for release, reception or time-to-plate from this kind
of footage** — which is exactly why the spike, not this table, makes the go / no-go call.

### 0.4 Recommendation
**GO on V2-A now** (data contract, media QA, camera profiles, manual pitch timing, label tooling, worker contract,
rights controls, eval harness). It is ordinary product engineering on proven V1 patterns, it is valuable on its own,
and it produces the labeled data without which no feasibility answer is possible. **V2-B's models are a gated spike**
(§10.3): they ship to analysts only after clearing the brief's thresholds on a frozen held-out set, segmented by camera
profile. The critical path is **footage rights, labels and the legal policy — not code.**

---

## 1. What V1 already gives us, and the gaps

### 1.1 Reuse map (verified against the code)

| V2 need | V1 asset | Where | Status |
|---|---|---|---|
| Postgame upload of multi-GB originals | Resumable presigned multipart to R2, content-hash dedupe, originals kept byte-for-byte | `server/commandMediaRoutes.js`, `server/storage.js` | **Reuse** |
| CFR review proxy, never an assumed FPS | ≤1080p H.264 CFR proxy at native rate; measurements record `fps_used` of the *measured rendition* | `server/mediaWorker.js:284`, `server/measurementLogic.js:118` | **Extend** (timing map, §2.3) |
| Technical probe | codec, dimensions, rotation, nominal + effective FPS, VFR flag | `server/mediaWorker.js:111` | **Extend** (VFR is a 1 % nominal-vs-average heuristic at `:127`; no dropped-frame, timebase, audio or camera-change checks) |
| Reliable background jobs | Queue with claim tokens, heartbeat, stall watchdog, 3 attempts then terminal, retry | `cmd_media_jobs`, `server/mediaWorker.js` | **Reuse the pattern** for automation runs |
| Capture gate per metric, audited override | `CAPTURE_SPECS`, `assessCapture()`, `cmd_capture_overrides` (reviewer + written reason) | `server/captureSpec.js` | **Extend** (tier, view, calibration, stability) |
| Canonical event spine | Typed, parent-linked, supersede-corrected events carrying feed + timecode + clip bounds | `cmd_events` (`server/db.js:731`) | **Reuse** + one new event type |
| Frame measurement with evidence | start/end frame, `fps_used`, `formula_version`, validity, unavailable reason | `cmd_measurements` (`server/db.js:752`) | **Extend** (named marks; today hard-wired to `running_attempt`, `measurementLogic.js:107`) |
| Atomic results with provenance | method, status, unavailable reason, evidence link, calc version; one live result per evidence (partial unique index); withdraw / revive | `cmd_metric_results` (`server/db.js:708`, `:866`), `server/releaseLogic.js` | **Extend** (S11 fields) |
| Human approval authority | Reviewer/admin-only decisions; drafts block approval; role-gated transitions | `decideResult`, `computeQaFlags`, `roleCanTransition` | **Reuse unchanged** |
| Two independent release tracks | `metric_release_status` vs `game_record_status`; metrics release before the box score | `server/commandLogic.js:121` | **Reuse unchanged** |
| Unavailable is never zero | DM_RELEASE_V1 rollups; absent, never 0; `paid_metric_unavailable` notice | `server/metricRelease.js` | **Reuse** + new rollups |
| Append-only audit | prev/new state on every change | `cmd_review_actions` | **Reuse** |
| Test isolation | Synthetic orders run the full workflow and write nothing to profiles | `cmd_orders.synthetic` | **Reuse** (every V2 prod check runs on a synthetic job) |
| Frame-accurate review player | `requestVideoFrameCallback`, frame-centre seeks, hotkeys, scrubber markers, compact one-viewport mode | `src/pages/command/FeedPlayer.jsx` | **Extend** (overlay, window bands, filmstrip, loop) |
| A mark-two-frames queue with save-and-advance | Running queue + measurement drawer | `src/pages/command/RunningQueuePage.jsx` | **Pattern** for the Pitch Timeline |
| Registry rows for the V2 metrics | `time_to_home`, `pitch_velocity_video`, `exit_velocity_video`, `launch_angle_video`, `spray_direction` already seeded **inactive** | `server/commandLogic.js:16-21` | **Activate per phase** |
| Scorebook context for association | `pitch` events with `timecode_s`, `pitch_type`, `radar_reading_id`; PA payload already has `batted_ball` and `direction`; pitcher of record by replay | `server/scorebook.js:10-11,55-56` | **Reuse** — V2 proposes into these fields, V1 stays authoritative |
| Reference measurements | Immutable Pocket Radar readings (DB trigger), matched to the pitcher and linkable to a pitch event | `cmd_radar_readings`, `linkReadingToPitch` (`scorebook.js:821`) | **Reuse** — the radar↔video benchmark pair is already modelled |
| Machine principal that fails closed | `DM_RELAY_TOKEN`, routes unmounted unless enabled | `server/liveRoutes.js:52` | **Pattern** for the GPU worker |
| Pipeline telemetry + ops page | stage p50/p90, turnaround, unavailable / return rates | `server/telemetry.js`, `/command/ops` | **Extend** |
| Qualified capture source we control | Field Live iOS records a 1080p60 master with pinned frame duration (true CFR) | `field-live-poc/ios/FieldLive/Capture/CaptureCoordinator.swift:93` | **Reuse** as the reference Standard-tier capture device |
| Handedness for pull / oppo | `players.bats`, `players.throws` | `server/db.js:38` | **Reuse** |

### 1.2 Gaps V2 must close

| # | Gap | Evidence | Requirement |
|---|---|---|---|
| G1 | Jobs carry no field geometry: no division, pitching distance or base path | `cmd_jobs` DDL, `server/db.js:527` | S2-1, S7-1, S18-4 |
| G2 | No source↔proxy timestamp map; VFR check is a heuristic; no dropped-frame / timebase / audio / camera-change QA; no eligibility tier or stored QA record | `mediaWorker.js:111-134` | B-20, B-43, S2-2, S9-4 |
| G3 | `cmd_capture_profiles` is a static preset list, not a per-feed versioned camera profile with landmarks, transform, quality, active range, expiry | `server/db.js:561`, `commandLogic.js:156` | D-6, S2-3, S9, S11-1 |
| G4 | No candidate store, no ball tracks | — | S11-2, S11-3 |
| G5 | No GPU inference anywhere; no Python in the repo | — | S2-4, S8 |
| G6 | Measurement is two anonymous frames on a `running_attempt`; no named event marks, ranges, ambiguity reasons | `measurementLogic.js:106-146` | B-22, S4 |
| G7 | Trust vocabulary lacks `video_classified` and a source-priority rule; **`stat_entries.method` is written but never read** — profiles, aggregates, ratings and leaderboards are method-blind | `server/index.js:494` selects `metric_key, value` only; no `method` reference in `aggregates.js` / `ratingEngine.js` | D-3, S6-8, S19-3 |
| G8 | Unavailable reasons are 7 running-specific codes; the spec names 11 first-class reasons | `measurementLogic.js:6` | S10-3 |
| G9 | Results lack uncertainty/confidence, geometry inputs, evidence refs, model / calibration versions, source priority | `server/db.js:708` | S1-5, S6-1, S10-5, S11-4 |
| G10 | Analyst corrections are audited but not captured as labels; no split eligibility | — | B-16, S11-5 |
| G11 | No evaluation runs, frozen benchmark sets, model registry, rollout or rollback | — | S11-6, S13, S21 |
| G12 | **Evidence clips are never cut**: `handleClip()` is a no-op and nothing enqueues `clip`; clips are bounds on the proxy only | `mediaWorker.js:368` | B-11, B-22, S5-3 |
| G13 | Consent is one job-level checkbox; no per-feed rights, retention deadline or training-use flag; **no media purge path exists** (`deleteObject` is called only by backup pruning and the storage self-test); `deletePlayers` never touches media | `server/db.js:551`, `storage.js:144`, `playerDelete.js` | S20 |
| G14 | Customer surfaces show neither source labels, unavailable reasons nor clips (owner decision 2026-08-20: "numbers only; clips internal") | `buildProfilePayload`, `server/index.js:476` | S19 |
| G15 | No "escalate for second review", no blind double-labeling, no agreement measurement | — | B-56, S10-2, S12-3 |
| G16 | Telemetry measures stage hours, not analyst *active* minutes per pitch / game — so neither the 40 % gate nor the <10-minute Rookie target can be judged | `server/telemetry.js` | B-55, D-18, D-19 |
| G17 | `time_to_home`'s V1 capture spec says "Side view with release and plate" and sits under the 4K/120 side profile; the brief defines it from fixed **behind-home / centre-field** 1080p60 | `captureSpec.js:31`, `commandLogic.js:158` | B-31, S3-1 |
| G18 | Full-game proxy encodes are slow on the 1-CPU API instance, which caps any turnaround SLA | OPS §3.7 | D-17 |
| G19 | The repository is **public** on GitHub; proprietary model code, the annotation contract and cost models should not default into it | `gh repo view` → `PUBLIC` | B-50 |

---

## 2. Architecture

### 2.1 Two planes

```
                         CONTROL PLANE — V1, authoritative                    INFERENCE PLANE — V2, proposals only
 ┌────────────────┐   ┌──────────────────────────────────────────────┐      ┌─────────────────────────────────────┐
 │ Command UI     │   │ API · Express + SQLite (Render)              │      │ GPU worker · Python container        │
 │ (React, Vercel)│──▶│  identity · scorebook · approval · release   │◀─────│  stateless · no DB · no R2 keys      │
 │                │   │  + automation control: runs, candidates,     │ HTTPS│  claim → process → post back         │
 │ Pitch Timeline │   │    marks, recipes, feedback, eval, rights    │ token│  decode · QA · discover · localize   │
 │ Calibration    │   │  inline media worker: probe · proxy · clip   │      │  track · package evidence            │
 └───────┬────────┘   └───────────────┬──────────────────────────────┘      └──────────────┬──────────────────────┘
         │ presigned GET              │ presign only                                       │ presigned GET / PUT
         └────────────────────────────┴──────────────▶  Cloudflare R2  ◀───────────────────┘
                                          originals/ · renditions/ · automation/ · datasets/ · command/backups/
```

Rules that keep V1 authoritative (D-20), each pinned by a test:

- The worker's token authorises **only** `/api/automation/worker/*`. Those routes can write runs, QA records,
  candidates, proposed marks and tracks. They cannot write `cmd_events`, `cmd_measurements`, `cmd_metric_results`,
  `stat_entries`, job status, or anything under `/api/command/*`.
- A result row is created **only** by an analyst decision on the Pitch Timeline, through the same
  `resultForEvidence` / `applyResultState` lifecycle every V1 measurement uses (one result per evidence, withdraw /
  revive, immediate profile resync).
- Release is unchanged: `computeQaFlags` blocks on any unreviewed draft, reviewer/admin approves per result, the
  adapter publishes approved rollups. Automation-assisted results are ordinary `draft` results when created — an
  analyst accepting a proposed frame is *measurement*, not *approval*.
- Kill switch: `DM_AUTOMATION_ENABLED` unset ⇒ worker routes are not mounted and no run is queued; Command behaves
  exactly as V1 with the manual Pitch Timeline.

### 2.2 Lifecycle of one feed

```
upload complete ─▶ probe ─▶ L1 gate (instant: resolution, fps, codec, VFR)            [API]
                     │         ├─ ineligible ─▶ QA record + reasons; manual / clip linkage only; no run queued   (B-35)
                     ▼         ▼
                  CFR proxy ─▶ feed READY ─▶ analyst confirms capture profile + landmarks (or later)
                     │
                     ▼
        automation run QUEUED  (only if: enabled · L1 eligible · order has an assisted metric · rights allow analysis)
                     │  kick (HTTPS) + scheduled poll as backstop
                     ▼
   worker CLAIMS ─▶ stage 0 deep QA: PTS scan, true-CFR test, dropped frames, blur / exposure, plate + pitcher
                     │             visibility, camera-stability segments ─▶ eligibility score + reasons
                     │             ├─ fails ─▶ run BLOCKED_INELIGIBLE with reasons (no GPU spent on stages 1-3)
                     ▼
                  stage 1 discovery  (whole game, low res / low fps, high recall)  ─▶ candidate windows
                  stage 2 in-window: actors + pose + ball candidates ─▶ track hypotheses (with gaps)
                  stage 3 event localization ─▶ per-mark frame distributions + competing hypotheses
                  stage 4 evidence packaging ─▶ filmstrips, overlay JSON, clip requests
                     │  POST candidates / marks / tracks (idempotent) · artifacts PUT to R2 · COMPLETE
                     ▼
   API: association (candidate ↔ scorebook pitch, pitcher, batter, radar reading) ─▶ queue ordering
                     ▼
   analyst: accept · adjust · split · merge · reject (class) · unavailable (reason) · escalate     ─▶ feedback row
                     ▼
   accept ─▶ pitch_timing event + measurement (named marks) ─▶ recipe ─▶ DRAFT result (full provenance)
                     ▼
   V1 review ─▶ approve / return ─▶ V1 metric release ─▶ profile rollup            (unchanged path, B-24)
```

### 2.3 Frame and time integrity  (B-43, S2-2, S9-4)

"Never calculate a frame-based metric from an assumed FPS. Persist original timing and proxy mapping."

- **One index space for humans and models.** Analysts mark frames on the CFR proxy. Discovery, pose and event
  spotting run on the **same proxy rendition** (its `rendition_id` is recorded on the run), so model frame *N* is
  analyst frame *N* with no conversion. Re-encoding a proxy invalidates its runs by construction (different
  `rendition_id`), consistent with OPS §3.8a.
- **The timing map.** Deep QA reads every video packet's presentation timestamp from the **original** and stores
  the array in R2 (`automation/{feed}/timing/source_pts.f64`, ≈3.4 MB for a two-hour 60 fps game) with a summary on
  the QA record: timebase, first PTS, frame count, max inter-frame jitter, dropped-frame gaps, duplicate stamps. The
  proxy→source frame mapping is derived from it and stored alongside.
- **True CFR test** replaces the 1 % heuristic: a feed is `cfr_verified` only when every inter-frame delta is within
  tolerance of one constant duration. Gaps near integer multiples of the frame duration are counted as dropped frames.
- **Elapsed time comes from source timestamps**: `elapsed = pts_source(end) − pts_source(start)`. For a verified-CFR
  source this equals `(end − start) ÷ fps` exactly, and the recipe records both plus `timing_basis`. For VFR sources
  *with* reliable timestamps the PTS form stays correct where frame counting would not; VFR *without* reliable
  timestamps is ineligible (B-35).
- **Higher-resolution originals.** A 4K original is reviewed on a 1080p proxy, which quarters the ball's pixel area.
  In Pro Capture the ball tracker reads the **original** inside candidate windows and maps frames through the timing
  map. This is why the map is built in V2-A although only V2-E strictly needs it.
- **Gate extension.** The M2 frame-accuracy gate (burned-in frame counter, OPS §3.7) gains fixtures for VFR,
  dropped frames, 119.88→59.94 halving and a rotated phone clip; each must map proxy↔source exactly.

### 2.4 Where data lives

SQLite stays small (1 GB disk, nightly snapshot): **rows and summaries only.** Anything per-frame goes to R2.

| R2 prefix | Contents | Lifecycle |
|---|---|---|
| `originals/` | uploads, untouched | existing: IA at 30 d, delete at 730 d |
| `renditions/{feed}/` | proxy, thumbnails, **evidence clips** | retained while referenced |
| `automation/{feed}/timing/` | source PTS array, proxy↔source map | with the original |
| `automation/{feed}/{run}/` | raw detections, pose, ball-track points, mark distributions, overlay JSON, filmstrip sprites | 180 d unless cited by a result or a dataset manifest (then retained with it) |
| `datasets/{snapshot}/` | label manifests (rights-filtered), split assignment, protocol version | retained; rebuilt on revocation |
| `eval/{set}/`, `eval/runs/{id}/` | frozen benchmark manifests (hash-pinned), run reports | permanent |
| `models/{bundle}/` | weights + container digest manifest | production and previous retained for rollback |

### 2.5 Security and privacy posture

- The worker holds **one secret** (`DM_AUTOMATION_TOKEN`) and receives presigned URLs scoped to one feed's objects
  with a TTL that covers one run. It never holds R2 keys and never opens the database.
- **No third-party inference APIs.** Footage of minors is decoded only inside our own container on rented GPU
  compute, streamed from R2 and discarded with the container. Hosted model endpoints are out of scope.
- All new analyst routes sit behind `requireInternal`; governance, rights and dataset export require `admin`; the
  profile API gains fields only through an explicit server-side allowlist (S19-1).
- Rights are checked at three points: before a run is queued (analysis permitted), before a clip is exposed to a
  customer (display permitted), and at dataset export (training / evaluation permitted) — fail closed at each.

### 2.6 Failure handling

Same guarantees as the media pipeline (OPS §3.11): claim tokens, heartbeats, stall sweep, three attempts then a terminal
state with a specific reason, idempotent retries, `alertOps` on terminal failure. Result delivery is idempotent on
`(run_id, candidate_key)` so a worker that dies after posting half its candidates can simply re-post. A run that
exceeds its GPU-seconds budget is cancelled and reported rather than allowed to burn money.

Serverless GPUs are **preemptible**, so the worker checkpoints to R2 — the discovery window list, then every ≈ 50
localized windows — and a re-claimed run resumes instead of restarting. Retries belong to the API (an expired lease
requeues; the third failure is terminal and alerts); the GPU platform's own retry is switched off so there is one
source of truth. Artifact keys are deterministic (`automation/{feed}/{run}/{window}…`), so a retry overwrites rather
than duplicates. The worker runs a start-up self-test — hardware decode present, decode device asserted, fps
measured — and fails loudly rather than silently falling back to a slow path.

---

## 3. Data model additions  (S11)

All additive, `cmd_`-prefixed, created with the existing boot-time pattern (`CREATE TABLE IF NOT EXISTS`,
`addColumnIfMissing`). Naming note: V1's `cmd_capture_profiles` remains the **capture-profile preset** (the tier
contract, e.g. `behind_home_1080p60`); the new `cmd_camera_profiles` is **this feed's verified geometry and state**.

### 3.1 Job geometry and the capture log  (G1, B-41, S12-2)

```sql
-- cmd_jobs
division_label        TEXT     -- e.g. "12U", "14U", "Varsity"
pitching_distance_ft  REAL     -- 46 | 50 | 54 | 60.5 | other — NULL until verified
base_path_ft          REAL     -- 60 | 70 | 80 | 90
geometry_source       TEXT     -- ruleset | tournament_division | manual
geometry_verified_by  INTEGER, geometry_verified_at TEXT      -- audited 'geometry_verified'
intended_capture_tier TEXT     -- standard | pro_side | multi_angle

-- cmd_video_feeds (capture log; recording_notes already holds optional operator notes, D-13)
camera_position TEXT  -- behind_home | center_field | side_1b | side_3b | elevated | other
camera_height_ft REAL, device_model TEXT, lens_zoom TEXT, orientation TEXT
source_type     TEXT  -- field_live_app | phone | camcorder | action_cam | unknown
camera_moved_reported INTEGER   -- the operator's own report; detection is separate
```

Distance is **suggested** from `divisions.age_group` / `teams.age_group` and must be **verified** by a person. Any
recipe that uses distance refuses to run while `pitching_distance_ft` is NULL or unverified — there is no default and
no 60 ft 6 in anywhere in code (S18-4).

### 3.2 `cmd_media_qa` — the saved "Media QA record and eligibility reason"  (B-20)

```sql
id, feed_id, qa_version, level            -- probe | deep
eligible_tier                              -- standard | pro_side | multi_angle | ineligible
score REAL                                 -- 0..1 eligibility score (S9-5)
reasons  TEXT  -- JSON [{code, severity: blocking|warning, detail}]
metrics  TEXT  -- JSON {cfr_verified, jitter_ms, dropped_frames, dup_frames, timebase, has_audio, av_offset_ms,
               --       blur, exposure, plate_visible_pct, pitcher_visible_pct, stability_segments:[{from,to,score}]}
pts_map_key TEXT, created_by, created_at, superseded_by
```
A downgrade or block is overridable only through the existing audited override path (reviewer + written reason).

### 3.3 `cmd_camera_profiles`  (S11-1, S9)

```sql
id, feed_id, job_id, version, rendition_id
capture_profile_key     -- FK to the preset (tier contract)
tier, view_archetype    -- behind_home | center_field | side | elevated
pitching_distance_ft, base_path_ft          -- snapshot of the job geometry used
landmarks   TEXT -- JSON [{name: plate_front_l | plate_apex | box_rf | rubber_c | first_base…, x, y, source: auto|analyst}]
rois        TEXT -- JSON {mound, plate, batter_box_l, batter_box_r}  (model crops)
transform   TEXT -- JSON 3×3 image→field homography
residual_px REAL, plate_plane_supported INTEGER
lens        TEXT -- JSON {lens_profile_id, k1, k2…}   optional (S9-2)
camera_state TEXT -- JSON {mount, height_ft, facing, zoom, crop}
stability_score REAL, quality_score REAL
active_from_frame INTEGER, active_to_frame INTEGER   -- NULL = open ended
status      -- draft | verified | expired | superseded
expired_reason -- camera_moved | zoom_changed | manual
reviewer_id, verified_at, created_by, created_at
```
A detected pan, zoom or bump closes the active profile at that frame; candidates after it have **no verified
geometry** until a new version is verified, so geometry-dependent recipes return `invalid_geometry` rather than a
number. Frame-timing recipes (time to home) need a camera profile for ROIs and tier, **not** a homography — the
calibration tool is built in V2-A but only gates recipes that use geometry.

`cmd_lens_profiles` (optional intrinsics per device / lens mode, checkerboard or vendor-sourced) arrives with Pro
Capture.

### 3.4 `cmd_automation_runs`

```sql
id, job_id, feed_id, rendition_id, pipeline   -- 'pitch_timeline'
model_bundle_id, params_hash,  UNIQUE (feed_id, pipeline, model_bundle_id, params_hash)
mode        -- production | shadow
status      -- queued | running | succeeded | failed | cancelled | blocked_ineligible
stage, progress TEXT, attempts, claim_token, heartbeat_at, worker_id, error
started_at, finished_at, gpu_seconds REAL, cost_usd_est REAL, budget_gpu_seconds REAL
artifacts_prefix, summary TEXT   -- JSON counts by type / reason
```

### 3.5 `cmd_automation_candidates`  (S11-2)

```sql
id, run_id, job_id, feed_id, rendition_id, candidate_key      -- idempotency within a run
candidate_type   -- pitch | ball_in_play | running_h2f | running_steal   (later: throw, fielding)
window_start_frame, window_end_frame, window_start_s, window_end_s
discovery_confidence REAL
eligibility, ineligible_reason
actors TEXT      -- JSON summary: pitcher / catcher / batter boxes + track ids, ball-visible fraction
outputs_key TEXT -- R2: raw detector / pose output for the window
origin           -- model | analyst_manual      (a manual add is a recorded model miss)
status           -- proposed | in_review | accepted | rejected | unavailable | merged | split | escalated
reject_class     -- pickoff | warmup | mound_visit | catcher_throwback | replay_or_cut | between_innings |
                 --   duplicate | not_baseball | other          (the negative-example taxonomy, B-38)
parent_candidate_id, merged_into_id                              -- split / merge lineage
linked_event_id  -- V1 scorebook pitch / PA event — authoritative (B-47)
association TEXT -- JSON {method, score, alternatives[]}
pitcher_player_id, batter_player_id, batter_label
timing_event_id  -- the pitch_timing cmd_event created on acceptance
second_review TEXT -- JSON {requested_by, reason, status, reviewer_id, outcome}
reviewed_by, reviewed_at, review_ms
```

### 3.6 `cmd_candidate_marks` — event-frame proposals and decisions

```sql
id, candidate_id
mark_type        -- first_movement | release | plate_crossing | reception | contact | bip_direction
proposed_frame, proposed_lo, proposed_hi, confidence REAL
hypotheses TEXT  -- JSON top-k [{frame, p}] — a distribution, not one unqualified answer (B-46)
model_bundle_id
decision         -- accepted | adjusted | rejected | unavailable | unknown
approved_frame, approved_lo, approved_hi     -- release may be a defensible range (S4-2)
delta_frames     -- approved − proposed (the correction magnitude)
unavailable_reason, ambiguity_reason          -- S4-1
visibility       -- clear | partial | inferred   (every accuracy figure is reported per visibility class)
reception_kind   -- caught | blocked | missed | fouled | in_play | hit_batter   (S4-4)
analyst_id, decided_at, note
```

### 3.7 `cmd_ball_tracks`  (S11-3)

```sql
id, candidate_id, segment       -- pitch_flight | batted_ball | throw
hypothesis_rank, is_primary
coordinate_space                -- proxy_px | source_px | field_ft
n_points, n_gaps, coverage_pct, mean_confidence
tracker_version, model_bundle_id
points_key   -- R2 JSON: [{frame, t, x, y, conf, observed}], gaps: [{from, to, reason}]
overlay_key
```
Only **observed** points are stored as observations. Interpolated spans are flagged `observed: false`, drawn
differently in the overlay, and ignored by recipes unless a recipe version explicitly permits them — "track
hypotheses with confidence and gaps, not a fabricated continuous track" (S8-4).

### 3.8 Event, measurement and result extensions  (S11-4, D-5)

- **New event type `pitch_timing`** on `cmd_events`, created only when an analyst accepts a candidate. It is outside
  `loadEvents()`'s whitelist, so box-score tallies and `bs_pitches` can never see it. When a scorebook pitch exists
  the timing event is its **child** (`parent_event_id`), so V1's correction logic — which already re-parents
  children (`scorebook.js:965`) — carries the link through a supersede. A voided parent leaves the timing event
  intact and flags it for re-association.
- **`cmd_measurements`** gains: `start_mark`, `end_mark` (named endpoints), `marks` JSON (every approved mark),
  `source_pts_start`, `source_pts_end`, `timing_basis`, `delivery_type` (stretch | windup | unknown), `candidate_id`,
  `camera_profile_id`, `model_bundle_id`. `measurement_type` gains `time_to_home`; `formula_version` carries the
  recipe version. `saveMeasurement` is generalised from `running_attempt` to a recipe-driven event family.
- **`cmd_metric_results`** gains: `recipe_id`, `source_priority`, `confidence`, `uncertainty` JSON, `inputs` JSON
  (frame endpoints, FPS / timebase, distance and geometry inputs, `endpoint_definition`), `evidence_refs` JSON (feed,
  rendition, frame range, clip key, overlay key, track id), `capture_tier`, `camera_profile_id`, `model_bundle_id`,
  `candidate_id`, and `release_scope` (`customer` | `internal_research`). The existing `method`, `status`,
  `unavailable_reason`, `evidence_kind/evidence_id`, `calculation_version` and the one-live-result-per-evidence index
  are unchanged. Release decisions stay in `cmd_review_actions`.
- **`cmd_metric_registry`** gains: `recipe_id`, `min_tier`, `needs_calibration`, `needs_sync`, `releasable`
  (0 = internal research only — the adapter refuses it regardless of approval).

### 3.9 `cmd_model_feedback`  (S11-5) — append-only, immutable by trigger

```sql
id, candidate_id, mark_id, run_id, model_bundle_id
action        -- accept | adjust | reject | split | merge | unavailable | escalate | manual_add
before TEXT, after TEXT            -- proposed vs corrected labels
correction_magnitude_frames
label_origin  -- correction | blind | double_review        (anchoring matters — §9.3)
reviewer_id, review_ms
quality_review_outcome             -- NULL | confirmed | overturned
dataset_split, split_reason        -- train | val | test | excluded — assigned per game + camera group
created_at
```
Training eligibility is **computed at export** from `cmd_feed_rights`, never stored, so a revocation takes effect on
the next snapshot without a backfill.

### 3.10 Governance and evaluation  (S11-6, S21)

```sql
cmd_model_bundles  (id, key, components JSON  -- per-stage model id + weights sha256 + code sha + container digest
                   , recipe_versions JSON, routing JSON  -- by view archetype / tier
                   , status   -- candidate | shadow | limited | production | rolled_back | retired
                   , rollout JSON, release_owner, approved_by, approved_at, decision_evidence JSON, previous_bundle_id)
cmd_eval_sets      (id, key, status draft|frozen|retired, frozen_at, manifest_key, manifest_hash, strata JSON,
                    n_games, n_items, label_protocol_version)                      -- frozen rows immutable by trigger
cmd_eval_runs      (id, eval_set_id, model_bundle_id, recipe_versions JSON, calibration_version, metrics JSON,
                    cost_usd, latency_s, vs_bundle_id, verdicts JSON, report_key, created_by, created_at)
```

### 3.11 Rights, retention and deletion  (S20)

```sql
cmd_feed_rights      (feed_id PK, uploader_kind, uploader_ref, permitted_uses JSON
                        -- {analysis, evidence_internal, evidence_customer, model_training, model_evaluation}
                     , consent_status recorded|pending|revoked|expired, consent_basis, consent_ref, policy_version
                     , retention_deadline, restrictions JSON, revoked_at, revoked_by)
cmd_deletion_requests(id, scope feed|job|player|order, target_id, reason deletion_request|consent_revoked|retention_expired
                     , requested_by, status open|in_progress|completed|legal_hold
                     , steps JSON  -- originals · proxies · clips · overlays · tracks · filmstrips · customer access ·
                                   -- training eligibility · dataset manifests — each with a timestamp
                     , completed_at)
```
Defaults are conservative: `model_training = false` and `evidence_customer = false` unless explicitly granted.

### 3.12 Work-time instrumentation  (G16)

`cmd_work_sessions (id, job_id, analyst_id, surface, item_type, item_id, active_ms, idle_ms, started_at)` — the Pitch
Timeline, running queue and scorebook report focus-aware active time per item. This is the denominator for "analyst
minutes per eligible game" and the only honest way to judge B-55, D-18 and D-19.

### 3.13 Coupled changes

`server/playerDelete.js` must clear or null the new player references (its test fails on any missed table);
`server/backup.js` verify counts gain the new tables; ops retention adds the `automation/` prefix rule.

---

## 4. Event definitions — annotation contract v0.1 (draft to lock before training)  (B-25…31, S4)

The brief is right that a model cannot be scored against a vague baseball concept. Below is a **draft** for the
founders and lead analyst to edit and lock; it becomes `docs/ANNOTATION_CONTRACT.md`, versioned, and its version is
stamped on every label. Each target is classed as an **observable visual event** or an **inferred quantity**.

| Target | Class | Frame decision rule (draft) | Excluded / ambiguity reasons | Unavailable when |
|---|---|---|---|---|
| **First movement** | observable, judgment | After the pitcher has come **set** (hands together, discernible stop): the first frame of continuous motion that ends in a delivery to the plate — the earliest of (a) the lead foot unweighting / lead knee starting up or forward (slide step included), or (b) the hands starting to break as part of the delivery. `delivery_type` recorded: stretch / windup / unknown; windup start = first frame of the rocker step or hands starting up. | Glove flutter, re-grip, head turn, shoulder look-back, non-committal rock, step-off. A pickoff or step-off is **not a pitch** → candidate rejected with class `pickoff`. Ambiguity reasons: `no_discernible_stop`, `quick_pitch`, `gradual_onset`, `pitcher_partially_occluded`. | Pitcher obscured; no stable pre-delivery view; motion not separable from routine set movement → `pitcher_not_visible` / `first_movement_ambiguous`. |
| **Release** | observable | First frame in which a visible gap separates ball and fingertips. If blur prevents one defensible frame, record a **range** `[lo, hi]` of at most 3 frames. | `motion_blur`, `hand_behind_body`. | Ball hidden by body, hand or blur → `ball_not_visible`. |
| **Plate crossing** | **inferred** (geometry) | Frame in which the ball centre reaches the calibrated plane of the front edge of home plate. | — | No verified camera profile with `plate_plane_supported`, or the ball disappears before the plane → `invalid_geometry` / `ball_not_visible`. Never assumed equal to reception. |
| **Catcher reception** | observable | First frame of ball–glove contact. When the ball itself is not resolvable, first frame of glove impact (pocket closes / glove recoils) with ambiguity `glove_motion_used`. `reception_kind` is mandatory: caught / blocked / missed / fouled / in play / hit batter. Only `caught` closes a time-to-home by reception. | `catcher_occluded_by_batter_or_umpire`, `glove_motion_used`. | Glove and ball occluded, catch not visible → `catch_or_contact_obscured`. |
| **Bat contact** | observable | First frame in which ball and bat visibly meet (overlap, or the ball's image-space direction reverses between consecutive frames). Never the follow-through, never audio alone. | `contact_behind_body`, `foul_tip_uncertain`. | Contact hidden or off screen → `catch_or_contact_obscured`; analyst may mark `unknown`. |
| **Ball-in-play direction** | observable → classified | Initial outbound direction over the first frames after contact, relative to field geometry and `players.bats`: pull / middle / opposite (V1 `DIRECTIONS`). Broad sector only. | `ball_lost_after_contact`. | No verified geometry, or handedness unknown → sector by field side only, or `invalid_geometry`. |
| **Pitcher time to home** | measured | `(end − first movement) ÷ verified FPS`, equivalently the source-PTS difference. `end` is **explicitly** reception, or calibrated plate crossing; the recipe stores which. | — | Either endpoint unavailable, or the feed fails QA. |

Audio (the glove pop, the bat crack) may **propose** a candidate frame and raise confidence; it never defines one
(B-30). Sound reaches a camera 30–60 ft behind the plate roughly 27–53 ms late — 1.6 to 3.2 frames at 60 fps — so an
audio cue is corrected by a per-feed offset and still only seeds the visual search.

---

## 5. Capture tiers and the quality gate  (B-32…35, D-4, S3, S9-5)

"A camera tier is a product contract, not a cosmetic label." V1 already enforces per-metric capture specs with an
audited override; V2 extends the same mechanism rather than adding a second gate.

### 5.1 Tier ladder

| Tier (stored) | Contract | May produce | May not produce |
|---|---|---|---|
| `ineligible` | 720p; VFR without reliable timestamps; severe blur; plate or pitcher missing; heavily edited; unknown frame timing | Clip linkage and manual scorebook only. **No automation run is queued.** | Any automated timing result |
| `standard_continuous` | Ordinary continuous game camera | Scorebook linkage, pitch / play discovery, clips, basic timing *candidates* | Ball-flight physics, launch angle, trusted velocity |
| `standard` | Fixed behind home or centre field · 1080p · true constant 60 fps (120 preferred) · plate, catcher, pitcher visible · no aggressive digital zoom · stable | Pitch windows; first movement, release, reception, contact candidates; **time to home**; broad hit direction; batted-ball class proposals | Precise release or plate-plane location in difficult light; any velocity beyond an internal research signal |
| `pro_side` | Fixed calibrated side view, 4K/120 preferred, synchronized with the standard view where possible | Cleaner release / contact; release-to-plate velocity estimate; exit-velocity and launch-angle research → gated estimate | Calibrated 3-D movement without validation |
| `multi_angle` | Synchronized fixed cameras, known geometry, repeatable calibration | Pitch path, plate location, movement research, richer batted-ball geometry | Stadium-grade precision claims without benchmark evidence |

### 5.2 Enforcement
- `CAPTURE_SPECS` entries gain `min_tier`, `views[]`, `needs_calibration`, `needs_sync`, `needs_stability`.
  `assessCapture()` additionally reads the QA record and the active camera profile, so its issues now include
  `camera_moved`, `plate_not_visible`, `invalid_geometry`, `no_qualified_capture`.
- The tier is checked **twice**: when the recipe computes (no draft is created from a feed below `min_tier`) and
  again at release (a result whose camera profile expired or whose QA was superseded is held with a QA flag).
- **G17 reconciliation:** `time_to_home` moves to `views: [behind_home, center_field]`, `min_tier: standard`,
  `min_fps: 60` (matching V1's existing 60 fps block and spec §3's "1080p/60 minimum"), and joins the
  `behind_home_1080p60` preset's expected metrics.
- Every gate outcome is a row with a reason. Coverage reporting (B-57) is a query, not a hope: the count of
  candidates and ordered metrics with neither a result nor a structured reason must be zero.

### 5.3 Placement joins the contract
"Behind home, 1080p60, fixed" is necessary and not sufficient. The feasibility work shows that *where* the camera
sits decides which events exist in the footage at all:

| Placement rule | Why | How it is enforced |
|---|---|---|
| **Elevated and / or offset** so the catcher's glove is visible past the catcher's back and the umpire | Reception is the occluded event from behind home — without this the endpoint of time to home is a proxy | Deep QA reports the **glove-visible fraction**; below threshold, reception-based recipes route to review or `catch_or_contact_obscured` |
| **≈ 2× framing** (mound to plate fills the frame); no ultra-wide action cameras for ball-dependent events | At 1× a baseball at the mound is ≈ 4 px; at 2× ≈ 7–8 px; on an action cam ≈ 1.5 px | QA estimates ball-scale from the plate's pixel width; release and ball tracks are gated on it |
| **Lens against, or above, the net or fence**; focus and exposure **locked** | Autofocus hunts to the net; a moving net eats the bitrate the ball needs | QA flags net-in-frame and focus breathing |
| **Stabilization off**; tripod, never handheld | Electronic stabilization floats the image ± 2–5 px and defeats geometry; handheld footage is timing-only | Stability segments; a handheld feed is classed `standard_continuous`, uncalibrated |
| **True constant frame rate, fast shutter** | Phones record variable frame rate by default; a 1/60 s shutter at night smears every event | True-CFR test on source timestamps (§2.3); blur score in QA |

Two assets already exist for this. The **Field Live iOS app** owns its capture session and already pins frame
duration for a true-CFR 1080p60 master — it can also lock focus and exposure, disable stabilization, fix a framing
preset, and **write the capture log automatically** (device, lens, zoom, FPS, orientation). And the public **filming
guide** (`src/pages/BaseballFilmingGuidePage.jsx`) becomes the customer-facing version of this table.

---

## 6. Metric recipes, trust labels and the truth hierarchy  (D-3, S6, S7)

### 6.1 One trust policy, consumed everywhere
New pure module `server/trustPolicy.js`, the single place this is decided, imported by the release adapter,
aggregates, rating engine, profile API and the UI chips.

| Trust label (shown) | Stored `method` | Priority | Headline on profile | Averages & trends | Leaderboards, benchmarks, ratings, recruiting outputs |
|---|---|---|---|---|---|
| Radar verified | `radar_verified` | 1 | yes | yes | yes |
| Video estimated — validated calibrated multi-angle | `video_estimated` (`capture_tier = multi_angle`) | 2 | yes, labelled | within its own key only | **no**, until an explicit product rule |
| Video measured | `frame_timed` *(displayed as "Video measured")* | 3 | yes | yes | yes — timing metrics have no stronger source |
| Video classified | `video_classified` **(new)** | 4 | yes, labelled | as distributions | no |
| Unavailable | status `unavailable` + reason | 5 | plain-language reason | never (not zero, not in a denominator) | never |
| *(V1, non-video)* Scorebook derived · Manual / imported | `scorebook_derived` · `manual` / NULL | — | as today | as today | as today |

**A weaker source can never overwrite a stronger one — by construction.** `stat_entries` is unique on
`(game_id, metric_key)`, so video estimates publish to **their own keys** (`est_max_velo`, `est_avg_velo`,
`est_max_exit_velo`, `est_launch_angle` …) and never to `max_velo`. Leaderboards, benchmarks and the rating engine
read only the verified keys, so an estimate cannot move a ranking until a product rule says so. The profile shows
the strongest available source per concept and names it: "78.4 mph · Radar verified" or "≈77 mph · Video estimated"
(S19-3). The adapter test asserts that releasing an estimate leaves a radar value untouched.

### 6.2 Recipes (pure, versioned modules under `server/recipes/`, each with `node:test` contract tests)

| Recipe id | Formula and stored inputs | Trust label | Min tier | Release stance |
|---|---|---|---|---|
| `TTH_V1` — pitcher time to home | `(end − first_movement) ÷ verified FPS` ≡ source-PTS difference. Stores both frames, `end_mark` (reception \| plate_crossing), FPS, timebase, `timing_basis`, `delivery_type`, feed, rendition, camera profile, model bundle (if assisted), mark confidences, analyst edits. Uncertainty = endpoint quantization ⊕ recorded ranges. | Video measured | `standard` | Analyst-approved; customer-releasable once the owner confirms the rollup rule (§16 D3) |
| `PVV_REC_V1` — velocity, release→**reception** | `(distance − extension + reception_offset) ÷ elapsed`, mph, with an explicit drag model converting path-average speed to release-equivalent speed. Stores release / reception frames, FPS, configured distance, extension and offset assumptions *with their uncertainty*, air-density input, endpoint definition, tier, versions. | Video estimated | `standard` | **`internal_research` only** — analysts see it as a research signal; the adapter refuses it |
| `PVV_PLATE_V1` — velocity, release→**plate plane** | Calibrated distance between the observed release point and the plate plane ÷ elapsed. | Video estimated | `pro_side` | Internal until the §10 gate; then "video-estimated" language only |
| `SPRAY_SECTOR_V1` | Contact mark + initial outbound direction through the field homography + batter handedness → pull / middle / opposite. **Proposes into the V1 PA `direction` field**; the scorer's value stays authoritative. | Video classified | `standard` + verified geometry | Analyst-confirmed |
| `BB_TYPE_V1` | Post-contact trajectory / appearance → ground ball / line drive / fly ball / pop-up / unknown. Proposes into V1 `batted_ball` (`BATTED_BALLS`). | Video classified | `standard` | Analyst-confirmed; `unknown` always available |
| `EV_V1`, `LA_V1` | Initial post-contact speed / vertical angle from calibrated high-FPS side tracking; track points, frame times, calibration, uncertainty stored. | Video estimated | `pro_side` | Later phase; never "radar verified" without a device |
| `MOVE_V1` | Reconstructed trajectory vs an explicit no-spin reference in a calibrated frame. | Video estimated | `multi_angle` | Research only |

The two velocity recipes have different ids, different labels and a stored `endpoint_definition`, so they can never
share an ambiguous "velocity" (S7-2).

### 6.3 The velocity caveat, quantified  (S7, S15-6)

The brief calls velocity "the measurement with the greatest risk of false precision." The arithmetic agrees, and it
sets a harder bar than the event gates do: **a 3-frame endpoint error is harmless for time to home (50 ms on ≈ 1.3 s
is 4 %) and ruinous for velocity (3 frames on a ≈ 0.5 s flight is 5–8 mph).**

Per-pitch 95 % error from release→reception timing, assuming each endpoint is labelled to σ = 1 frame (realistic
after analyst review; release from behind home is the weak one). Flight = distance − extension + glove depth:

| Frame rate | 46 ft · 55 mph | 50 ft · 62 mph | 54 ft · 70 mph | 60.5 ft · 80 mph | Reading |
|---|---|---|---|---|---|
| 30 fps | ± 9.8 | ± 11.5 | ± 13.6 | ± 15.9 | Not defensible in any form |
| 60 fps | ± 4.9 | ± 5.8 | ± 6.8 | ± 8.0 | Per pitch not defensible — outing average only |
| 120 fps | ± 2.5 | ± 2.9 | ± 3.4 | ± 4.0 | Marginal per pitch — needs sub-frame endpoints |
| 240 fps | ± 1.2 | ± 1.4 | ± 1.7 | ± 2.0 | Per pitch defensible with a measured distance |

Even with *perfect* labels, frame quantization alone leaves ± 1.3–2.0 mph at 60 fps (95 %). On top of the random
error sit three **systematic** terms that do not average away:

- **Average is not peak.** A radar reads speed near release; time of flight gives the path average. A baseball loses
  about 8–10 % of its speed on the way to the plate, so a timing-derived number reads **≈ 3.5–4.5 % low (2–4 mph)**.
  In a quadratic-drag model the ratio depends on flight distance and air density, not on speed — so the right
  correction is a **drag model with one fitted constant**, not a bare scale factor, and it must take air density as an
  input (at ≈ 4,500 ft the correction is ≈ 0.5 mph smaller than at sea level).
- **Distance is assumed, not measured.** From behind home, one foot of depth at the mound is about one pixel:
  release extension and glove depth cannot be measured. Each unmeasured foot is **± 1.3 mph**, per pitcher and per
  catcher. Glove depth is plausibly 2–5 ft behind the plate's front edge, not a constant.
- **"First visibly detached" lags true release** by up to a frame (+1.3–2.6 mph), a bias that must be calibrated per
  capture setup.

**Recommendations (S15-6).**
1. *Standard tier:* compute **release→reception** (the only two endpoints observable from behind home) as an internal
   research signal per pitch. The only candidate customer product is a **per-outing average** (`est_avg_velo`,
   n ≥ 15 pitches, "video estimated"), after a one-constant drag fit against Pocket Radar shows the outing mean within
   ± 2 mph. Random error falls as 1/√N; bias does not, which is why the fit and the benchmark come first.
2. **Never publish a video-estimated *maximum* from 60 fps footage.** The maximum of N noisy estimates is biased
   high — by roughly 2–2.5 σ over a 30–100 pitch outing — so with σ ≈ 2–4 mph per pitch a "max velo" would overstate
   by about 4–10 mph. Only the mean is defensible.
3. *Pro side capture:* **release→plate plane by trajectory fit.** From the side the ball moves 50–190 px per frame, so
   a fitted track locates both endpoints to a few hundredths of a frame and measures the flight distance directly from
   calibration. This is the first defensible per-pitch estimate (≈ ± 2 mph) and the claim language stays "video
   estimated" permanently.
4. The two recipes never share a label (S7-2), and neither is called "velocity" without its qualifier.

Published anchors, for scale: broadcast-video ball tracking has reported 2.5 mph mean absolute error against MLB's
own system, with a ± 2–2.5 mph *camera-dependent bias*; a learned regression on broadcast clips averaged 3.6 mph. Both
used professional telephoto footage — amateur behind-home capture will not beat them.

### 6.4 Release mapping additions (`DM_RELEASE_V2`, extending TDR §5a)

| Command metric | Atomic records kept | Published rollup |
|---|---|---|
| Time to home | every approved pitch (marks, frames, FPS, delivery type) + unavailable pitches with reasons | **Proposed:** mean of approved **stretch** deliveries → new public key `time_to_home` (pitching, seconds, lower is better), published only at n ≥ 3; best and count as sample metadata; windup times kept internally. Owner decision D3. |
| Video-estimated velocity | every estimate with inputs and uncertainty | none while `releasable = 0`; later `est_max_velo` / `est_avg_velo` |
| Spray sector / batted-ball type | every confirmed classification | feeds the V1 scorebook fields; `pull_pct` / `middle_pct` / `oppo_pct` derive from confirmed PAs |

### 6.5 Unavailable reasons — one vocabulary  (S10-3)

The spec's eleven become first-class codes alongside V1's running-specific ones, in one shared module with a
**customer plain-language map** (S19-4):

`camera_moved` · `plate_not_visible` · `ball_not_visible` · `insufficient_frame_rate` *(V1 code, = "frame rate
insufficient")* · `pitcher_identity_unresolved` · `catch_or_contact_obscured` · `invalid_geometry` ·
`conflicting_source` · `no_qualified_capture` · `model_confidence_too_low` · `other_with_note` — plus V1's
`base_not_visible`, `runner_or_ball_obscured`, `camera_stopped`, `no_valid_attempt`, `insufficient_capture_quality`.

Customer wording collapses these to three honest sentences — *capture quality was not sufficient* · *the event was
not visible on camera* · *the required camera view was not available* — and never exposes the internal code.
`model_confidence_too_low` is an **internal routing reason**: it sends a candidate to the exception queue; if the
analyst also cannot determine the frame, the *analyst's* reason is what is stored on the result.

---

## 7. Analyst experience  (B-48, S5-3, S10)

### 7.1 Pitch Timeline workspace — `/command/jobs/:jobId/pitches`
A fourth module tile on the job page beside Radar, Running, Scorebook and Review (`CommandPages.jsx:798-819`). One
laptop viewport (1366×768 and 1440×900, the V1 standard): the video never scrolls away from the controls.

```
┌──────────────────────────────────────────────────────────────┬────────────────────────────────┐
│ FeedPlayer (compact) + overlay canvas                        │ QUEUE   214 pitches            │
│   boxes P · C · B   ball track (gaps dashed)   mark flags    │ ▸ Exceptions 17 · To review 61 │
│                                                              │   Accepted 129 · Rejected 7    │
│ ──────▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓────────  window band on scrubber   │ ────────────────────────────── │
│        ▲FM            ▲REL ▲REC    proposed marks + spread   │ #087  T3 · Carter → #7         │
│ filmstrip  [-3][-2][-1][ 0 ][+1][+2][+3]   ◀ active mark ▶   │  FM   51,204   ●●●○  0.81      │
├──────────────────────────────────────────────────────────────┤  REL  51,262   ●●○○  0.55      │
│ Time to home  1.37 s = (51,286 − 51,204) ÷ 59.94   TTH_V1    │  REC  51,286   ●●●●  0.93 caught│
│ Video measured · behind_home_1080p60 · profile v2 · ptl-0.3  │  CON  —                        │
│ ⏎ accept  M set mark  1-4 pick mark  U unavailable  X not a  │  TTH  1.37 s · stretch         │
│ pitch  S split  G merge next  E escalate  N note  ⇥ next     │ [Accept ⏎] [Unavailable] [✕]   │
└──────────────────────────────────────────────────────────────┴────────────────────────────────┘
```

- **Preloaded, not scrubbed.** Selecting a candidate seeks to its window and loops it. The worker pre-renders a
  **filmstrip sprite** per mark (frames −4…+4 in one image) so side-by-side frame comparison is instant — no seek
  latency — and a dual-frame pane shows the first-movement and reception frames together (B-48 "side by side frame
  stepping").
- **Every action in S10-2:** accept · adjust frame(s) · replace · split at the playhead · merge with next · mark
  invalid / unavailable with a structured reason · note · escalate for second review. Plus **manual add** for a
  missed pitch, which is recorded as a model miss.
- **Exception-first ordering:** ineligible-with-reason, low confidence, disagreeing hypotheses, association
  conflicts and duplicates sort to the top; confident candidates batch behind them.
- **Formula on screen** with frames, FPS, source feed, confidence, recipe version and review status (B-10).
- **Identity is sticky**, like the running queue's runner: with a scorebook, pitcher and batter come from the replayed
  state at the linked pitch; without one (Rookie), the analyst sets the pitcher once and it carries forward until
  changed. An unresolved pitcher is `pitcher_identity_unresolved`, never a guess.
- **Scorebook reconciliation:** per half-inning, accepted pitch candidates are compared with the scorebook's pitch
  count — a free recall cross-check whenever a full scorebook exists, surfaced as a QA flag, never auto-fixed.
- Every action writes `cmd_model_feedback` + `cmd_review_actions` + a work-session record.

### 7.2 Modes of the same screen
**Manual** (no run: the analyst creates candidates and marks — the V1 baseline, measured) · **Assisted** (markers
preloaded) · **Label** (blind: proposals hidden, used for benchmark and double review) · **Second review** (the
escalation inbox for a reviewer).

### 7.3 Calibration tool — on the feed viewer
Click named landmarks on a reference frame (plate corners, batter's-box corners, rubber, visible bases); the server
solves the homography, returns the reprojection residual and a quality score, and draws the reprojected field lines
over the frame for a visual sanity check. Auto-detected landmarks (V2-B onward) arrive as proposals the analyst
verifies. Expiry and versioning per §3.3.

### 7.4 Review & publish
The existing review page lists results with their evidence; V2 adds the trust-label chip, confidence, recipe, model
bundle, camera-profile version and a link that opens the exact clip and overlay (D-11).

---

## 8. The inference plane  (B-42…46, S8, S15-2, S15-3)

### 8.1 Pipeline stages ↔ spec §8

| Spec stage | Where it runs | Non-negotiable output | This plan |
|---|---|---|---|
| 1 Ingest and media QA | API probe (L1) + worker stage 0 (deep) | Eligibility result + explicit reasons | `cmd_media_qa`, timing map |
| 2 Field / camera calibration | Analyst tool (API); auto-landmarks and change detection in the worker | Versioned profile, transform, quality | `cmd_camera_profiles` |
| 3 Candidate discovery | Worker stage 1 — whole game, low res / fps, scorebook timecodes as priors | Short windows, high recall, non-final classes | `cmd_automation_candidates` |
| 4 Detection and tracking | Worker stage 2 — inside windows only, mound / plate ROIs from the camera profile | Track hypotheses with confidence **and gaps** | `cmd_ball_tracks` + R2 |
| 5 Event localization | Worker stage 3 | Candidate frames, confidence, competing hypotheses | `cmd_candidate_marks.hypotheses` |
| 6 Metric calculation | **API**, from approved frames only | Atomic metric candidate with full provenance | `server/recipes/*` → draft result |
| 7 Review and learning | Command UI + API | Immutable audit + reusable labels | `cmd_model_feedback` |
| 8 Release and monitoring | V1 adapter + ops | Correct public / internal state + drift metrics | §6.4, §11 |

Metric calculation deliberately lives in the **API**, not the worker: recipes are pure, versioned, unit-tested
JavaScript next to the release mapping, so a recipe change is a reviewed code change with tests — never a side effect
of swapping a model.

### 8.2 Model plan and licensing  (B-50, S15-3)

License facts below were checked against the actual LICENSE files, model cards and vendor terms on 2026-09-21. They
are a diligence input, not legal advice, and licenses move (two entries below changed terms *after* people adopted
them) — so the adoption rule is: **pin the commit, archive the license text beside the weights hash in the model
bundle, and re-verify at every upgrade.**

| Layer | First choice | License (code · weights) | Verdict | Notes and fallback |
|---|---|---|---|---|
| Actor detection (pitcher, catcher, batter, glove, bat) | RF-DETR Nano–Large, fine-tuned on our footage | Apache-2.0 · Apache-2.0 | SAFE | **Not** the XL / 2XL sizes (paid Roboflow plan required). Fallbacks: D-FINE, RT-DETRv2 from the original repo or the HF port — *not* the Ultralytics re-implementation |
| Pose (pitcher delivery cues) | MediaPipe BlazePose on the pitcher crop for the spike | Apache-2.0 · Apache-2.0 (Google-consented training data) | SAFE | RTMPose / RTMO code is Apache-2.0 but the shipped **weights carry no license** and were trained on sets with unclear commercial terms — hold until cleared, or train our own. Production path needs no pose weights at all (next row) |
| Event localization | E2E-Spot on native-resolution mound and plate crops, trained on our labels | BSD-3-Clause | SAFE | Crop, do not downsample the whole frame — resolution matters more than architecture. T-DEED is GPL-3.0: usable server-side only, never in anything we distribute |
| Discovery (whole game) | Rules first: fixed ROIs + arm-speed peak + plate activity / audio pop 0.35–0.7 s later; then a light temporal classifier if recall demands | own code | SAFE | Rejects pickoffs (no plate activity), warm-ups (no batter in the box), throw-backs (reversed order), recording gaps (timestamps) |
| Ball detection and tracking | WASB-SBDT or TrackNetV3 code, **retrained on our footage** | MIT | SAFE | Shipped weights were trained on broadcast tennis / badminton — do not use them. Official TrackNet / V2 repos have **no license** (all rights reserved). No permissive baseball tracker exists |
| Association of detections | ByteTrack / OC-SORT via `roboflow/trackers` or `supervision`; batch RANSAC over a ballistic + drag model for the ball | Apache-2.0 / MIT | SAFE | Batch, not a causal filter — we are postgame. Avoid `boxmot` (AGPL) and the original SORT / DeepSORT (GPL) |
| Backbones | RegNet-Y (E2E-Spot default), DINOv2, V-JEPA 2 | BSD / Apache-2.0 / MIT | SAFE | VideoMAE, VideoMAEv2 weights, TimeSformer, V-JEPA v1 are non-commercial. DINOv3 allows commercial use under a custom Meta license — avoid unless needed |
| Camera-change detection | ORB / KLT on a static mask + RANSAC similarity (OpenCV headless) | Apache-2.0 | SAFE | Mask the net; expire calibration at > 2 px median displacement or > 0.5 % scale change persisting 2–3 s; "occluded" is a different state from "moved" |
| Decode and media | FFmpeg, PyAV or torchcodec, NVIDIA DALI | LGPL/GPL · BSD · Apache-2.0 | COND | A GPL FFmpeg build (x264) is fine **server-side**; it becomes a source-disclosure duty the moment we ship a binary — an on-prem install, a customer container, or an edge box. Decide before any such product |
| Spatial labeling (ball points, boxes) | A click-the-ball mode on our own overlay canvas; CVAT Community self-hosted if boxes / keypoints are needed at volume | own · MIT | SAFE | Temporal labels stay in Command (same player, same frame index, rights-aware). CVAT's SAM 2 tracker is not in the Community edition; pre-labeling with a non-commercial model is itself a commercial use |

What looks free and is not:

| Trap | Why it bites a closed-source SaaS |
|---|---|
| **BaseballCV** — the brief's suggested starting point | Relicensed in 2025 to AGPL-3.0 **or a paid commercial license** for any commercial entity. Its detectors are Ultralytics YOLO (AGPL) and a GPL YOLOv9 fork; its weights carry no grant of their own; and its datasets are frames **taken from MLB broadcasts**, which MLB's terms restrict to personal non-commercial use. Code: no. Weights: no. Datasets: no. It is also centre-field telephoto, a poor match for youth footage. Read it for ideas; reimplement on the stack above |
| Ultralytics YOLO (v5 / v8 / 11 / newer), YOLOv10, YOLOv12 | AGPL-3.0. Ultralytics' stated position is that any SaaS using YOLO "behind the scenes" needs an Enterprise License (price unpublished), and that models trained with its code inherit AGPL |
| `roboflow/sports` | MIT code, but the examples pull Ultralytics weights and Bundesliga broadcast data — take the ideas and the MIT utilities only |
| Permissive code, restricted weights | YOLO-NAS (no production use), VideoMAEv2 (CC BY-NC), Detectron2 zoo (CC BY-SA), RTMPose (unstated) |
| Relicensing after adoption | DEIMv2 moved from Apache-2.0 to non-commercial in August 2026; BaseballCV moved from MIT in 2025 |
| Outright non-commercial | OpenPose, AlphaPose, Sapiens v1, CoTracker, VideoMAE, TimeSformer. Sapiens2 additionally bars biometric processing — unsuitable for footage of minors |
| Broadcast-footage datasets | MLB-derived, Bundesliga, SoccerNet (NDA), TrackNet / WASB sets. A permissive tag on a dataset does not clear footage rights the uploader never owned |

**Data provenance rule (S17).** Models are trained only on footage Diamond Metrics shot or that customers uploaded
under terms permitting it, plus permissively licensed *generic* pretraining. Nothing scraped, nothing from broadcast.
Every dataset snapshot records its sources; every model bundle records its snapshot.

### 8.3 Worker contract
A versioned JSON schema (`automation-contract/v1`) is the *only* coupling between the planes: claim payload in,
QA / candidates / marks / tracks out. Models, frameworks and the GPU host can all change without touching Command
(B-42). A **reference stub worker** (deterministic candidates from scorebook timecodes or fixed intervals, no ML)
ships in V2-A so the whole loop is proven, tested and demoable before a single model exists.

### 8.4 Reproducibility
A run pins the rendition id, the model bundle (weights hashes + container digest), the contract version and a params
hash. Re-running the same tuple is a no-op; a new bundle is a new run whose candidates sit beside the old ones for
comparison. Inference is deterministic per bundle (fixed seeds, fixed decode path) so an evaluation can be repeated
exactly (S13-7).

---

## 9. Data, labeling and ground-truth program  (B-36…41, S12)

The brief's position — model quality will be driven more by representative labels and a disciplined evaluation set
than by model family — is the correct one, and it makes this section the critical path.

### 9.1 What Diamond Metrics must supply (owner-side)
| Item | Volume | Notes |
|---|---|---|
| Rights-cleared full games | **12–20 for the first feasibility read** (≥ 8 fields, ≥ 5 camera models); the brief's **40–80** to answer by camera profile; 60–100 across ≥ 30 fields for production | Diversity of setups matters more than pitch count: age groups, day / night, uniforms, RHP / LHP, nets and fences, phone vs camcorder vs Field Live |
| Controlled bullpen / cage sessions with Pocket Radar | 10–15 sessions, ≥ 300 radar-paired pitches for the first read | The velocity benchmark; every pitch paired with a reading |
| Labeled pitch windows | **1,500–3,000 for the first read**; the brief's several thousand with first movement + reception for a by-profile answer; ≥ 500 with release and contact from good views; 15–25k for production | Produced on the Pitch Timeline in manual mode; at production scale the review loop produces them as a by-product |
| Deliberate negatives | ≥ 50 per class | pickoffs, warm-ups, mound visits, catcher throw-backs, replays / cuts, between innings |
| Double-reviewed held-out benchmark | 300–500 pitches across all strata | Blind, two annotators, disagreements retained |
| Capture log per feed | every feed | §3.1 fields — enforced at upload |

### 9.2 Splits — by game **and** camera group, never by frame
Each feed is assigned `train | val | test` deterministically from a hash of its field / camera group at ingestion. A
game never straddles splits; a test-set field never appears in training. Benchmark games are frozen and excluded from
every training snapshot by construction (S13-7, S21-1).

### 9.3 Anchoring — why "label mode" exists
A label produced by correcting a model's proposal is biased toward that proposal. Such labels are fine for training
(`label_origin = correction`), but the **benchmark must be labeled blind** (`blind`), by two people independently
(`double_review`). The measured inter-annotator difference is the **agreement ceiling** (B-56): a model cannot
meaningfully beat it, and a first-movement definition that two trained analysts disagree on by more than ~3 frames
needs rewriting *before* anyone trains against it.

The agreement report gives, per event and per visibility class: median and 90th-percentile absolute difference, the
share within 1 / 2 / 3 frames, and the **signed bias** between annotators (a consistent early or late labeler is a
training problem, not noise). A sample is re-labelled by the same person after about two weeks to separate
definition ambiguity from individual drift. Models are scored against the consensus label, and disputes are kept,
not averaged away.

### 9.4 Active learning (D-7)
Each retrain samples the highest-value corrections: low-confidence candidates, large `delta_frames`, manual adds
(misses), rejected false positives, and under-represented strata. Failures are reviewed by camera profile, age group,
lighting, compression and field geometry — all columns on the capture log or the QA record.

### 9.5 Export
`POST /api/command/datasets/export` (admin) writes a manifest to `datasets/{snapshot}/`: V1 events, results, evidence
refs, review status, media metadata, marks and feedback (B-39) — filtered by `cmd_feed_rights` at export time, with
the snapshot id recorded on any model trained from it so a later revocation can be traced to affected bundles.

---

## 10. Evaluation protocol and model-release governance  (B-52…58, S13, S21)

### 10.1 Metric definitions (fixed before the first run)
- **Pitch-window recall** — an annotated eligible pitch counts as found if a candidate window contains its reception
  (or contact) frame and starts before its first-movement frame. Reported with **duplicate rate** and **false
  positives per game** (the "manageable review queue" half of B-52).
- **Frame error** — `|proposed − label|` per mark type: median, p90, p95; against the blind benchmark.
- **Coverage** — share of eligible pitches with a proposal at or above the operating confidence, per mark type; the
  remainder must each carry a reason.
- **Analyst time** — active minutes per reviewed eligible pitch, assisted vs manual, same analysts, same games,
  counterbalanced order; agreement with the benchmark must not fall.
- **Velocity** — bias, MAE, p90 / p95 absolute error and coverage against contemporaneous radar.
- **Classification** — confusion matrix, analyst agreement, and the **false-confident rate**.
- Every figure is broken out by capture tier, camera orientation, age group, day / night, blur and calibration
  quality, so a strong average cannot hide a bad deployment condition.

### 10.2 Gates (the brief's thresholds, adopted as written)

| Capability | Gate to advance | Release stance when passed |
|---|---|---|
| Pitch discovery | ≥ 95 % recall on qualified held-out games; misses analysed by reason; queue size reported | Assisted review on |
| First movement / reception | Median error ≤ 3 frames at 60 fps on qualified footage, reported beside the human agreement ceiling | Assisted markers on |
| Time to home | Analyst-approved values only; ≥ 40 % less analyst time per eligible pitch, agreement not lower | Customer release of the video-measured metric |
| Coverage reporting | 100 % of ineligible / low-confidence cases carry an explicit reason | Required for any of the above |
| Video-estimated velocity | Pre-approved accuracy + coverage threshold across configured distances and tiers | Internal → labelled estimate |
| Hit direction / type | Agreement, confusion matrix, false-confident rate | Analyst-confirmed classification |
| Exit velocity / launch angle | Metric-specific threshold vs a trusted reference on aligned calibrated sessions | Research → gated estimate |

### 10.3 The decisive spike (the brief's "shortest technical spike")

One engineer, two to four weeks, once A5 / A6 have produced labels. It answers "is the analyst copilot feasible on
our footage?" with numbers, in this order — cheapest baselines first, because they may already be enough:

1. **Data (week 0–1).** 8–10 games from ≥ 5 fields, some through a net and some above it. ≈ 1,500 pitches labelled
   with the five event frames plus visibility flags; 300 double-labelled; Pocket Radar logged on ≥ 300 pitches.
   **Measure the annotator ceiling and the glove-visible fraction first** — both are available in week one, and
   between them they decide most of the answer before any model runs.
2. **Discovery without a deep model.** Fixed mound and plate ROIs from the camera profile, person detection and
   pose, throwing-arm speed peak, plate-region activity or an audio pop 0.35–0.7 s later; rule-based rejection of
   pickoffs, warm-ups, throw-backs and recording gaps.
3. **Event baselines from signals.** First movement = backward search from the arm-speed peak to the first
   sustained rise in motion energy after a still "set"; release = elbow-extension / wrist-speed rule; reception =
   glove-region frame-difference spike + offset-corrected audio; contact = audio onset + bat-region motion. A Viterbi
   pass enforces event order and plausible intervals.
4. **Learned challenger (week 2–3).** E2E-Spot on native-resolution crops, 60 fps, 100–128-frame clips — only where a
   baseline misses its gate.
5. **Ball-tracking probe.** WASB zero-shot, then fine-tuned on 2–3k clicked ball frames. Report the share of pitches
   with ≥ 8 in-flight detections and with a detection within ± 1 frame of release and of reception, split by framing
   and net / no net. This sizes V2-C honestly before anyone builds it.
6. **Velocity from human labels.** Physics first, model error excluded: fit one drag constant against radar; report
   per-pitch and per-outing error distributions.

| Item | Go threshold | If it fails |
|---|---|---|
| Pitch discovery | Recall ≥ 95 % on held-out fields (lower 90 % CI ≥ 92 %) at ≤ 0.5 false positives per true pitch | Add the learned classifier; lean on scorebook timecodes as priors |
| First movement | Median error ≤ max(3 frames, 1.25 × the measured analyst median); p90 ≤ 8 frames | Tighten the definition (A6) before touching the model; assisted marker still ships if it cuts time |
| Reception, glove visible | Median ≤ 2 frames, p90 ≤ 5. If glove-visible pitches are < 60 % of the sample, **fix capture placement, not the model** | Placement rules (§5.3) become mandatory for the Standard tier |
| Release, ball ≥ 6 px | Median ≤ 2 frames | Stays range-or-unavailable; no effect on time to home |
| Copilot productivity | ≥ 60–70 % of proposals accepted untouched; ≥ 90 % within a ± 3-frame nudge; ≥ 40 % less analyst time per pitch (the brief's bar), agreement not lower | Ship discovery + seek-to-window only — still removes the scrubbing |
| Velocity | Outing mean within ± 2 mph of radar after one global fit | Document "not defensible at Standard tier"; revisit only with Pro side capture |

The brief's absolute ≤ 3-frame target for first movement may be tighter than two trained analysts agree with each
other — plausibly 2–4 frames from the stretch and 4–8 from the windup. A model cannot meaningfully beat the people
who label it, so the gate is expressed against the measured ceiling, and D3 (publish stretch deliveries only) keeps
the customer number on the better-defined side of that line.

### 10.4 Release governance (S21)
1. **Freeze** benchmark sets by tier, age group, camera position, lighting and failure mode — immutable rows, hash-pinned manifests.
2. **Compare** every candidate bundle against production on recall, frame error, coverage, false-positive rate, analyst override rate, unavailable-reason mix, processing cost and analyst minutes saved.
3. **Protected metrics:** each metric × tier has an approved threshold and a regression tolerance; a bundle that improves one outcome while pushing another past its tolerance **does not ship**.
4. **Shadow → limited → production.** Shadow runs execute beside production and are never shown to analysts; limited rollout targets a percentage of jobs with a defined QA sample; each promotion records bundle, calibration and recipe versions, release owner, date and the evaluation runs that justified it.
5. **Rollback is a pointer flip** to `previous_bundle_id`; the previous bundle's weights and container stay available. Results already released keep their provenance; any remediation goes through V1's withdraw / revive and audit rules (OPS §3.12) — history is never silently rewritten.

---

## 11. Monitoring, service levels and cost  (D-9, D-17, D-21, S15-2)

### 11.1 Ops panel additions (`/command/ops`)
Automation queue and stalls · GPU-seconds and **cost per processed game** · coverage and confidence distribution per
metric · median `|delta_frames|` per mark and camera profile · analyst override rate · false-positive (reject) rate ·
manual-add rate (the production proxy for recall) · scorebook pitch-count reconciliation · unavailable-reason mix ·
**analyst active minutes per eligible game** vs the Rookie < 10 min and Advanced ≈ 30 min targets. Drift alerts fire
through the existing `alertOps` webhook when a weekly figure leaves its control band against the evaluation baseline.

### 11.2 Proposed starting service levels — to be replaced by measured p90 after the pilot
| Package / tier | Machine processing (upload complete → queue ready) | Analyst active time (target) | Customer turnaround (proposal) |
|---|---|---|---|
| Rookie · Standard | same day; bounded today by the proxy encode (G18) | < 10 min per qualified game | next business day |
| Advanced · Pro Capture | ≤ 24 h | ≈ 30 min per qualified game (from ≈ 90) | 72 h |
| Any · Ineligible footage | probe only | manual workflow | per V1, with the reason stated |

No requirement forces a result during the game or before analyst QA. In V1's tradition these are **operating
targets measured on the ops page, not promises**.

### 11.3 Cost per processed game

Prices were read from vendor pricing pages on 2026-09-21; throughput figures are engineering estimates derived from
published benchmarks and must be replaced by measurements in the spike. Workload per Standard game: a two-hour
1080p60 file (≈ 432,000 frames, 8–15 GB) — a whole-game discovery pass, then heavy models on ≈ 300 windows × 6 s
(≈ 110,000 frames), then ≈ 300 evidence clips.

| Per game | GPU-minutes on one L4 (low / expected / high) | Modal L4 (≈ $1.12/h all-in) | RunPod Serverless 24 GB (≈ $0.69/h) |
|---|---|---|---|
| **Standard** — one 1080p60 camera | 14 / **24** / 60 | $0.26 / **$0.45** / $1.12 | $0.16 / **$0.28** / $0.69 |
| **Pro Capture** — adds a 4K/120 side camera, processed inside windows only | 29 / **52** / 130 | $0.54 / **$0.97** / $2.42 | $0.33 / **$0.60** / $1.50 |
| Derived artifacts in R2 (≈ 300 clips + JSON) | — | ≈ $0.02 per game-month Standard · ≈ $0.06 Pro | same |
| **Source video retained in R2** | — | ≈ $0.18 per game-month for 12 GB · ≈ $0.86 for a Pro game | same |

The "high" column is an unoptimised first implementation (eager PyTorch, one decode session, CPU preprocessing).

**What this says.**
- **Compute is not the constraint.** A whole Standard game costs about what *one minute* of analyst time costs. The
  business case is analyst minutes (§11.1), and even a several-fold miss on these estimates does not change it.
- **The largest recurring line is not GPU — it is keeping originals.** Within about three months, storing a game's
  source costs more than processing it did. V1's lifecycle rule (originals → Infrequent Access at 30 days, delete at
  24 months; OPS §3.4) already handles this; V2 adds an `automation/` rule and changes nothing else.
- **At volume:** ≈ $4/month GPU at 100 games a year (inside Modal's free monthly credit), ≈ $37/month at 1,000,
  ≈ $112/month at 3,000 — Standard tier, expected case. A 200-game tournament weekend is ≈ 80 GPU-hours: about eight
  hours of wall-clock on ten concurrent L4s, comfortably inside a next-business-day turnaround.

| Host | Fit | Why |
|---|---|---|
| **Modal — L4** *(recommended)* | Primary | Per-second billing, scale to zero, function timeout up to 24 h, 10 concurrent GPUs on the free plan with a monthly credit that covers the pilot, cron + HTTPS endpoint + secrets built in — nothing to operate. Risks to design for: GPU functions are **always preemptible** (checkpoint to R2), and hardware video decode under its sandbox is inferred rather than documented (**day-one smoke test**) |
| **RunPod Serverless — 24 GB tier pinned to L4** | Fallback | ≈ 40 % cheaper, plain Docker, execution timeout up to 7 days, no egress fees. The same container behind a ≈ 20-line handler. Raise the 600 s default timeout and the worker cap before a tournament |
| AWS Batch g6 Spot / GCP Batch g2 Spot | Only above ≈ 5,000 games a year | Cheapest per hour, but GPU quota starts at **zero** and needs a request, VM boot adds minutes, and egress on clips back to R2 erodes the Spot discount |
| Cloud Run GPU jobs · SageMaker async / batch · Baseten async · Replicate | Ruled out | Hard caps of **≤ 1 hour** (Replicate 30 min) per GPU task — a first-implementation or Pro game can exceed it |
| Render · Cloudflare | Not possible | Render offers no GPU instances; Cloudflare cannot run custom GPU containers |

**Why the L4.** Decode is a large share of this workload and the L4 carries four hardware decode engines and two
encode engines (an A10 has two and one; an A100 / H100 cannot hardware-encode clips at all), at 20–30 % less than an
A10. The small models in §8.2 cannot saturate anything larger.

**Operational notes that will otherwise bite.** Set the platform's job timeout explicitly (defaults are 300–600 s).
Decode each window sequentially from its preceding keyframe — random-access frame grabs are ≈ 10× slower. Assert the
decode device and measure fps at start-up (one popular library falls back to CPU decoding *silently*). TensorRT
engines are tied to GPU architecture, so a GPU fallback list needs a per-architecture engine cache. Cap concurrent
workers so a tournament burst does not hammer the single API instance. Have the Pro side camera record HEVC.
A CPU-only discovery stage was evaluated and rejected: it saves nothing and adds a second code path.

### 11.4 Cost controls
Two-stage pipeline (cheap discovery everywhere, expensive models only inside windows) · stages skipped when the
order does not need them · content-hash dedupe so a re-upload never re-runs · explicit action to re-run with a new
bundle · per-run GPU-seconds budget with cancellation · monthly spend ceiling with an alert.

---

## 12. Customer-facing changes  (S19, D-11)

The consumer surface stays simple. The profile API exposes — through a server-side allowlist, never by passing rows
through — only:

- the **approved value** and its **trust label** (Radar verified · Video measured · Video estimated · Video
  classified · Scorebook);
- for a velocity, the source stated in words; an estimate is never styled like a radar reading;
- an **unavailable** state for an ordered metric, with one of three plain-language reasons;
- the **approved performance clip(s)** for a released result — only where the order's sharing scope and the feed's
  `evidence_customer` right both allow it.

Never exposed: confidence scores, frame markers, calibration residuals, model versions, override history, exception
notes, queues. The brief's capability map mentions profiles carrying "confidence" while §19 forbids internal
uncertainty; this plan resolves it as: customers see the *label* and, for estimates, a **benchmark-derived accuracy
statement** approved as product copy (e.g. "typically within ± x mph of radar") — never a per-result model score.

Clips on customer surfaces **reverses the owner decision of 2026-08-20** ("Phase 1 publishes numbers only; evidence
clips stay internal"). It needs an explicit owner + counsel decision (§16 D5); the default stays off.

---

## 13. Rights, privacy and retention  (S20)

Counsel writes the policy (minor-athlete footage, training consent, access, retention, deletion, revocation, derived
labels after source deletion). Engineering ships it as **controls**, with conservative defaults until it exists:

- A rights record for every feed (§3.11); upload requires uploader identity and permitted uses.
- Training and evaluation exports are filtered by rights at export time — fail closed.
- A deletion or revocation request runs a tracked checklist: originals → proxies → clips → overlays, tracks,
  filmstrips → customer access revoked → training eligibility removed → dataset manifests rebuilt — each step
  timestamped, the whole request audited. This is the first real media-purge path in the system (G13).
- Derived labels after source deletion follow a policy switch (`retain_anonymized` | `delete`) — counsel's call.
- Dataset snapshot ids recorded on model bundles make "which models saw this footage" an answerable question.
- Retention: `automation/` artifacts expire at 180 d unless cited; nothing needed for audit is deleted before the
  retention and consent policy allows (S18-5).

---

## 14. Delivery plan

Phases follow the spec's V2-A…F. Each milestone is one branch + one PR with files touched, tests added and
verification evidence; the owner merges; Render is deployed manually and verified on a **synthetic job** after every
server merge (the V1 routine). Brief-phase mapping: Phase 0 = V2-A · Phase 1 = V2-B models + assisted review ·
Phase 2 = V2-B operations (B5–B8) · Phase 3 = V2-C / V2-E · Phase 4 = expansion across package types + V2-F.

### V2-A — Feasibility and data contract · internal only

| M | Contents | Gate |
|---|---|---|
| **A1** | Job geometry (division, verified pitching distance, base path, intended tier) on new-job, bulk and job pages; feed capture-log fields; **capture placement guide** (§5.3) as an operator checklist and an update to the public filming guide | A distance-dependent recipe refuses an unverified job; bulk jobs inherit a *suggested* distance from the division; audited |
| **A2** | `trustPolicy.js`; `video_classified`; unified unavailable-reason vocabulary + customer map; result / registry extension columns; `est_*` catalog keys | Tests: weaker source cannot overwrite stronger; unavailable never enters a rollup; `releasable = 0` is refused by the adapter |
| **A3** | Media QA v2: deep PTS scan, true-CFR test, dropped / duplicate frames, timebase, audio; eligibility tier + reasons; `cmd_media_qa`; L1 gate | Fixtures (VFR, dropped frames, 720p, 30 fps, rotated, 119.88→59.94) classify correctly and map proxy↔source exactly |
| **A4** | Camera profiles + calibration tool: landmarks, homography, residual, quality score, versions, active ranges, manual expiry | Homography solver within tolerance on synthetic projections; an expired profile blocks geometry recipes |
| **A5** | **Manual pitch timing**: `pitch_timing` events, named marks, `TTH_V1`, generalised measurement, Pitch Timeline (manual mode, hotkeys), work-session timing; `time_to_home` activated internally | A pitch timed end to end with formula / frames / FPS / source shown; synthetic release writes nothing; **V1 manual baseline measured on ≥ 3 games** |
| **A6** | Label mode, blind double review, agreement report, negative-class labeling, annotation contract v1 linked in-app | Agreement ceiling measured on ≥ 200 double-labeled pitches; disputes retained |
| **A7** | Candidate store, worker routes (token, fail-closed, unmounted by default), run queue with heartbeat / retry / budget, **stub worker** | Full loop on a synthetic job with the stub; tests for timeout, duplicate delivery, stale claim, kill switch, and that worker routes cannot write V1 tables |
| **A8** | Rights records, export filter, deletion / revocation propagation with R2 purge, split assignment, dataset export | Revocation removes media, derivatives, access and training eligibility; audit complete; export honours rights |
| **A9** | Evidence clips: implement `handleClip` (frame-accurate cut with pre / post-roll), clip renditions linked to events and results | Clip bounds match the measurement frames exactly |
| **A10** | Evaluation harness, frozen sets, run store, CLI + ops view | Re-running a frozen set reproduces identical numbers; frozen rows immutable |

### V2-B — Behind-home analyst acceleration

| M | Contents | Gate |
|---|---|---|
| **B1** | GPU worker v1 (private repo): decode, deep QA, discovery, in-window actors / pose / ball candidates, event localization, camera-change detection | §10.3 spike thresholds on the held-out set, by camera profile |
| **B2** | Association engine: tolerant monotonic alignment of candidates to scorebook pitches (timecodes are stamped at scorer keypress, so they lag the pitch), identity carry-forward, radar link, conflict reasons | Association accuracy on tagged games; an unresolved identity always produces a reason |
| **B3** | Assisted review: preloaded marks, confidence bands, filmstrips, overlays, split / merge, exception ordering, escalation inbox | One-viewport check at 1366×768; every S10-2 action covered by a test |
| **B4** | Feedback → dataset snapshot → retrain loop; active-learning sampler | A retrain consumes only rights-cleared, non-benchmark labels |
| **B5** | Governance: bundles, shadow mode, limited rollout, rollback, protected-metric thresholds | A regressing bundle is refused; rollback restores the previous bundle in one action |
| **B6** | Monitoring and cost panel, drift alerts, SLA tracking | Cost per game and analyst minutes per game visible per tier |
| **B7** | Release mapping for `time_to_home`; trust labels, unavailable reasons and (if approved) clips on profiles and reports | Acceptance test: job → assisted timing → review → release → profile shows value + label; estimate never displaces radar |
| **B8** | **Rookie acceleration**: ball-in-play / contact candidates feed the running queue as home-to-first proposals (contact frame pre-marked); steal windows from scorebook SB / CS + pitch windows (start pre-positioned at first movement) | Rookie analyst minutes per qualified game trending to < 10 (D-18) |

**Exit:** the brief's pilot thresholds met on held-out qualified video → analyst-reviewed, video-measured timing
released where product policy permits.

### V2-C — Velocity research · internal
`PVV_REC_V1` with explicit drag and uncertainty; radar pairing through the existing `radar_reading_id` on pitch
events; bias / MAE / percentile / coverage by distance, tier, lighting, pitch type and level; results carry
`release_scope = internal_research` and are refused by the adapter. **Exit:** a pre-approved accuracy + coverage
threshold — or a documented "not defensible at this tier".

### V2-D — Batted-ball classification
Contact candidates, `SPRAY_SECTOR_V1`, `BB_TYPE_V1`; proposals pre-fill the scorebook's `direction` /
`batted_ball`; `spray_direction` moves from manual to video-classified + analyst-confirmed. **Exit:** agreement,
confusion-matrix and false-confident thresholds.

### V2-E — Pro Capture batted-ball estimates
Second feed per job (V1 already supports multiple feeds; the unused `manual_offset_s` becomes a measured
`sync_offset` with a residual); sync workflow (audio cross-correlation + shared visual events); lens profiles;
side-view calibration; `PVV_PLATE_V1`, `EV_V1`, `LA_V1`. **Exit:** metric-specific thresholds vs a trusted reference.

### V2-F — Calibrated multi-angle trajectory
Entry criteria only: a validated multi-camera operating procedure and sync residual. 3-D path, location, movement
research, advanced visualisations.

### Sizing (at V1's demonstrated cadence — working sessions with same-day merges)
V1's M1–M6 took roughly two to three weeks. **V2-A is comparable in size: ≈ 3–4 weeks of sessions.** V2-B's
non-model work (B2–B8) is ≈ 3–4 weeks and can overlap the model spike. **Model timelines are gated by labels, not
engineering:** the spike needs ≈ 1,000 labeled pitches to say anything and the brief's several thousand to say it by
camera profile. V2-C onward is estimated after the V2-B gate, as V1 did per phase.

### What can start today without anyone else
A1, A2, A3, A4, A5, A7, A9, A10 need no footage rights, no GPU account and no legal policy. **A5 is the unlock**: the
moment it ships, analysts produce labels and a baseline as a by-product of ordinary timing work.

### Recommended order inside V2-A
| Wave | Milestones | Why this order |
|---|---|---|
| 1 | **A1 → A2 → A5** | Geometry and the trust / reason vocabulary are prerequisites for the recipe; A5 then ships manual time-to-home — labels and the manual baseline start accruing immediately |
| 2 | **A6 · A9 · A3** | Blind double review measures the human ceiling while labels accumulate; clips make evidence real; deep media QA makes every label's timing defensible |
| 3 | **A4 · A7 · A8 · A10** | Calibration, the worker contract with its stub, rights controls and the evaluation harness — everything the model spike needs, finished as the label count reaches ≈ 1,500 |

Owner-side work runs in parallel from day one: counsel on the footage policy (D7), a named owner for the data
program (D8), Pocket Radar at bullpen sessions, and the capture placement guide in operators' hands.

---

## 15. Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| Labeled data arrives slowly | Every model gate waits on it | A5 / A6 first; labels are a by-product of paid work; the plan ships value without models |
| First movement is a judgment, not a physical event | The brief's ≤ 3-frame target may be tighter than two analysts agree with each other (plausibly 2–4 frames from the stretch, 4–8 from the windup) | Measure the ceiling first (A6); express the gate against it (§10.3); publish stretch deliveries only (D3) |
| Reception is hidden from a low camera directly behind home | The catcher's back and the umpire occlude the glove — the endpoint of the first customer metric | Placement rules in the Standard contract (§5.3); glove-visible fraction measured in week one; centre-field view as the alternative |
| Tiny, net-occluded ball from behind home | ≈ 4 px at the mound at 1× framing; release and plate crossing may be infeasible at Standard tier | Reception and first movement do not need the ball; release is range-or-unavailable; velocity stays internal |
| False precision in velocity | The brief's greatest reputational risk | Separate `est_*` keys, `releasable = 0`, uncertainty stored, benchmark gate, claim-language rules |
| Anchoring bias inflates apparent accuracy | Corrected proposals look better than they are | Blind double-reviewed benchmark; `label_origin` on every label |
| Camera bumped mid-game | Silent geometry error | Stability segments, profile expiry, `invalid_geometry` |
| GPU cost or cold-start pain on tournament weekends | Bursty load | Two-stage pipeline, budgets, batch tolerance (hours are fine), fallback host |
| Public repository | Model code, contract and cost models exposed | Private `dm-vision` repo; decide on the main repo (D2) |
| Licensing traps in open source | AGPL-over-network, non-commercial weights, broadcast-footage datasets | §8.2 verdicts; permissive stack only; own data only |
| Legal policy late | Blocks training on customer footage | Conservative defaults; controls built first; internal and consented sessions first |
| Slow full-game proxy on a 1-CPU API | Caps turnaround | Optional: encode the proxy on the GPU worker (NVENC) after re-running the frame-accuracy gate (D11) |
| SQLite growth | 1 GB disk | Rows and summaries only; bulk in R2; Postgres trigger unchanged (TDR §1) |
| Open V1 owner items (alerts webhook, staging, email) | A "monitored limited rollout" needs alerting and a safe place to test | Close before B5 |

---

## 16. Decisions needed from the owner  (recommendations attached)

| # | Decision | Recommendation |
|---|---|---|
| D1 | GPU host and monthly budget ceiling | **Modal on L4**, RunPod Serverless as the tested fallback (§11.3). Expected spend is ≈ $4–40 a month through 1,000 games a year; set a hard ceiling (e.g. $150 / month) with an alert |
| D2 | Private repository for the inference plane, annotation contract and benchmark manifests (the main repo is public) | Create private `dm-vision`; consider taking the main repo private |
| D3 | Time-to-home product rule: which deliveries count, what publishes | Record `delivery_type` on every pitch; publish the **mean of approved stretch deliveries, n ≥ 3**, with best and count as metadata; keep windup internally |
| D4 | Frame-rate floor for assisted timing (brief: "60 preferred"; spec §3: "60 minimum") | **60 fps minimum**; 30 fps footage stays manual or `insufficient_frame_rate` |
| D5 | Evidence clips on customer surfaces — reverses the 2026-08-20 decision | Enable per order via sharing scope + the feed's display right, only after counsel approves the minors policy; default off |
| D6 | Estimates publish to their own keys (`est_*`) and stay out of leaderboards, benchmarks and ratings | Yes — the truth hierarchy holds by construction |
| D7 | Counsel engagement and date for the footage-rights policy | Start now; it is the long pole for training on customer footage |
| D8 | Data program ownership: who labels, hours per week, number of games and radar sessions | Name an owner; budget labeling inside analyst time via A5 |
| D9 | Keep `frame_timed` as the stored value and display "Video measured", or migrate the value | Keep stored, map at the edge (no data migration, no test churn) |
| D10 | Stay on SQLite for V2 | Yes; V2 adds no second writer |
| D11 | Move proxy encoding to the GPU worker for turnaround | Yes in V2-B, behind the frame-accuracy gate |
| D12 | Customer accuracy statement for estimates (label only, or label + benchmark-derived "typically within ± x") | Label only until a benchmark supports a number |

---

## 17. Answers to the brief

### 17.1 The six questions for the technical founder

| # | Question | Answer |
|---|---|---|
| 1 | Which first event targets are realistically localizable to the requested frame error, and which should be deferred? | **Pursue now:** pitch-window discovery (feasible today), **catcher reception** where the glove is visible (a crisp physical event — comparable events reach ≈ 97 % within ± 35 ms with enough labels), and **first movement** — with the caveat that ≤ 3 frames is aggressive because the event is a human judgment; judge it against the measured analyst ceiling and publish stretch deliveries only. **Bat contact** is easy with audio as a proposer. **Defer / constrain:** release from behind home (resolution-limited: range or unavailable, never an input to a Standard-tier customer number), plate crossing (not observable along the camera's depth axis — calibrated side view only), and everything that needs the ball's 3-D path. §0.3 |
| 2 | What data volume, label taxonomy, annotation tooling and evaluation split are needed before training is meaningful? | **Volume:** 1,500–3,000 labelled pitches from 12–20 games across ≥ 8 fields and ≥ 5 cameras for a first read; the brief's 40–80 games for a by-profile answer. **Taxonomy:** five event marks with visibility class, ambiguity and unavailable reasons, `reception_kind`, `delivery_type`, and nine negative classes (§3.5–3.6, §4). **Tooling:** the Pitch Timeline itself in manual and blind label modes — same player, same frame index, rights-aware — plus a click-the-ball mode for spatial labels. **Split:** by game **and** field / camera group, assigned at ingestion; a blind, double-reviewed benchmark frozen and excluded from all training. §9 |
| 3 | Which model families and media components first, and what is safe to reuse from open source? | **First:** signal baselines (fixed ROIs, pose, motion energy, audio) — they may already clear the gates. **Then:** E2E-Spot (BSD-3) on native-resolution crops; RF-DETR N–L (Apache-2.0) for actors; WASB / TrackNetV3 code (MIT) retrained on our footage for the ball. **Not reusable:** BaseballCV (AGPL-or-commercial since 2025, YOLO-based weights, MLB-broadcast datasets), anything Ultralytics (AGPL, SaaS needs an enterprise license), any broadcast-footage dataset. Media: FFmpeg / NVDEC decode on the worker; the existing CFR proxy and R2 on our side. §8.2 |
| 4 | What GPU, storage, proxy and inference architecture keeps per-game cost viable while preserving reproducibility and audit evidence? | A **stateless L4 worker on Modal** (RunPod as fallback) that pulls jobs over HTTPS with a machine token, reads and writes R2 through presigned URLs only, and never touches the database — ≈ **$0.45 per Standard game**, ≈ $0.97 Pro. Reproducibility: every run pins the proxy rendition, the model bundle (weights hashes + container digest), the contract version and a params hash; models run on the *same* CFR proxy analysts review, with a persisted source↔proxy timestamp map. Audit: rows and summaries in SQLite, per-frame evidence in R2, all cited artifacts exempt from expiry. §2, §8.4, §11.3 |
| 5 | How should the system represent uncertainty, model version, camera profile and analyst override in the V1 event and metric schema? | **Uncertainty:** per-mark `confidence` + top-k `hypotheses` (a distribution, not one answer), approved *ranges* where a single frame is indefensible, and an `uncertainty` object on each result. **Model version:** `model_bundle_id` on runs, candidates, marks, tracks, measurements and results. **Camera profile:** versioned `cmd_camera_profiles` with an active frame range, stamped on measurements and results; expiry blocks geometry recipes. **Analyst override:** proposed vs approved frame and `delta_frames` on the mark, an immutable `cmd_model_feedback` row, and the existing `cmd_review_actions` audit. All additive — no V1 column changes meaning. §3 |
| 6 | What is the shortest spike that decisively answers feasibility? | Two to four weeks, one engineer, after the manual workflow has produced ≈ 1,500 labels: measure the annotator ceiling and the glove-visible fraction (week one — these two numbers decide most of it), run signal baselines, challenge them with E2E-Spot only where they miss, probe ball tracking, and fit velocity from *human* labels against radar. Go / no-go table in §10.3. The review demo is not extra work — it is the Pitch Timeline in assisted mode, fed by the stub worker's contract. |

### 17.2 The "recommended immediate ask" checklist
| Requested in the feasibility design | Where |
|---|---|
| Precise target definition | §4 (contract draft) |
| Data and labeling plan | §9 |
| Proposed media and inference stack | §2, §8 |
| Baseline model experiments | §10.3 |
| Licensing and rights review | §8.2, §13 |
| Held-out evaluation protocol | §10 |
| Cost per processed game | §11.3 |
| Go / no-go for Phase 1 | §0.4 |

### 17.3 Spec §15 deliverables
Feasibility by metric and tier → §0.3 · architecture for GPU, proxying, serving, provenance, monitoring, cost → §2,
§8, §11 · baseline model plan with license review → §8.2 · data collection and labeling plan → §9 · proof-of-concept
plan with gates, failure modes, risks, budget → §10.3, §15, §11.3 · velocity endpoint and claim-language
recommendation → §6.3.

---

## 18. Requirements traceability

Status legend: **V1** = already satisfied by existing code · **Ext** = extends an existing V1 mechanism · **New**.

### 18.1 Founder brief

| ID | Requirement | How this plan satisfies it | Status | Milestone |
|---|---|---|---|---|
| B-1 | Narrow first outcome: cut analyst time finding first movement, release, plate arrival, reception, contact | Candidates + preloaded marks on the Pitch Timeline | New | A5, B1, B3 |
| B-2 | Auditable candidate frames and an approved time-to-home | `cmd_candidate_marks` → named marks on `cmd_measurements` → `TTH_V1` | Ext | A5 |
| B-3 | Never independently publish, call the zone, or claim calibrated ball flight | Proposal-layer isolation (§2.1); no zone feature; trust labels; `releasable` flag | New | A2, A7 |
| B-4 | Pitch windows with start / end timecodes linked to inning, batter, pitcher, scorebook when available | Candidate windows + association engine | New | A7, B1, B2 |
| B-5 | Never silently create a counted pitch or public result | `pitch_timing` sits outside `loadEvents()`'s whitelist; the worker cannot write V1 tables; tests | New | A5, A7 |
| B-6 | First movement proposed; accept / adjust / reject; confidence and method persist | Marks table keeps proposal, decision, delta, confidence, bundle | New | A5, B1, B3 |
| B-7 | Release proposed on eligible footage only; unavailable if occluded | View / fps gate; range or `ball_not_visible` | New | B1, B3 |
| B-8 | Reception and, where applicable, contact; event type and frame evidence retained | `mark_type`, `reception_kind`, filmstrip + clip | New | A5, A9, B1 |
| B-9 | No strike zone and no velocity in the first release | No zone feature; velocity `releasable = 0` | New | A2 |
| B-10 | Time to home from approved frames and verified CFR FPS; show formula, frames, source, confidence, status | `TTH_V1` + timing map + on-screen formula bar | Ext | A3, A5 |
| B-11 | Pitch clips, review queues, hotkeys, exception lists | Evidence clips, Pitch Timeline, exception-first ordering | New | A9, B3 |
| B-12 | Human review remains the publication authority | `decideResult`, role gates, release adapter | **V1** | — |
| B-13 | Consistent definitions; exact evidence frames preserved | Annotation contract + marks + audit | New | A5, A6 |
| B-14 | Verified timing and clips before the box score | Independent metric release track | **V1** | B7 |
| B-15 | Bad footage, low confidence, occlusion, disagreement routed to an exception queue | QA reasons + confidence + hypothesis disagreement → ordering | New | A3, B3 |
| B-16 | Every acceptance, correction, rejection, unavailable reason becomes training / evaluation data | `cmd_model_feedback` (from manual mode onward) | New | A5, B4 |
| B-17 | Pipeline starts only after upload; not in-game | Run queued on proxy ready; no live hooks | New | A7 |
| B-18 | Scope: core / later / explicitly not promised | Phase map (§14) + enforcement list (18.4) | — | — |
| B-19 | Standardized capture; Pro side later; multi-camera only after calibration and ops are proven; no hardware dependence | Tier ladder (§5) | Ext | A3, A4, E, F |
| B-20 | Ingest and qualify: codec, dimensions, CFR / VFR, FPS, view profile, visibility; reject or downgrade; analyst confirms profile; saved QA record + eligibility reason | `cmd_media_qa`, L1 + deep QA, capture-profile confirmation | Ext | A3, A4 |
| B-21 | Discover, score, associate; analyst resolves gaps, duplicates, ambiguous windows; saved candidate record | Candidates, manual add, merge, split | New | A7, B1–B3 |
| B-22 | Localize five events; accept / adjust / reject / unavailable; saved annotations and clip | Marks + clips | New | A5, A9, B1 |
| B-23 | Compute timing from verified FPS and approved frames; review result and evidence; saved measurement with formula and confidence | Recipe → draft result with `inputs`, `uncertainty` | Ext | A5 |
| B-24 | Expose only approved data through the existing release path; approve or withhold; audit + profile rollup | V1 adapter + `DM_RELEASE_V2` mapping | Ext | B7 |
| B-25 | One written annotation contract with a frame decision rule per target; observable vs inferred | §4 draft → `docs/ANNOTATION_CONTRACT.md`, versioned on every label | New | A6 |
| B-26…31 | The six definitions with camera quality and unavailable conditions | §4 + `CAPTURE_SPECS` + recipes | New | A5, A6 |
| B-32 | Strictness about defensibility is a product requirement | Hard gates with audited override only | Ext | A3 |
| B-33 | Standard V2 tier contract and permitted outputs | §5.1 | Ext | A3, A4 |
| B-34 | Pro Capture tier | §5.1 | New | E |
| B-35 | Ineligible → clip linkage and manual scorebook only; no automated timing | L1 gate: no run queued; reasons recorded | New | A3 |
| B-36 | 40–80 rights-cleared representative games | §9.1 + rights records | Owner + New | A8 |
| B-37 | Several thousand frame-level labels; smaller release / contact subset | Manual and label modes | New | A5, A6 |
| B-38 | Deliberate negative and failure examples | `reject_class` taxonomy; negatives in label mode | New | A6, B3 |
| B-39 | Export / read access to V1 schema, results, evidence, review status, media metadata | Dataset export | New | A8 |
| B-40 | Reference measurements; held-out double-reviewed benchmark with documented disagreement | V1 radar link + blind double review + frozen sets | Ext | A6, A10, C |
| B-41 | Capture metadata on every feed | Capture-log columns, required at upload | New | A1 |
| B-42 | Modular: models improve without rewriting Command or changing event / release contracts | Versioned worker contract; bundles | New | A7 |
| B-43 | Probe; CFR proxy retaining provenance; thumbnails; time-indexed clips; never an assumed FPS; persist original timing and proxy mapping | Timing map, true-CFR test, clips | Ext | A3, A9 |
| B-44 | Classify eligibility, identify camera archetype, route to a model or manual; hard-block invalid precision claims; preserve reason and override audit | QA + camera profile + bundle routing + V1 overrides | Ext | A3, A4, B5 |
| B-45 | Detect pitcher, catcher, batter, ball when visible; segment windows; high recall first | Worker stages 1–2 | New | B1 |
| B-46 | Temporal models, pose / object cues, tracking; return a distribution, not one unqualified answer | `hypotheses` top-k per mark | New | B1 |
| B-47 | Link to scorebook pitch / play, identities, radar reading, clip evidence; V1 event id authoritative | Association engine; `linked_event_id`; child of the V1 pitch | New | B2 |
| B-48 | Preload clips, suggested markers, side-by-side frame stepping, hotkeys, one-click accept, correction and unavailable reasons; review action feeds a labeled correction record | §7.1 (filmstrip + dual frame) | New | B3 |
| B-49 | Recall, frame error, false positives, coverage, override rate, latency by camera profile; no rollout without held-out evaluation and drift monitoring | §10, §11 | New | A10, B5, B6 |
| B-50 | License review; own the definitions, rights, evaluation, workflow and data product | §8.2; private repo; own data only | New | A7, B1 |
| B-51 | Comparable positioning: what not to claim | Claim-language rules in `trustPolicy.js` and customer copy | New | A2, B7 |
| B-52 | ≥ 95 % pitch-window recall with a manageable queue | §10.1 definition + gate | New | B1 |
| B-53 | First movement median ≤ 3 frames at 60 fps | §10.2 | New | B1 |
| B-54 | Reception median ≤ 3 frames at 60 fps | §10.2 | New | B1 |
| B-55 | ≥ 40 % faster per reviewed eligible pitch vs the V1 manual baseline, agreement not lower | Work-session timing; manual baseline measured in A5 | New | A5, B3 |
| B-56 | Human agreement threshold set during calibration; disputes retained | Blind double review, agreement report | New | A6 |
| B-57 | 100 % of ineligible / low-confidence cases carry an explicit reason | Coverage query must return zero unexplained | New | A3, B6 |
| B-58 | Judged on a held-out set, segmented by camera profile | Strata on frozen sets | New | A10 |
| B-59 | Phased roadmap 0–4 | §14 mapping | — | — |
| B-60 | Six questions for the technical founder | §17.1 | — | — |
| B-61 | Feasibility design contents | §17.2 | — | — |

### 18.2 Dream-state capability map

| ID | Requirement | How this plan satisfies it | Status | Milestone |
|---|---|---|---|---|
| D-1 | Nine capabilities (velocity, path / movement, timing, exit velocity, launch angle, spray, batted-ball outcome, fielding / throws, baserunning) | Registry rows exist or are added; extensible `candidate_type` and `mark_type`; phase map | Ext | B → F |
| D-2 | Annotated game timeline with a clip per meaningful event; analyst reviews only low-confidence or high-value moments; profiles update with approved results, source method and links to video | Pitch Timeline, exception-first ordering, §12 | New | B3, B7 |
| D-3 | Five trust labels controlling display **and** eligibility for benchmarks, averages, leaderboards, recruiting outputs | `trustPolicy.js` consumed by adapter, aggregates, ratings, profile | New | A2, B7 |
| D-4 | Camera and calibration ladder: what each level unlocks and does not justify | §5.1 + `min_tier` per recipe | Ext | A3, A4 |
| D-5 | Canonical event model retaining raw timestamp, feed, camera profile, model version, candidate track, clip, analyst action, confidence, result status | §3.5–3.8 | Ext | A5, A7 |
| D-6 | A camera-profile and calibration service that enforces the recipe a tier allows | `cmd_camera_profiles` + recipe gate | New | A4 |
| D-7 | Labeled data and active-learning program; failures reviewed by camera profile, age group, lighting, compression, field geometry | §9.4 | New | B4 |
| D-8 | Benchmarks pairing qualified video with Pocket Radar and double-reviewed labels; thresholds set on held-out data | §9, §10 | Ext | A10, C |
| D-9 | Observability: coverage, confidence distribution, frame error, speed-up, false-positive rate, override rate, cost per game | §11.1 | Ext | B6 |
| D-10 | Secure inference workflow: repeatable proxies, GPU orchestration, storage lifecycle, retraining / rollback, governed approval | §2, §8.4, §10.4 | New | A7, B1, B5 |
| D-11 | Reporting separates trusted values from estimates; open the exact clip and overlay behind a result | §12, §7.4 | New | B7 |
| D-12 | Sequence by measurement observability | Phase order A→F | — | — |
| D-13 | During filming: capture only; optional operator notes retained with the feed | `recording_notes` (V1); no live requirement | **V1** | — |
| D-14 | After upload: no immediate public output; jobs may stay in processing and review | Run and candidate statuses | New | A7 |
| D-15 | Analyst never rediscovers every pitch when a reliable candidate exists | Preloaded queue | New | B3 |
| D-16 | No provisional or unreviewed live value is published | V1 gates | **V1** | — |
| D-17 | Recommend realistic service levels by package and tier | §11.2 | New | B6 |
| D-18 | Rookie: < 10 analyst minutes per qualified game after processing | B8 + work-session timing | New | B8 |
| D-19 | Advanced package: ≈ 90 → ≈ 30 minutes on qualified Pro Capture | V2-D / V2-E + timing | New | D, E |
| D-20 | V1 authoritative for identity, scorebook, approval, validity, rollups, reports, visibility, both releases; V2 never bypasses or overwrites | §2.1 isolation rules, each pinned by a test | New | A7 |
| D-21 | Measured by analyst minutes per eligible game, turnaround, coverage, error / override rate, cost per game | §11.1 | Ext | B6 |

### 18.3 Technical Build Specification

| ID | Requirement | How this plan satisfies it | Status | Milestone |
|---|---|---|---|---|
| S1-1 | Runs after footage upload; no live operation | Trigger on proxy ready | New | A7 |
| S1-2 | Automates discovery, tracking and frame proposals, calculations, confidence, evidence packaging, exception routing | §8.1 | New | B1 |
| S1-3 | A trained analyst makes the final call | V1 review + release | **V1** | — |
| S1-4 | Customer receives a trust-labelled, evidence-backed result | §12 | New | B7 |
| S1-5 | Traceable to feed, camera profile, model version, frames, recipe, confidence, analyst action, audit | Result extension columns | Ext | A2, A5 |
| S2-1 | Game created with division, verified pitching distance, date, teams, intended tier | Job geometry | New | A1 |
| S2-2 | Probe codec, FPS, resolution, VFR, audio / timebase, duration, suitability; preserve original; CFR proxy with exact timestamp mapping | Media QA v2 + timing map | Ext | A3 |
| S2-3 | Assign camera profile; request / record landmarks; detect moved camera or zoom; calibration-quality score | Calibration tool + stability detection | New | A4, B1 |
| S2-4 | GPU job: high-recall candidates, then short-window models only where useful | Two-stage worker | New | B1 |
| S2-5 | Queue items carry proposed frames, overlay / clip, confidence, suggested metric, structured ineligibility reason | §7.1 | New | B3 |
| S2-6 | Accept, correct, split, merge, reject, unavailable; feedback stored as labeled data | §7.1 + `cmd_model_feedback` | New | B3, B4 |
| S2-7 | Recipe computes the approved result; metric and game-record tracks independent | Recipes + V1 tracks | Ext | A5, B7 |
| S3-1…3 | Three tiers with required capture, uses and permitted output language | §5.1; label language in `trustPolicy.js` | Ext | A3, A4 |
| S3-4 | Never silently use a poor feed for a higher-tier metric; route to review or unavailable with a reason | Tier checked at compute and at release | Ext | A3 |
| S4-1 | First movement; reviewer can move the marker and select an ambiguity reason | `ambiguity_reason` | New | A5 |
| S4-2 | Release; use a range or mark unavailable | `approved_lo / hi` | New | A5 |
| S4-3 | Plate crossing only when the plane is calibrated | `plate_plane_supported` | New | A4, E |
| S4-4 | Reception must distinguish caught from missed / blocked | `reception_kind` (mandatory) | New | A5 |
| S4-5 | Contact: system may propose, analyst decides or marks unknown | `decision = unknown` | New | A5, D |
| S4-6 | Ball-in-play direction: broad sector before precise coordinates | `SPRAY_SECTOR_V1` | New | D |
| S5-1 | Spike inputs: qualified behind-home footage, job distance, camera profile, optional scorebook hints | Claim payload | New | A7, B1 |
| S5-2 | Spike outputs: windows; actor and ball proposals; five mark candidates; confidence and reason codes | Worker contract v1 | New | B1 |
| S5-3 | Frame-step workspace with original / proxy linkage, markers, overlay / tracks, confidence, one-click path, saved clip | §7.1, timing map, clips | New | B3, A9 |
| S5-4 | Out of scope for the spike | Registry `active` / `releasable` flags | — | — |
| S5-5 | Success: high recall, markers close enough to correct quickly, every action becomes data; a confidently wrong unreviewed public metric is unacceptable | Gates + isolation | New | B1 |
| S6-1 | Versioned recipe per metric preserving method, endpoints, geometry, source, uncertainty, verification state | `server/recipes/*` + result columns | New | A2, A5 |
| S6-2 | Time to home: end is explicitly reception or calibrated plate crossing; the recipe stores which | `end_mark` | New | A5 |
| S6-3 | Velocity stores frames, FPS, calibrated distance, endpoint definition, uncertainty, tier, versions; never 60 ft 6 in | `inputs` JSON + job geometry | New | A1, C |
| S6-4 | Velocity internal until benchmarked; public language stays "video-estimated" | `release_scope`, `releasable` | New | A2, C |
| S6-5 | Hit direction: sector first; precise XY only after geometry validation | `SPRAY_SECTOR_V1` | New | D |
| S6-6 | Batted-ball type with an unknown path and analyst confirmation | `BB_TYPE_V1` → V1 `batted_ball` | Ext | D |
| S6-7 | Exit velocity, launch angle, movement in later phases with their constraints | `EV_V1`, `LA_V1`, `MOVE_V1` | New | E, F |
| S6-8 | Truth hierarchy; a later source never overwrites a stronger one without audit and an explicit rule | Separate `est_*` keys + `source_priority` + adapter test | New | A2 |
| S7-1 | Job setup must require or verify the pitching distance | Job geometry, verified flag | New | A1 |
| S7-2 | Release-to-plate and release-to-reception never share an ambiguous label | Two recipe ids + `endpoint_definition` | New | C |
| S7-3 | Pair the same pitch with video and a reference; bias, MAE, percentiles, coverage across conditions | V1 radar link + §10.1 | Ext | C |
| S7-4 | Velocity candidates are internal research signals until accepted | `internal_research` | New | C |
| S8-1…8 | Eight pipeline stages with non-negotiable outputs | §8.1 table | New | A3–B7 |
| S9-1 | Landmarks detected or clicked; known geometry for the configured field | Calibration tool | New | A4 |
| S9-2 | Optional intrinsics per device / lens; model distortion where material | `cmd_lens_profiles` | New | E |
| S9-3 | Camera state stored; change detection throughout the game; a pan, zoom or bump invalidates geometry | `camera_state`, stability segments, profile expiry | New | A4, B1 |
| S9-4 | CFR proxy; exact original timestamps; flag VFR or missing frames | §2.3 | Ext | A3 |
| S9-5 | Eligibility score from landmark visibility, blur, occlusion, stability, FPS / resolution, residual | `cmd_media_qa.score` + `quality_score` | New | A3, A4 |
| S9-6 | Analyst can verify and correct calibration; it expires when the camera changes | Verify / expire actions | New | A4 |
| S10-1 | Player, queue, timing controls, overlays, metric proposal, clip and controls visible together | One-viewport layout | New | B3 |
| S10-2 | Accept; adjust; replace / split / merge; invalid / unavailable; structured reason; note; escalate | §7.1 | New | B3 |
| S10-3 | Eleven first-class unavailable reasons | §6.5 | Ext | A2 |
| S10-4 | Invalid / unavailable removed from rollups and profiles until replaced; no zero; no contribution to average or count | V1 invariant extended to the new rollups, with tests | Ext | A2, B7 |
| S10-5 | Evidence includes feed, frame range, overlay state, analyst edits, recipe / model / calibration versions, release decision | `evidence_refs` + audit | Ext | A2, A9 |
| S11-1 | `camera_profiles` | §3.3 | New | A4 |
| S11-2 | `automation_candidates` | §3.5 | New | A7 |
| S11-3 | `ball_tracks` | §3.7 | New | B1 |
| S11-4 | `metric_results` extension | §3.8 | Ext | A2 |
| S11-5 | `model_feedback` | §3.9 | New | A5 |
| S11-6 | `evaluation_runs` | §3.10 | New | A10 |
| S12-1 | Rights-cleared games and controlled clips across conditions; split by game / camera | §9.1, §9.2 | Owner + New | A8 |
| S12-2 | Capture log per feed | §3.1 | New | A1 |
| S12-3 | Annotation guide and double-review sample set | §4, §9.3 | New | A6 |
| S12-4 | Reference data on selected sessions | Radar sessions, §9.1 | Owner + Ext | C |
| S12-5 | Consent, rights and retention rules | §13 | New | A8 |
| S13-1…6 | Six evaluation gates | §10.2 | New | A10 → E |
| S13-7 | Frozen and repeatable; no evaluation on training games or cameras; tracked by age, tier, orientation, light, blur, calibration quality | §9.2, §10.1 | New | A10 |
| S14 | Phases V2-A…F with release stance | §14 | — | — |
| S15-1…6 | Six founder deliverables | §17.3 | — | — |
| S16 | Intended uses for analyst, pitcher, hitter, coach, operations | Pitch Timeline · profile + clips · reports with unavailable reasons · ops panel | New | B3, B6, B7 |
| S17 | Do not copy, scrape or reverse engineer; differentiate on trusted postgame operations | Own footage only; provenance on every dataset snapshot | New | A8 |
| S19-1 | No internal uncertainty, calibration, queues, notes or QA controls on customer surfaces | Server-side allowlist | New | B7 |
| S19-2 | Approved performance clips | §12, consent-gated | New | B7 |
| S19-3 | Velocity source always identified; an estimate never shown as radar | Labels + separate keys | New | B7 |
| S19-4 | Unavailable metrics shown with a plain-language reason | Customer reason map | New | A2, B7 |
| S19-5 | Internal detail stays staff-only; V1 approval and release govern | `requireInternal` | **V1** | — |
| S20-1 | Counsel-approved policy implemented as enforceable controls | §13 | Owner + New | A8 |
| S20-2 | Per-feed record: uploader, permitted use, status, retention deadline, restrictions | `cmd_feed_rights` | New | A8 |
| S20-3 | Nothing enters a training set unless rights permit | Export filter, fail closed | New | A8 |
| S20-4 | Deletion / revocation propagates to media, derivatives, access, training eligibility, with audit | `cmd_deletion_requests` + purge | New | A8 |
| S21-1 | Frozen representative benchmark; no shared games or cameras | §10.4 | New | A10 |
| S21-2 | Candidate evaluated against production on eight measures | `cmd_eval_runs.vs_bundle_id` | New | B5 |
| S21-3 | Approved threshold per metric and tier; protected-metric tolerance | Thresholds + verdicts | New | B5 |
| S21-4 | Monitored limited rollout with a QA sample; versions, owner, date, evidence recorded | Bundle lifecycle | New | B5 |
| S21-5 | Previous model and recipe kept for immediate rollback; released results keep provenance; remediation follows V1 validity and audit rules | Pointer-flip rollback + withdraw / revive | Ext | B5 |

### 18.4 Non-goals — and what enforces each  (S18)

| ID | Non-goal | Enforcement |
|---|---|---|
| S18-1 | No live tracking, production, alerts or operation during filming | Runs queue only after upload and proxy; nothing subscribes to Field Live streams |
| S18-2 | No claim that an ordinary behind-home 30 fps feed yields radar-equivalent velocity, exit velocity, launch angle or movement | `min_tier` / `min_fps` per recipe; those recipes cannot compute on such a feed |
| S18-3 | No automatic public publishing without analyst approval and a passed metric gate | V1 review gates + `releasable` + `release_scope` |
| S18-4 | No hard-coded professional geometry | Verified job geometry is a required recipe input; no default exists |
| S18-5 | No deletion of audit-necessary source or evidence before policy allows | Retention rules; cited artifacts exempt from the 180-day expiry |
| S18-6 | No dependency on sensors, instrumented equipment, installed cameras or a customer hardware purchase | Pocket Radar is a *reference*, never a prerequisite for the core experience |

---

## Appendix — file-level change list (V2-A / V2-B)

**New (server):** `trustPolicy.js` · `unavailableReasons.js` · `mediaQa.js` · `calibration.js` · `recipes/timeToHome.js`
(+ later `recipes/*`) · `automationLogic.js` · `automationRoutes.js` · `automationWorkerRoutes.js` · `association.js` ·
`rights.js` · `evalHarness.js` · `datasetExport.js` — each pure where possible, each with a `*.test.js`.
**Changed (server):** `db.js` (tables / columns) · `commandLogic.js` (registry, presets) · `captureSpec.js` (tiers,
views, geometry) · `measurementLogic.js` (recipe-driven marks) · `metricRelease.js` + `releaseLogic.js` (V2 rollups,
`releasable`, tier re-check) · `mediaWorker.js` (`handleClip`, QA job kinds) · `metricCatalog.js` (`time_to_home`,
`est_*`) · `aggregates.js` / `ratingEngine.js` (trust-policy filter) · `index.js` (profile allowlist, mounts) ·
`telemetry.js`, `commandOpsRoutes.js` · `playerDelete.js` · `backup.js`.
**New (web):** `PitchTimelinePage.jsx` · `CalibrationPanel.jsx` · `Filmstrip.jsx` · `OverlayCanvas.jsx` ·
`AutomationOpsPanel.jsx`. **Changed (web):** `FeedPlayer.jsx` (overlay, window bands, loop) · `CommandPages.jsx`
(module tile, geometry, rights) · `ReviewPage.jsx` · `OpsPage.jsx` · `PublicProfilePage.jsx` · `App.jsx` · `lib/api.js`.
**New repository (private):** `dm-vision` — worker, pipeline stages, model adapters, training, evaluation CLI.
**Docs:** `docs/ANNOTATION_CONTRACT.md` · `docs/COMMAND_OPS.md` (automation runbook) · `docs/COMMAND_TDR.md` (decision log).
