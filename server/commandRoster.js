// Who an analyst may attribute evidence to on a job (roadmap §4.2, identity
// resolution): the team's dated roster, the event roster for the tournament
// (including declared guests), and job-scoped guest placeholders created in
// Command when a runner or pitcher is not on any roster. A placeholder never
// forces a guessed permanent match — it can be reassigned to the identified
// player after the game, and it never gets a public profile on its own.
import { membershipCoversDate, slugify } from './rosterLogic.js';

export function commandRoster(db, jobOrId) {
  const job = typeof jobOrId === 'object' && jobOrId !== null
    ? jobOrId
    : db.prepare('SELECT * FROM cmd_jobs WHERE id = ?').get(jobOrId);
  if (!job) return [];
  const byPlayer = new Map();
  const memberships = db.prepare('SELECT * FROM roster_memberships WHERE team_id = ?').all(job.team_id);
  for (const m of memberships.filter(m => membershipCoversDate(m, job.game_date))) {
    byPlayer.set(m.player_id, { jersey: m.jersey || '', source: 'roster' });
  }
  if (job.tournament_id) {
    const rows = db.prepare(
      `SELECT er.player_id, er.jersey, er.is_guest FROM event_rosters er
         JOIN tournament_entries te ON te.id = er.entry_id
        WHERE te.team_id = ? AND te.tournament_id = ?`
    ).all(job.team_id, job.tournament_id);
    for (const r of rows) {
      if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, { jersey: r.jersey || '', source: r.is_guest ? 'event_guest' : 'event_roster' });
      else if (r.jersey && !byPlayer.get(r.player_id).jersey) byPlayer.get(r.player_id).jersey = r.jersey;
    }
  }
  for (const g of db.prepare('SELECT * FROM cmd_job_guests WHERE job_id = ?').all(job.id)) {
    byPlayer.set(g.player_id, { jersey: g.jersey || '', source: 'guest', guest_label: g.label || '' });
  }
  if (byPlayer.size === 0) return [];
  const ids = [...byPlayer.keys()];
  const players = db.prepare(
    `SELECT id, first_name, last_name, primary_position FROM players WHERE id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);
  return players
    .map(p => {
      const meta = byPlayer.get(p.id);
      return { ...p, ...meta, is_guest: meta.source === 'guest' || meta.source === 'event_guest' ? 1 : 0 };
    })
    .sort((a, b) => (a.is_guest - b.is_guest) || a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name));
}

// Create a guest / unknown-player placeholder for one job. Requires at least a
// name or a jersey number so the analyst can tell placeholders apart.
export function addJobGuest(db, jobId, { first_name = '', last_name = '', jersey = '', label = '' } = {}, actorId = null) {
  const first = String(first_name || '').trim();
  const last = String(last_name || '').trim();
  const jer = String(jersey || '').trim().replace(/^#/, '');
  const note = String(label || '').trim();
  if (!first && !last && !jer) throw Object.assign(new Error('Give the guest a name or a jersey number'), { status: 400 });
  const displayFirst = first || (jer ? `#${jer}` : 'Unknown');
  const displayLast = last || (note || 'Guest');
  const slug = slugify(`${displayFirst}-${displayLast}-guest-${jobId}-${Date.now().toString(36)}`);
  const playerId = db.prepare(
    'INSERT INTO players (first_name, last_name, slug, is_public) VALUES (?, ?, ?, 0)'
  ).run(displayFirst, displayLast, slug).lastInsertRowid;
  db.prepare('INSERT INTO cmd_job_guests (job_id, player_id, jersey, label, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(jobId, playerId, jer, note, actorId);
  db.prepare(
    "INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note) VALUES ('cmd_jobs', ?, ?, 'guest_added', ?)"
  ).run(jobId, actorId, `${displayFirst} ${displayLast}${jer ? ` #${jer}` : ''}${note ? ` (${note})` : ''}`);
  return { ...db.prepare('SELECT id, first_name, last_name FROM players WHERE id = ?').get(playerId), jersey: jer, is_guest: 1, source: 'guest', guest_label: note };
}
