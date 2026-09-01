# Diamond Metrics Command — Operations Runbook

Companion to `docs/COMMAND_TDR.md` (decisions) — this file is how the
service is actually run: environments, configuration, backups and restore,
monitoring, and the known topology constraints.

---

## 1. Services

| Service | What it is | Notes |
|---|---|---|
| Web (Vercel) | React SPA, auto-deploys from `main` | No server state |
| API (Render, `srv-d98hqrq8qa3s73fhohag`) | Express + SQLite on a 1 GB persistent disk at `/var/data` | Owns the database **and** runs the media worker inline |
| Media storage | Cloudflare R2 (prod) / local disk (dev) | Selected by `DM_STORAGE` |

### Topology constraint: the dedicated media worker

`server/worker.js` exists and works, but **it cannot run as a second Render
service today**. A Render persistent disk attaches to exactly one service,
so a background worker cannot open the same SQLite file as the API.

Supported options, in order of when they apply:

1. **Now (pilot):** inline worker inside the API service — the default.
   Media jobs poll every 3 s; WAL handles the single writer comfortably at
   pilot volume.
2. **If transcoding starts starving request latency:** move the API to a
   larger Render instance first. Proxy generation is CPU-bound and bursty;
   a bigger instance is cheaper and simpler than splitting services.
3. **At real scale:** migrate to Postgres (trigger and plan in TDR §1),
   then run `node server/worker.js` as its own Render background worker
   with `DM_INLINE_WORKER=0` on the API.

Do not deploy a separate worker service against SQLite — it will read a
different disk and silently process nothing.

---

## 2. Configuration

Every variable is optional unless marked required; defaults are the dev
experience, so a bare checkout runs with no configuration at all.

### Core
| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | Injected by Render |
| `DM_DB_PATH` | `server/data/diamond-metrics.db` | SQLite location (`/var/data/...` in prod) |
| `DM_ENV` | `development` / `production` from `NODE_ENV` | Labels logs, Sentry events, and backup keys |

### Media storage
| Variable | Default | Purpose |
|---|---|---|
| `DM_STORAGE` | `local` | Set to `r2` for Cloudflare R2 |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | — | **Required when `DM_STORAGE=r2`** |
| `DM_MEDIA_DIR` | `<db dir>/media` | Local backend root |
| `DM_MEDIA_SECRET` | random per boot | Signs short-TTL playback URLs; set it in prod so links survive restarts |
| `FFMPEG_PATH`, `FFPROBE_PATH` | `/opt/homebrew/bin/*` | Set to `ffmpeg`/`ffprobe` on Render |
| `DM_INLINE_WORKER` | on | `0` disables the inline worker (only with a real dedicated worker) |
| `DM_PROXY_MAX_HEIGHT` | `1080` | Review-proxy height ceiling. Sources below it are never upscaled. |
| `DM_PROXY_MAX_FPS` | none (native) | Optional proxy frame-rate ceiling, applied by exact halving so frame mapping stays integral. Set it (e.g. `60`) if full-game encodes at native high frame rates cost more wall-clock than the precision is worth. |
| `DM_TRANSCODE_MEMORY_MB` | auto-detected | Transcode memory ceiling. Detected from the container limit, so upgrading the instance lifts it automatically; set only to pin or deliberately lower it. Below 2048, sources above 1080p are refused with an actionable error rather than OOM-killing the service. |

### Backups
| Variable | Default | Purpose |
|---|---|---|
| `DM_BACKUPS` | on | `0` disables the scheduler |
| `DM_BACKUP_RETENTION_DAYS` | `30` | Snapshots older than this prune — except the newest, which is never pruned |

### Observability
| Variable | Default | Purpose |
|---|---|---|
| `SENTRY_DSN` | — | Enables error forwarding (no SDK dependency; posts to Sentry's store endpoint) |
| `DM_RELEASE` / `RENDER_GIT_COMMIT` | `dev` | Release tag on Sentry events |
| `DM_LOG_SILENT` | — | `1` silences logs (tests) |

### Customer email
| Variable | Default | Purpose |
|---|---|---|
| `RESEND_API_KEY` | — | Activates transactional email; without it events are recorded in-app only |
| `DM_EMAIL_FROM` | — | Verified sender address |

---

## 3. Setting up Cloudflare R2

Until this is done the API **refuses footage uploads** in production, by
design: the local fallback writes to the same 1 GB disk as the database, and
one real game file would fill it and take the public API down.

### 3.1 Create the bucket
Cloudflare dashboard → **R2** → *Create bucket* (R2 requires a payment method
on file even inside the free tier). Name it `diamond-metrics-media`.
Location: **Automatic**, or a North America hint.

Copy the **Account ID** from the R2 overview sidebar → this is `R2_ACCOUNT_ID`.

### 3.2 Create the API token
R2 → **Manage R2 API Tokens** → *Create API Token*.

- Permission: **Object Read & Write**
- Scope: **this bucket only** (not all buckets)
- TTL: no expiry, or a date you will actually remember to rotate

Cloudflare shows an **Access Key ID** and a **Secret Access Key**. The secret
is displayed **once** — paste both straight into Render (§3.5); do not put
them in a file, a ticket, or a chat message.

### 3.3 CORS — the step that silently breaks uploads

The browser uploads parts **directly to R2** with presigned PUTs, and the
client reads each part's `ETag` response header to complete the multipart
upload. Cross-origin responses hide every header unless the bucket exposes
it, so **without `ExposeHeaders: ETag` uploads appear to work and then fail
at the final assembly step** with an invalid-part error.

Bucket → **Settings** → *CORS Policy* → paste:

```json
[
  {
    "AllowedOrigins": [
      "https://diamondmetrics.ai",
      "https://www.diamondmetrics.ai",
      "http://localhost:5173"
    ],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["content-type", "content-length"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Add any Vercel preview domain you upload from. `localhost` is only needed if
you point local dev at the real bucket.

### 3.4 Lifecycle rules (the approved retention policy)

Bucket → **Settings** → *Object lifecycle rules*:

| Prefix | Rule | Why |
|---|---|---|
| `originals/` | Transition to **Infrequent Access** after 30 days | Originals are rarely re-read after analysis |
| `originals/` | Delete after **730 days** (24 months) | Approved retention window |

Leave `proxies/`, `thumbnails/`, and `command/backups/` on standard storage —
proxies are read during every review, and backups are the recovery path.

### 3.5 Set the variables in Render

Render dashboard → the API service → **Environment**. Add all five together,
then deploy:

```
DM_STORAGE=r2
R2_ACCOUNT_ID=<account id>
R2_ACCESS_KEY_ID=<access key id>
R2_SECRET_ACCESS_KEY=<secret access key>
R2_BUCKET=diamond-metrics-media
```

Also set `DM_MEDIA_SECRET` to any long random string, so playback links keep
working across restarts.

A partial configuration will not crash the service — the API boots, logs
`storage_misconfigured`, names the missing variables on `/command/ops`, and
refuses uploads until they are set.

### 3.6 Verify before uploading anything real

`/command/ops` → Service health → **Storage round-trip → Test now** (admin).
This writes a small object, reads it back, compares it, and deletes it —
proving credentials, bucket name, and permissions in about a second instead
of discovering a problem partway through a 12 GB upload.

Then upload one short real clip end to end before trusting a full game.

### 3.7 Video processing (ffmpeg)

Render's Node runtime has no system ffmpeg, so the binaries ship as
dependencies: `@ffmpeg-installer/ffmpeg` and `@ffprobe-installer/ffprobe`.
Each publishes a per-platform binary as an optional dependency, so `npm ci`
installs the correct one for the build machine with **no download step** —
nothing extra to configure, and no build-time fetch that can fail.

Resolution order at runtime:

1. `FFMPEG_PATH` / `FFPROBE_PATH` — honoured **only** if set to an absolute
   path that exists. A bare name like `ffmpeg` is deliberately ignored so a
   stale override cannot shadow the working bundled binary.
2. The bundled package binary (this is what production uses).
3. Whatever is on `PATH`.

**Do not set `FFMPEG_PATH`/`FFPROBE_PATH` in Render.** If they are already
set there from an earlier configuration, remove them — the resolver ignores
bare names, but leaving them is confusing.

Verify on `/command/ops` → Service health → **Video processing**, which
reports the resolved binary's version, or `unavailable` with the reason.

**Equivalence check.** The bundled build is ffmpeg 4.4, older than a typical
local Homebrew install. Regenerating the frame-accuracy gate clip's proxy
with it produced output that is **bit-identical frame-for-frame** to the
proxy the original gate validated (600/600 frames matching by `framemd5`),
at the same 1280×720 / 60 fps CFR, with a worst-case timestamp deviation of
0.00002 frames from a perfect 60 fps grid. Frame math is unaffected.

**Capacity, which is the real constraint.** Proxy generation is CPU-bound and
runs inline on the API instance. On Render's starter plan (0.5 CPU) a
full-length 1080p60 game will transcode far slower than real time and will
compete with API requests. Short clips and Pro Day segments are fine; before
running full games regularly, bump the instance size — that is cheaper and
simpler than splitting services while the database is SQLite (§1).

### 3.8 Supported media policy (uploads)

Enforced client-side before a byte moves (`src/lib/mediaPolicy.js`) and
mirrored by the register endpoint — the UI names the rule it applied.

| Rule | Value |
|---|---|
| Containers | `.mp4` `.mov` `.m4v` `.mts` `.m2ts` (or any `video/*` MIME) |
| Codecs | Anything ffmpeg decodes; H.264 and HEVC are the verified set |
| Hard size cap | **128 GB** (2,621 parts of 50 MB — comfortably under R2's 10,000-part limit) |
| Advisory | Above 16 GB the UI suggests clipping before upload |
| Frame rate | Any. VFR normalizes to CFR in the proxy; sources above 60 fps halve to an exact divisor (119.88 → 59.94), so proxy frame N is source frame 2N and frame math stays integral |
| Empty/placeholder files | Rejected with an iCloud/OneDrive hint — cloud placeholders read as 0 bytes |

### 3.8a Review-proxy fidelity

Originals are never modified — the uploaded file is stored byte-for-byte and
kept for the full retention window. The **proxy** is a separate review copy,
and its settings are a direct trade between analyst accuracy and encode cost.

| | Height | Frame rate |
|---|---|---|
| Now | 1080p ceiling, never upscaled | **native** (119.88 stays 119.88) |
| Previously | 720p | halved above 60 |

Both dimensions matter for measurement:

- **Resolution** decides whether an analyst can *see* the contact frame. On a
  wide drone shot at 720p, cleat-and-base detail smears; 1080p holds it.
- **Frame rate** sets the finest distinction available. At 119.88 fps one
  frame is 8.34 ms; halved to 59.94 it is 16.68 ms. A 120 fps camera exists
  to buy that precision, and the proxy should not spend it.

`DM_PROXY_MAX_FPS` re-imposes a ceiling if a full-game encode at native rate
costs more wall-clock than the precision is worth. Halving is exact, so
proxy frame N maps to source frame 2N and the recorded `fps_used` on each
measurement stays the authoritative base either way.

**Re-encoding a feed replaces its proxy** rather than adding a second one.
Renditions already cited by a measurement are retained (that link is the
evidence trail) and selection always prefers the newest. Note that changing
a proxy's frame rate changes what a frame *number* refers to: stored
measurements keep their own `fps_used` so historical elapsed times remain
correct, but marks re-opened against a re-encoded proxy should be re-checked.

### 3.9 Upload reliability (field-failure postmortem, 2026-08-25)

Testers reported "Failed to fetch" on a 44 MB MP4 and a 0.91 GB 4K/HEVC
file while an 11.6 MB file succeeded. Server and R2 logs showed every
register/presign/abort returning 2xx — the dying request was always the
browser's PUT **directly to R2**. Packet capture showed Chrome pairs every
preflighted PUT with a raced provisional request that surfaces as
`net::ERR_ABORTED`; on some network paths the race resolves against the
real request, fetch rejects, and the old zero-retry client aborted the
whole transfer (deleting the feed row — hence "no trace in the queue").

The upload client now:
- retries each part 3× with backoff and a 10-minute stall timeout;
- never aborts on failure — the feed row and the R2 multipart session
  persist, and re-selecting the same file **resumes from the last good
  part** (the server hands back the same `uploadId` plus the parts R2
  already holds);
- reports stage-labelled errors ("Uploading part 7/19 … HTTP 403 …"),
  never a bare "Failed to fetch";
- logs `upload_started` / `upload_resumed` / `upload_completed` /
  `upload_aborted` server-side with feed id, size, and part counts.

A controlled ladder (10→100 MB, same H.264 encode) and a resolution matrix
(720p/1080p/4K at matched sizes) all pass against production; there is no
size threshold in the platform. Every successful part still shows one
paired raced-abort — that is normal Chrome behaviour, not a failure.

### 3.10 Processing safety on small instances (outage postmortem, 2026-08-25)

Processing a 0.91 GB 4K/119.88fps HEVC original OOM-killed the starter
instance twice (Render events: `oomKilled`, then a failed health check).
Cause: the worker downloaded the full original to the instance before
probing/transcoding — the page cache for a ~1 GB write counts against the
container's 512 MB memory limit.

Fixes now in place:
- **The worker streams sources from R2** (presigned GET; ffmpeg/ffprobe
  make range requests). No full-file scratch copies, at any size.
- **Proxy fps caps at 60** (exact halving above it) and transcodes with
  `-threads 2`, bounding both encode cost and API starvation.
- **Orphan recovery**: media jobs left `running` by a crashed instance are
  requeued at boot; three crashes marks the job and feed `failed` with a
  visible reason instead of looping or hanging in `processing` forever.

A full-length 1080p60 game still deserves a larger instance (§1) — the cap
bounds the damage, it does not make 0.5 CPU fast.

### 3.11 Processing liveness (stuck-in-PROCESSING postmortem, 2026-09-01)

A 17-second 720×1280/30fps H.264 phone clip (feed 22, job 5) sat in
`PROCESSING` for days. The probe finished in one second; the proxy encode
logged `proxy_encode_started` and never logged anything again. The media
job stayed `running`, so the boot-time orphan sweep (which only runs on
restart) never saw it, and `/command/ops` counted zero stuck feeds because
it only counted `failed`/`retrying`.

Cause class: **nothing on the read path had a timeout or a watchdog.**
- ffmpeg read the original through the localhost gateway with no
  `rw_timeout`; one blocked read waits forever.
- The gateway piped R2's response to ffmpeg but never destroyed the R2 body
  when ffmpeg dropped the connection (ffmpeg seeks by reconnecting). Each
  abandoned range request left a half-read body parked on a keep-alive
  socket. The SDK pool is 50 sockets; once exhausted, every new read waits
  for a socket that never frees. The process had been up since the previous
  deploy, processing 26 jobs' worth of seeks. (Most likely mechanism — the
  hang left no error to log, so it is inferred from the code path, not
  observed directly.)
- The S3 client had no connection or socket timeout.
- No liveness check existed for a `running` job on a live process.

Guarantees now in place (`server/mediaWorker.js`, `mediaGateway.js`, `storage.js`):
- **Stall watchdog.** ffmpeg runs with `-progress` on a pipe. No progress
  line for `DM_MEDIA_STALL_MS` (default 5 min) → SIGKILL, job error
  `"proxy encode stalled — no encoder progress for 300s (last output 6.4s,
  frame 192); process killed"`. Encode *speed* never trips it: a 14-hour
  full-game transcode still reports every half second.
- **I/O timeout.** `-rw_timeout` (`DM_MEDIA_IO_TIMEOUT_S`, default 30 s) on
  every ffmpeg/ffprobe input; ffprobe additionally has a 120 s hard cap.
- **Gateway teardown + first-byte timeout.** The R2 body is destroyed when
  the client closes; R2 has 30 s to start answering (`504` otherwise).
- **SDK timeouts.** `connectionTimeout` 10 s, socket-inactivity 120 s.
- **Heartbeat + sweep.** Progress lands on `cmd_media_jobs.heartbeat_at` /
  `progress_pct`; every worker tick reaps `running` jobs silent past the
  threshold, and `/command/ops` reports them as `media_queue.stalled`.
- **Three attempts, then terminal.** Stalls and crashes requeue up to
  `MAX_ATTEMPTS` (3), then the feed is `failed` with the specific reason.
- **Retry processing** (`POST /api/command/feeds/:id/retry`, button on the
  job page and the feed viewer) re-runs against the original in storage —
  a probed feed restarts at the proxy step. Works from `failed`, `retrying`,
  or a stalled `processing`. Never a re-upload, never a duplicate feed.
- **Claim tokens.** A retried job's row cannot be overwritten by the run it
  replaced.

Operator check: the job page shows the step and percentage while a feed is
processing, an amber stall notice when the encoder has gone quiet, and a
red **Failed processing — reason** line with **Retry processing** when it is
terminal. If you see `PROCESSING` with no progress text for more than the
stall threshold, the sweep is not running — check the worker log for
`media_worker_started`.

---

## 4. Backups and restore

**What runs:** on boot and hourly thereafter, the API checks whether a
successful snapshot exists for today (UTC). If not, it takes one with
SQLite's online backup API — safe against a live WAL database, no
downtime — and uploads it to `command/backups/<env>/dm-<ISO>Z.db` in the
media bucket. Results land in the `ops_backups` table and on
`/command/ops`.

An hourly check (rather than a 24-hour timer) means a restart or a
sleeping instance still produces the day's snapshot instead of skipping it.

**Manual snapshot:** `/command/ops` → **Back up now** (admin only), or
`POST /api/command/backups/run`.

**Restore:**

1. Stop writes — suspend the Render service (Settings → Suspend).
2. Download the snapshot from R2 (newest key under `command/backups/production/`).
3. Replace the database on the disk, removing stale WAL sidecars:
   ```bash
   mv /var/data/diamond-metrics.db /var/data/diamond-metrics.db.broken
   rm -f /var/data/diamond-metrics.db-wal /var/data/diamond-metrics.db-shm
   cp ~/Downloads/dm-2026-08-21T03-00-00Z.db /var/data/diamond-metrics.db
   ```
4. Resume the service. Boot-time migrations are additive and idempotent, so
   a snapshot from an older deploy upgrades itself on start.
5. Verify on `/command/ops`: job counts, and that media feeds still resolve
   (media lives in R2 and is unaffected by a database restore).

**Verify a snapshot without restoring** — this is worth doing once before
the pilot:
```bash
sqlite3 dm-2026-08-21T03-00-00Z.db "PRAGMA integrity_check; SELECT COUNT(*) FROM cmd_jobs;"
```

**What a snapshot does not cover:** uploaded media and proxies (they live
in R2 with their own durability and the retention policy in TDR §2).

---

## 5. Monitoring

**`/command/ops`** is the operator's dashboard: pipeline timing (p50/p90 per
stage, turnaround), quality rates (radar match, unavailable, review
returns), media pipeline durations and failures, service health, and backup
status. Empty stats render as `—`, never as a zero score.

**Structured logs.** Every line is JSON: `{ts, level, event, env, ...}`.
Useful events: `http_request` (method, path, status, ms, role),
`api_started`, `media_job_failed`, `backup_complete`, `backup_failed`,
`worker_started`. On Render, filter by `event` in the log stream or point a
log drain at them without a shipper.

**Error tracking.** Set `SENTRY_DSN` and unhandled request errors,
rejections, uncaught exceptions, and media job failures forward
automatically with environment and release tags. Without a DSN nothing is
lost — errors still appear in the structured log.

**What to watch during the pilot** (thresholds to revisit with real data):

| Signal | Where | Investigate when |
|---|---|---|
| Feeds needing attention | ops → Service health | Any non-zero value persists past one worker cycle |
| Media job failures | ops → Media pipeline | Any failure — retries are automatic up to 3 attempts |
| Last snapshot age | ops → Backups | Older than ~36 h |
| Radar match rate | ops → header stats | Drops below ~80 % — usually a roster or capture problem, not a parser one |
| Unavailable rate | ops → header stats | Above ~20 % — a capture-quality conversation with the customer |
| Turnaround p90 | ops → header stats | Trending toward the promised delivery window |
| Pending email | `/api/command/ops` | Non-zero with `RESEND_API_KEY` set means send failures |

---

## 6. Staging

Staging is a second Render service off the same repo with its own disk and
its own R2 prefix — it must never share the production database or bucket.

1. Render → New Web Service → same repo, branch `main` (or a `staging`
   branch), start command `node server/index.js`.
2. Add a small persistent disk mounted at `/var/data`.
3. Environment: `DM_ENV=staging`, `DM_DB_PATH=/var/data/diamond-metrics.db`,
   `FFMPEG_PATH=ffmpeg`, `FFPROBE_PATH=ffprobe`, `DM_MEDIA_SECRET=<random>`,
   and either `DM_STORAGE=local` (cheapest — media on the staging disk) or
   `DM_STORAGE=r2` with a **separate staging bucket**.
4. Leave `RESEND_API_KEY` unset so staging never emails a real customer;
   notification events still record in-app and are visible on the job page.
5. Point a Vercel preview deployment at the staging API URL.

Backups default to on in staging too; set `DM_BACKUPS=0` if the noise or
storage isn't wanted.

---

## 7. Routine operations

**Bulk tournament jobs** — `/command/bulk`: pick the tournament, package,
and optionally the specific teams; **Preview** shows exactly what would be
created and what already exists; **Create** runs the whole batch in one
transaction. Re-running after the schedule fills in is safe — existing
(game, team) pairs are skipped.

**A feed is stuck.** Check `/command/ops` → Feeds needing attention, then
the job page: the feed row shows the error. Retry from the job page (the
retry is idempotent — it never creates a duplicate feed). Persistent
failures are usually ffmpeg/ffprobe paths or an unreadable source file.

**Metrics released by mistake.** Reopen the job from
`/command/jobs/:id/review` → **Reopen for correction**, fix the evidence,
re-approve, and release again. Superseded results stay in the history and
the published entry updates in place — it never duplicates.

**Rotating the R2 credentials.** Update the four `R2_*` variables and
redeploy. Playback URLs are signed at request time, so nothing needs
regenerating; in-flight uploads must be restarted.
