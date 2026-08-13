// Hygiene pass for impossible zeros stored before the guard existed:
// flagged-metric zeros get excluded (reversible), real zeros stay.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-zerocleanup-test-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;

const { db } = await import('./db.js');
const { findInvalidZeroEntries, excludeInvalidZeroEntries, summarizeZeroReport } = await import('./zeroCleanup.js');

let gameId;

before(() => {
  const pid = db.prepare(`INSERT INTO players (slug, first_name, last_name) VALUES ('zero-kid', 'Zero', 'Kid')`).run().lastInsertRowid;
  gameId = db.prepare(`INSERT INTO games (player_id, game_date, game_type) VALUES (?, '2026-06-01', 'game')`).run(pid).lastInsertRowid;
  const ins = db.prepare('INSERT INTO stat_entries (game_id, metric_key, value) VALUES (?, ?, ?)');
  ins.run(gameId, 'max_velo', 0);        // impossible — pre-guard import artifact
  ins.run(gameId, 'strike_pct', 0);      // impossible
  ins.run(gameId, 'launch_angle', 0);    // legitimate signed zero
  ins.run(gameId, 'bs_h', 0);            // legitimate box zero
  ins.run(gameId, 'avg_exit_velo', 84);  // real measurement
});

after(() => {
  db.close();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

test('cleanup excludes only impossible zeros, reversibly, and is idempotent', () => {
  const found = findInvalidZeroEntries(db);
  assert.deepEqual(found.map(r => r.metric_key).sort(), ['max_velo', 'strike_pct']);

  const summary = summarizeZeroReport(found);
  assert.equal(summary.length, 2);
  assert.ok(summary.every(s => s.entries === 1 && s.players === 1));

  const { excluded } = excludeInvalidZeroEntries(db);
  assert.equal(excluded, 2);

  // Marked excluded, not deleted — reversible.
  const rows = db.prepare('SELECT metric_key, excluded FROM stat_entries WHERE game_id = ?').all(gameId);
  assert.equal(rows.length, 5, 'nothing deleted');
  assert.ok(rows.filter(r => ['max_velo', 'strike_pct'].includes(r.metric_key)).every(r => r.excluded === 1));
  assert.ok(rows.filter(r => ['launch_angle', 'bs_h', 'avg_exit_velo'].includes(r.metric_key)).every(r => r.excluded === 0));

  // Second run finds nothing.
  assert.equal(findInvalidZeroEntries(db).length, 0);
  assert.equal(excludeInvalidZeroEntries(db).excluded, 0);
});
