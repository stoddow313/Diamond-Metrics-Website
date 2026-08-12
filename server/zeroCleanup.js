// One-time hygiene for stored impossible zeros (0 mph, 0s, 0% strike…):
// spreadsheets pre-filled with zeros for non-participants imported those
// values before the zero-means-unmeasured guard existed. Entries are marked
// excluded = 1 — the aggregate engine already ignores excluded rows — so the
// operation is reversible and auditable, never a delete.
import { ZERO_UNMEASURED_KEYS } from './metricCatalog.js';

const KEYS = [...ZERO_UNMEASURED_KEYS];
const placeholders = KEYS.map(() => '?').join(',');

export function findInvalidZeroEntries(db) {
  return db.prepare(
    `SELECT se.id, se.metric_key, se.value, g.game_date, g.game_type,
            p.id AS player_id, p.first_name, p.last_name
     FROM stat_entries se
     JOIN games g ON g.id = se.game_id
     JOIN players p ON p.id = g.player_id
     WHERE se.excluded = 0 AND se.value = 0 AND se.metric_key IN (${placeholders})
     ORDER BY p.last_name, p.first_name, g.game_date, se.metric_key`
  ).all(...KEYS);
}

export function excludeInvalidZeroEntries(db) {
  const rows = findInvalidZeroEntries(db);
  const mark = db.transaction(list => {
    const stmt = db.prepare('UPDATE stat_entries SET excluded = 1 WHERE id = ?');
    for (const r of list) stmt.run(r.id);
    return list.length;
  });
  return { excluded: mark(rows), rows };
}

// Report grouped for humans: per metric, how many entries and players.
export function summarizeZeroReport(rows) {
  const byMetric = new Map();
  for (const r of rows) {
    if (!byMetric.has(r.metric_key)) byMetric.set(r.metric_key, { entries: 0, players: new Set() });
    const m = byMetric.get(r.metric_key);
    m.entries += 1;
    m.players.add(r.player_id);
  }
  return [...byMetric.entries()]
    .map(([metric_key, m]) => ({ metric_key, entries: m.entries, players: m.players.size }))
    .sort((a, b) => b.entries - a.entries);
}
