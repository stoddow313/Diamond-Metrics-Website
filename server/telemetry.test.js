// M6 acceptance: the operating numbers behind the per-game cost model —
// time in stage, turnaround, match/unavailable/return rates — plus the
// backup retention rules that protect the pilot data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTs, percentile, stageDurations, summarizeStages, computeRates,
} from './telemetry.js';
import { backupKey, dateFromKey, prunableKeys } from './backup.js';

test('SQLite timestamps parse as UTC, not local time', () => {
  // A naive Date('2026-08-21 12:00:00') is local — in MDT that is 6 hours
  // off, which would silently skew every duration in this module.
  assert.equal(parseTs('2026-08-21 12:00:00'), Date.UTC(2026, 7, 21, 12, 0, 0));
  assert.equal(parseTs('2026-08-21T12:00:00Z'), Date.UTC(2026, 7, 21, 12, 0, 0));
  assert.equal(parseTs(null), null);
  assert.equal(parseTs('not a date'), null);
});

test('percentile picks real observed values and tolerates empty input', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 90), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
});

test('stage durations split a job timeline; the open stage stays out of completed stats', () => {
  const { stages, open } = stageDurations({
    createdAt: '2026-08-20 09:00:00',
    transitions: [
      { new_state: 'in_progress', created_at: '2026-08-20 11:00:00' },       // 2h not_started
      { new_state: 'ready_for_review', created_at: '2026-08-20 14:30:00' },  // 3.5h in_progress
      { new_state: 'approved', created_at: '2026-08-20 15:00:00' },          // 0.5h ready_for_review
    ],
    now: Date.UTC(2026, 7, 20, 17, 0, 0),
  });
  assert.deepEqual(stages, [
    { stage: 'not_started', hours: 2, closed: true },
    { stage: 'in_progress', hours: 3.5, closed: true },
    { stage: 'ready_for_review', hours: 0.5, closed: true },
  ]);
  assert.deepEqual(open, { stage: 'approved', hours: 2, closed: false });

  // Out-of-order audit rows must not produce negative durations.
  const scrambled = stageDurations({
    createdAt: '2026-08-20 09:00:00',
    transitions: [
      { new_state: 'ready_for_review', created_at: '2026-08-20 14:30:00' },
      { new_state: 'in_progress', created_at: '2026-08-20 11:00:00' },
    ],
    now: Date.UTC(2026, 7, 20, 15, 0, 0),
  });
  assert.ok(scrambled.stages.every(s => s.hours >= 0), 'no negative stage durations');
});

test('stage summary reports p50/p90 per stage across jobs', () => {
  const summary = summarizeStages([
    { stages: [{ stage: 'in_progress', hours: 1 }, { stage: 'ready_for_review', hours: 4 }] },
    { stages: [{ stage: 'in_progress', hours: 3 }] },
    { stages: [{ stage: 'in_progress', hours: 9 }] },
  ]);
  const inProgress = summary.find(s => s.stage === 'in_progress');
  assert.equal(inProgress.samples, 3);
  assert.equal(inProgress.p50_hours, 3);
  assert.equal(inProgress.p90_hours, 9);
  // Stages in the canonical order, and only stages with data.
  assert.deepEqual(summary.map(s => s.stage), ['in_progress', 'ready_for_review']);
});

test('rates: unparseable radar rows never count against the match rate', () => {
  const rates = computeRates({
    readings: [
      { velocity: 70.1, status: 'matched' },
      { velocity: 68.0, status: 'matched' },
      { velocity: 55.2, status: 'invalid' },
      { velocity: 71.0, status: 'unmatched' },
      { velocity: null, status: 'unmatched' },   // unreadable CSV row
    ],
    results: [
      { status: 'published' }, { status: 'approved' },
      { status: 'unavailable' }, { status: 'draft' },
    ],
    returns: 1,
    reviewedJobs: 4,
  });
  assert.equal(rates.radar.readings, 5);
  assert.equal(rates.radar.unparseable, 1);
  assert.equal(rates.radar.match_rate, 0.5);       // 2 matched of 4 parseable
  assert.equal(rates.results.unavailable_rate, 0.25);
  assert.equal(rates.review.return_rate, 0.25);

  // No work yet must read as "no data", never as a perfect or zero score.
  const empty = computeRates({});
  assert.equal(empty.radar.match_rate, null);
  assert.equal(empty.results.unavailable_rate, null);
  assert.equal(empty.review.return_rate, null);
});

test('backup keys round-trip and retention never prunes the newest snapshot', () => {
  const at = new Date('2026-08-21T03:00:00Z');
  const key = backupKey(at, 'production');
  assert.equal(key, 'command/backups/production/dm-2026-08-21T03-00-00Z.db');
  assert.equal(dateFromKey(key).toISOString(), '2026-08-21T03:00:00.000Z');
  assert.equal(dateFromKey('command/backups/production/not-a-backup.txt'), null);

  const now = Date.parse('2026-08-21T04:00:00Z');
  const keys = [
    'command/backups/production/dm-2026-06-01T03-00-00Z.db',   // 81 days old
    'command/backups/production/dm-2026-07-25T03-00-00Z.db',   // 27 days old
    'command/backups/production/dm-2026-08-21T03-00-00Z.db',   // today
    'command/backups/production/README.txt',                   // not a snapshot
  ];
  assert.deepEqual(prunableKeys(keys, { now, retentionDays: 30 }),
    ['command/backups/production/dm-2026-06-01T03-00-00Z.db']);

  // A single aged-out backup is still the only backup — keep it.
  assert.deepEqual(prunableKeys(['command/backups/production/dm-2026-01-01T03-00-00Z.db'], { now, retentionDays: 30 }), []);
  assert.deepEqual(prunableKeys([], { now }), []);
});
