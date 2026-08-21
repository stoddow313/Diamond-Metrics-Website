// M6: the backup must be *restorable*, not merely written. This test runs a
// real snapshot of a live WAL database and reopens it, which is the only
// assertion that actually protects pilot data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_DB = `/tmp/dm-backup-test-${process.pid}.db`;
const MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-backup-store-'));
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_MEDIA_DIR = MEDIA_DIR;   // local storage backend stands in for R2
process.env.DM_LOG_SILENT = '1';
delete process.env.DM_STORAGE;

const { db } = await import('./db.js');
const Database = (await import('better-sqlite3')).default;
const { runBackup, backedUpToday, lastBackup } = await import('./backup.js');
const { localPathFor } = await import('./storage.js');

before(() => {
  db.prepare("INSERT INTO players (slug, first_name, last_name) VALUES ('backup-me', 'Backup', 'Me')").run();
});

after(() => {
  db.close();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
  fs.rmSync(MEDIA_DIR, { recursive: true, force: true });
});

test('a snapshot of a live WAL database reopens with committed data intact', async () => {
  assert.equal(backedUpToday(db), false);

  // Uncommitted-at-snapshot-time rows must not appear; committed ones must.
  db.prepare("INSERT INTO players (slug, first_name, last_name) VALUES ('committed', 'Com', 'Mitted')").run();
  const result = await runBackup(db);

  assert.ok(result.bytes > 0, 'snapshot has content');
  const snapshotPath = localPathFor(result.key);
  assert.ok(fs.existsSync(snapshotPath), 'snapshot written to the storage adapter');

  const restored = new Database(snapshotPath, { readonly: true });
  const names = restored.prepare('SELECT slug FROM players ORDER BY slug').all().map(r => r.slug);
  assert.deepEqual(names, ['backup-me', 'committed'], 'restored snapshot holds committed rows');
  // A restore must also carry the Command schema, not just the base tables.
  assert.ok(restored.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cmd_jobs'").get());
  restored.close();

  const row = lastBackup(db);
  assert.equal(row.status, 'ok');
  assert.equal(row.mode, 'local');
  assert.equal(row.storage_key, result.key);
  assert.equal(backedUpToday(db), true, 'scheduler will not re-run today');
});

test('a failed backup is recorded and surfaced, never silent', async () => {
  const broken = {
    backup: () => Promise.reject(new Error('disk full')),
    prepare: db.prepare.bind(db),
  };
  await assert.rejects(() => runBackup(broken), /disk full/);
  const row = lastBackup(db);
  assert.equal(row.status, 'failed');
  assert.match(row.error, /disk full/);
});
