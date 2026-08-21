// Pocket Radar CSV parsing + radar-reading domain logic (Command M3).
//
// The real export format arrives with the next tournament; this parser is
// deliberately tolerant: it finds the velocity column by fuzzy header match,
// keeps every row (unparseable velocity → invalid with the raw row kept),
// and preserves the source file verbatim so batches can be reprocessed when
// the format is pinned. Raw rows are immutable — analyst decisions layer on.
export const PITCH_TYPES = ['fastball', 'curveball', 'slider', 'changeup', 'other', 'unknown'];
export const READING_STATUSES = ['unmatched', 'matched', 'invalid'];

const norm = s => String(s ?? '').toLowerCase().trim();

function splitCsvLine(line) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(v => v.trim());
}

const VELOCITY_HEADERS = ['speed (mph)', 'speed(mph)', 'velocity (mph)', 'velocity', 'speed', 'mph', 'reading'];
const TIME_HEADERS = ['timestamp', 'date/time', 'datetime', 'time', 'date'];

// Returns { rows: [{ row_index, velocity, source_timestamp, raw_row, parse_ok }], header_detected }
export function parseRadarCsv(content) {
  const lines = String(content || '').split(/\r?\n/).filter(l => l.trim() !== '');
  if (!lines.length) return { rows: [], header_detected: false };

  const first = splitCsvLine(lines[0]).map(norm);
  const velIdx = VELOCITY_HEADERS.map(h => first.findIndex(c => c === h || c.includes(h))).find(i => i >= 0);
  const headerDetected = velIdx !== undefined && velIdx >= 0;

  let velocityCol = headerDetected ? velIdx : -1;
  let timeCol = -1;
  if (headerDetected) {
    const t = TIME_HEADERS.map(h => first.findIndex(c => c === h || c.includes(h))).find(i => i >= 0);
    timeCol = t !== undefined && t >= 0 ? t : -1;
  }

  const dataLines = headerDetected ? lines.slice(1) : lines;
  const rows = dataLines.map((line, i) => {
    const cells = splitCsvLine(line);
    let raw;
    if (velocityCol >= 0) raw = cells[velocityCol];
    else {
      // Headerless fallback: first cell that parses as a plausible velocity.
      raw = cells.find(c => { const n = parseFloat(c); return Number.isFinite(n) && n >= 20 && n <= 130; });
    }
    const velocity = raw != null ? parseFloat(String(raw).replace(/[^\d.]/g, '')) : NaN;
    const plausible = Number.isFinite(velocity) && velocity >= 20 && velocity <= 130;
    return {
      row_index: i + (headerDetected ? 2 : 1),      // 1-based incl. header
      velocity: plausible ? velocity : null,
      source_timestamp: timeCol >= 0 ? (cells[timeCol] || '') : '',
      raw_row: line.slice(0, 500),
      parse_ok: plausible,
    };
  });
  return { rows, header_detected: headerDetected };
}

// ── Reading confirmation → draft metric results (db passed in; testable) ──

function activeVelocityCode(db, jobId, pitchOrExit) {
  const code = pitchOrExit === 'exit' ? 'exit_velocity_radar' : 'pitch_velocity_radar';
  const row = db.prepare(
    `SELECT r.id FROM cmd_metric_requirements r
     JOIN cmd_jobs j ON j.order_id = r.order_id
     WHERE j.id = ? AND r.metric_code = ? AND r.enabled = 1`
  ).get(jobId, code);
  return row ? code : null;
}

// Apply an analyst decision to a reading. Source fields are immutable; only
// classification/status/assignment change. Returns the updated reading.
export function classifyReading(db, readingId, { player_id, pitch_or_exit, pitch_type, status, note }, actorId) {
  const reading = db.prepare('SELECT * FROM cmd_radar_readings WHERE id = ?').get(readingId);
  if (!reading) throw Object.assign(new Error('Reading not found'), { status: 404 });

  const next = {
    player_id: player_id !== undefined ? player_id : reading.player_id,
    pitch_or_exit: pitch_or_exit ?? reading.pitch_or_exit,
    pitch_type: pitch_type ?? reading.pitch_type,
    status: status ?? reading.status,
    note: note !== undefined ? String(note) : reading.note,
  };
  if (!['pitch', 'exit', 'unknown'].includes(next.pitch_or_exit)) throw Object.assign(new Error('pitch_or_exit must be pitch, exit, or unknown'), { status: 400 });
  if (!PITCH_TYPES.includes(next.pitch_type)) throw Object.assign(new Error(`pitch_type must be one of ${PITCH_TYPES.join(', ')}`), { status: 400 });
  if (!READING_STATUSES.includes(next.status)) throw Object.assign(new Error('status must be unmatched, matched, or invalid'), { status: 400 });
  if (next.status === 'matched' && !next.player_id) throw Object.assign(new Error('A matched reading requires a player'), { status: 400 });
  if (next.status === 'matched' && reading.velocity == null) throw Object.assign(new Error('An unparseable reading cannot be matched — mark it invalid'), { status: 400 });
  if (next.player_id && !db.prepare('SELECT 1 FROM players WHERE id = ?').get(next.player_id)) {
    throw Object.assign(new Error('Unknown player'), { status: 400 });
  }

  const apply = db.transaction(() => {
    db.prepare(
      `UPDATE cmd_radar_readings SET player_id=?, pitch_or_exit=?, pitch_type=?, status=?, note=?,
       confirmed_by=?, confirmed_at=datetime('now') WHERE id=?`
    ).run(next.player_id ?? null, next.pitch_or_exit, next.pitch_type, next.status, next.note, actorId, readingId);

    // The reading's active metric result mirrors its current state. Drafts
    // update or delete outright; approved/published results are history —
    // a reclassification supersedes them (corrections keep the chain) or
    // withdraws them when the evidence stops being releasable.
    const existing = db.prepare(
      "SELECT id, status, player_id FROM cmd_metric_results WHERE evidence_kind='radar_reading' AND evidence_id=? AND superseded_by IS NULL AND status != 'withdrawn'"
    ).get(readingId);
    const code = next.status === 'matched' ? activeVelocityCode(db, reading.job_id, next.pitch_or_exit) : null;
    const decided = existing && ['approved', 'published'].includes(existing.status);

    if (next.status === 'matched' && code) {
      if (existing && !decided) {
        db.prepare("UPDATE cmd_metric_results SET metric_code=?, player_id=?, value=?, updated_at=datetime('now') WHERE id=? AND status='draft'")
          .run(code, next.player_id, reading.velocity, existing.id);
      } else if (!existing || existing.player_id !== next.player_id) {
        const newId = db.prepare(
          `INSERT INTO cmd_metric_results (job_id, metric_code, player_id, value, unit, method, status, evidence_kind, evidence_id, calculation_version, created_by)
           VALUES (?, ?, ?, ?, 'mph', 'radar_verified', 'draft', 'radar_reading', ?, 'CMD_V1', ?)`
        ).run(reading.job_id, code, next.player_id, reading.velocity, readingId, actorId).lastInsertRowid;
        if (decided) {
          db.prepare("UPDATE cmd_metric_results SET superseded_by = ?, updated_at = datetime('now') WHERE id = ?").run(newId, existing.id);
        }
      }
    } else if (existing && !decided) {
      db.prepare('DELETE FROM cmd_metric_results WHERE id = ?').run(existing.id);
    } else if (existing && decided) {
      db.prepare("UPDATE cmd_metric_results SET status = 'withdrawn', updated_at = datetime('now') WHERE id = ?").run(existing.id);
    }

    db.prepare(
      "INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note, prev_state, new_state) VALUES ('cmd_radar_readings', ?, ?, 'classified', ?, ?, ?)"
    ).run(readingId, actorId, next.note || '', `${reading.status}/${reading.player_id ?? '—'}`, `${next.status}/${next.player_id ?? '—'}`);
  });
  apply();
  return db.prepare('SELECT * FROM cmd_radar_readings WHERE id = ?').get(readingId);
}
