// Command M6: nightly SQLite backup with retention.
//
// SQLite in WAL mode cannot be safely copied with cp while the API is
// writing — better-sqlite3's online backup API produces a consistent
// snapshot without stopping the service. Snapshots go to the storage
// adapter (R2 in prod, disk in dev) under a dated key, and old ones prune
// on a retention window. docs/COMMAND_OPS.md holds the restore runbook.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { putObject, listObjects, deleteObject, storageMode, getObjectRange, localPathFor } from './storage.js';
import { log, captureError, ENV, alertOps } from './observability.js';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';

export const BACKUP_PREFIX = 'command/backups';
export const RETENTION_DAYS = Number(process.env.DM_BACKUP_RETENTION_DAYS || 30);

export function backupKey(date = new Date(), env = ENV) {
  const stamp = date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${BACKUP_PREFIX}/${env}/dm-${stamp}Z.db`;
}

export function dateFromKey(key) {
  const m = String(key).match(/dm-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.db$/);
  if (!m) return null;
  return new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
}

// Keep everything inside the retention window; never prune the newest
// snapshot even if it has aged out — a stale backup beats no backup.
export function prunableKeys(keys, { now = Date.now(), retentionDays = RETENTION_DAYS } = {}) {
  const dated = keys.map(k => ({ key: k, at: dateFromKey(k) })).filter(x => x.at);
  if (dated.length <= 1) return [];
  const newest = Math.max(...dated.map(x => x.at.getTime()));
  const cutoff = now - retentionDays * 86_400_000;
  return dated.filter(x => x.at.getTime() < cutoff && x.at.getTime() !== newest).map(x => x.key);
}

export function lastBackup(db) {
  return db.prepare('SELECT * FROM ops_backups ORDER BY id DESC LIMIT 1').get() || null;
}

export function backedUpToday(db, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  return Boolean(db.prepare(
    "SELECT 1 FROM ops_backups WHERE status = 'ok' AND date(created_at) = ?"
  ).get(today));
}

export async function runBackup(db, { now = new Date() } = {}) {
  const key = backupKey(now);
  const scratch = path.join(os.tmpdir(), `dm-backup-${process.pid}-${Date.now()}.db`);
  const started = Date.now();
  try {
    await db.backup(scratch);                     // consistent snapshot, no downtime
    const { size } = fs.statSync(scratch);
    await putObject(key, scratch);
    db.prepare("INSERT INTO ops_backups (storage_key, bytes, status, mode) VALUES (?, ?, 'ok', ?)")
      .run(key, size, storageMode);
    log('info', 'backup_complete', { key, bytes: size, ms: Date.now() - started, mode: storageMode });

    let pruned = [];
    try {
      pruned = prunableKeys(await listObjects(`${BACKUP_PREFIX}/${ENV}/`), { now: now.getTime() });
      for (const old of pruned) await deleteObject(old);
      if (pruned.length) log('info', 'backup_pruned', { count: pruned.length });
    } catch (pruneErr) {
      // A pruning failure must never mark a good backup as failed.
      captureError(pruneErr, { event: 'backup_prune_failed', component: 'backup' });
    }
    return { key, bytes: size, pruned: pruned.length };
  } catch (err) {
    db.prepare("INSERT INTO ops_backups (storage_key, bytes, status, mode, error) VALUES (?, 0, 'failed', ?, ?)")
      .run(key, storageMode, String(err?.message || err));
    captureError(err, { event: 'backup_failed', component: 'backup', key });
    alertOps('Database backup failed', { key, error: String(err?.message || err) });
    throw err;
  } finally {
    fs.rmSync(scratch, { force: true });
  }
}

// Restore drill without restoring: pull the newest successful snapshot back
// from storage, open it, run integrity_check, and count what it holds. A
// backup that exists is not the same as a backup that restores — this is
// the check the runbook (§4) asks for before real customer orders.
export async function verifyLatestBackup(db) {
  const row = db.prepare("SELECT * FROM ops_backups WHERE status = 'ok' ORDER BY id DESC LIMIT 1").get();
  if (!row) return { ok: false, error: 'No successful backup has been recorded yet' };
  const scratch = path.join(os.tmpdir(), `dm-verify-${process.pid}-${Date.now()}.db`);
  const started = Date.now();
  try {
    if (storageMode === 'r2') {
      const obj = await getObjectRange(row.storage_key);
      await pipeline(obj.body, fs.createWriteStream(scratch));
    } else {
      fs.copyFileSync(localPathFor(row.storage_key), scratch);
    }
    const Database = createRequire(import.meta.url)('better-sqlite3');
    const snap = new Database(scratch);
    try {
      const integrity = snap.prepare('PRAGMA integrity_check').get().integrity_check;
      const count = table => snap.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
      const result = {
        ok: integrity === 'ok', key: row.storage_key, snapshot_at: row.created_at,
        bytes: fs.statSync(scratch).size, integrity,
        counts: { players: count('players'), teams: count('teams'), cmd_jobs: count('cmd_jobs'), cmd_metric_results: count('cmd_metric_results') },
        ms: Date.now() - started,
      };
      log(result.ok ? 'info' : 'error', 'backup_verified', result);
      if (!result.ok) alertOps('Latest database backup failed integrity_check', { key: row.storage_key, integrity });
      return result;
    } finally {
      snap.close();
    }
  } catch (err) {
    captureError(err, { event: 'backup_verify_failed', component: 'backup', key: row.storage_key });
    return { ok: false, key: row.storage_key, error: String(err?.message || err) };
  } finally {
    fs.rmSync(scratch, { force: true });
  }
}

// Hourly tick, one backup per calendar day. An hourly check (rather than a
// 24h timer) means a restart or a sleeping free-tier instance still gets
// the day's snapshot instead of skipping it.
export function startBackupScheduler(db, { intervalMs = 3_600_000 } = {}) {
  if (process.env.DM_BACKUPS === '0') {
    log('info', 'backup_scheduler_disabled', {});
    return null;
  }
  const tick = async () => {
    try {
      if (backedUpToday(db)) return;
      await runBackup(db);
    } catch { /* runBackup already logged and recorded the failure */ }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  log('info', 'backup_scheduler_started', { retention_days: RETENTION_DAYS, mode: storageMode });
  return timer;
}
