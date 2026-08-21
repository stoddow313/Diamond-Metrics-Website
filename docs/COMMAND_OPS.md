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

## 3. Backups and restore

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

## 4. Monitoring

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

## 5. Staging

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

## 6. Routine operations

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
