import { useRef, useState } from 'react';
import { api } from '../../lib/api';
import { GhostButton, PrimaryButton } from './ui';

// CSV/XLSX stat import for one player: each row is one game.
// Columns: game_date (required), game_type, opponent, location, notes,
// plus any metric columns — headers match metric keys OR display labels
// (case-insensitive). Existing games (same date + opponent) are updated,
// not duplicated, so re-importing a corrected file is safe.

const META_ALIASES = {
  game_date: ['game_date', 'date'],
  game_type: ['game_type', 'type', 'event_type'],
  opponent: ['opponent', 'event', 'opponent_event', 'vs'],
  location: ['location', 'venue'],
  notes: ['notes', 'note', 'comments'],
};

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildHeaderMap(headers, metrics) {
  // returns { columnIndexOrName: { kind: 'meta'|'metric'|'unknown', key } }
  const metaLookup = {};
  for (const [key, aliases] of Object.entries(META_ALIASES)) {
    for (const a of aliases) metaLookup[norm(a)] = key;
  }
  const metricLookup = {};
  for (const m of metrics) {
    metricLookup[norm(m.key)] = m.key;
    metricLookup[norm(m.label)] = m.key;
    if (m.short) metricLookup[norm(m.short)] = m.key;
  }
  const map = {};
  for (const h of headers) {
    const n = norm(h);
    if (metaLookup[n]) map[h] = { kind: 'meta', key: metaLookup[n] };
    else if (metricLookup[n]) map[h] = { kind: 'metric', key: metricLookup[n] };
    else map[h] = { kind: 'unknown', key: h };
  }
  return map;
}

function toIsoDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date && !isNaN(value)) {
    // SheetJS gives Date objects for date cells. Spreadsheet dates are
    // timezone-less; when the Date sits at UTC midnight, read it in UTC so
    // local-timezone offsets don't shift the day.
    const utcMidnight = value.getUTCHours() === 0 && value.getUTCMinutes() === 0;
    return utcMidnight
      ? `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`
      : `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!isNaN(d)) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return null;
}

function downloadTemplate(catalog) {
  const metaCols = ['game_date', 'game_type', 'opponent', 'location', 'notes'];
  const metricCols = catalog.metrics.map(m => m.key);
  const example = ['2026-04-12', 'game', 'vs Corner Canyon', 'South Jordan, UT', ''];
  const csv = [
    [...metaCols, ...metricCols].join(','),
    [...example, ...metricCols.map(() => '')].join(','),
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'diamond-metrics-stat-import-template.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function StatImport({ playerId, games, catalog, onComplete, onError }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    setBusy(true);
    setResult(null);
    onError('');

    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      if (!rows.length) throw new Error('No data rows found in the file.');

      const headerMap = buildHeaderMap(Object.keys(rows[0]), catalog.metrics);
      // A 0 in a zero-impossible metric (0 mph, 0s, 0% strike) means "not
      // measured" — sheets pre-fill zeros for players who didn't participate.
      const zeroUnmeasured = new Set(catalog.metrics.filter(m => m.zeroMeansUnmeasured).map(m => m.key));
      const unknownCols = Object.entries(headerMap).filter(([, v]) => v.kind === 'unknown').map(([h]) => h);

      // Existing games indexed by date+opponent so imports update instead of duplicate.
      const existing = new Map(games.map(g => [`${g.game_date}|${norm(g.opponent)}`, g]));
      const validTypes = new Set(catalog.gameTypes);

      let created = 0, updated = 0, zerosSkipped = 0;
      const errors = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2; // 1-based + header row
        try {
          const meta = { game_type: 'game', opponent: '', location: '', notes: '' };
          const stats = {};
          for (const [header, cell] of Object.entries(row)) {
            const m = headerMap[header];
            if (!m || m.kind === 'unknown') continue;
            if (m.kind === 'meta') {
              meta[m.key] = m.key === 'game_date' ? cell : String(cell).trim();
            } else if (cell !== '' && cell !== null) {
              const num = Number(cell);
              if (!Number.isFinite(num)) throw new Error(`"${header}" is not a number (${cell})`);
              if (num === 0 && zeroUnmeasured.has(m.key)) { zerosSkipped++; continue; }
              stats[m.key] = num;
            }
          }

          const isoDate = toIsoDate(meta.game_date);
          if (!isoDate) throw new Error('missing or unrecognized game_date');

          // "Pro Day", "pro-day", "PRO_DAY" all normalize to pro_day. An
          // unrecognized type is a visible row error — never silently 'game'.
          const rawType = String(meta.game_type || '').trim();
          const gameType = rawType.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
          let type = 'game';
          if (gameType) {
            if (!validTypes.has(gameType)) {
              throw new Error(`unknown event type "${rawType}" — valid types: ${[...validTypes].join(', ')}`);
            }
            type = gameType;
          }

          if (Object.keys(stats).length === 0) throw new Error('no stat values in row');

          const key = `${isoDate}|${norm(meta.opponent)}`;
          let game = existing.get(key);
          if (game) {
            // Re-importing a corrected file also fixes the event itself
            // (e.g. a row previously typed as "game" becoming a pro day).
            if (game.game_type !== type || (meta.location && meta.location !== game.location) || (meta.notes && meta.notes !== game.notes)) {
              const res = await api.updateGame(game.id, {
                game_type: type,
                location: meta.location || game.location,
                notes: meta.notes || game.notes,
              });
              existing.set(key, res.game);
              game = res.game;
            }
            updated++;
          } else {
            const res = await api.createGame(playerId, {
              game_date: isoDate, game_type: type,
              opponent: meta.opponent, location: meta.location, notes: meta.notes,
            });
            game = res.game;
            existing.set(key, game);
            created++;
          }
          await api.saveGameStats(game.id, stats);
        } catch (err) {
          errors.push(`Row ${rowNum}: ${err.message}`);
        }
      }

      setResult({ created, updated, errors, unknownCols, zerosSkipped, total: rows.length });
      if (created || updated) await onComplete();
    } catch (err) {
      onError(`Import failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <GhostButton type="button" onClick={() => downloadTemplate(catalog)}>
          Download template
        </GhostButton>
        <PrimaryButton type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? 'Importing…' : 'Import CSV / XLSX'}
        </PrimaryButton>
        <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={handleFile} />
      </div>

      {result && (
        <div className="mt-3 text-xs rounded-lg px-3 py-2" style={{ backgroundColor: 'rgba(30, 41, 59, 0.6)', color: '#cfe8ff' }}>
          <p className="font-bold">
            Imported {result.total} row{result.total === 1 ? '' : 's'}: {result.created} game{result.created === 1 ? '' : 's'} created, {result.updated} updated
            {result.errors.length > 0 && <span style={{ color: '#f87171' }}>, {result.errors.length} failed</span>}
          </p>
          {result.unknownCols.length > 0 && (
            <p className="mt-1" style={{ color: '#94a3b8' }}>Ignored columns: {result.unknownCols.join(', ')}</p>
          )}
          {result.zerosSkipped > 0 && (
            <p className="mt-1" style={{ color: '#fbbf24' }}>
              {result.zerosSkipped} zero value{result.zerosSkipped === 1 ? '' : 's'} treated as not measured (0 mph / 0 s / 0 % can't be real marks — leave cells blank to omit).
            </p>
          )}
          {result.errors.slice(0, 5).map((e, i) => <p key={i} className="mt-0.5" style={{ color: '#f87171' }}>{e}</p>)}
          {result.errors.length > 5 && <p style={{ color: '#f87171' }}>…and {result.errors.length - 5} more</p>}
        </div>
      )}
    </div>
  );
}
