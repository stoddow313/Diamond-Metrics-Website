// Paired game jobs. One game, one job per team — each keeps its own order,
// customer, review and release — sharing one set of footage and one
// scorebook. The guest job points at the host (cmd_jobs.game_host_job_id):
//   footage   both jobs see both jobs' feeds and finished proxies; nothing is
//             re-uploaded or re-encoded;
//   scorebook stored once, on the host. The guest reads and writes it with
//             'us' and 'them' swapped, so each job sees its own team as "us"
//             and releases its own players from the same log;
//   players   the opponent's lineup can name the other job's rostered players,
//             so both teams are credited; timing attempts and radar readings
//             land on the job whose team the player is on.
import { commandRoster } from './commandRoster.js';

const err = (message, status = 400) => Object.assign(new Error(message), { status });
const jobRow = (db, id) => db.prepare('SELECT * FROM cmd_jobs WHERE id = ?').get(id);
const SCOREBOOK_TYPES = ['lineup', 'half_inning', 'plate_appearance', 'pitch', 'runner', 'substitution', 'game_final', 'state_adjustment'];
const audit = (db, jobId, actorId, action, note) => db.prepare(
  "INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note) VALUES ('cmd_jobs', ?, ?, ?, ?)"
).run(jobId, actorId ?? null, action, note);

// { job, role: 'host' | 'guest' | null, partner, hostId }
export function pairingOf(db, jobOrId) {
  const job = typeof jobOrId === 'object' && jobOrId !== null ? jobOrId : jobRow(db, jobOrId);
  if (!job) return { job: null, role: null, partner: null, hostId: null };
  if (job.game_host_job_id) {
    const host = jobRow(db, job.game_host_job_id);
    if (host) return { job, role: 'guest', partner: host, hostId: host.id };
  }
  const guest = db.prepare('SELECT * FROM cmd_jobs WHERE game_host_job_id = ?').get(job.id);
  return guest ? { job, role: 'host', partner: guest, hostId: job.id } : { job, role: null, partner: null, hostId: job.id };
}

export const pairJobIds = (db, jobOrId) => {
  const p = pairingOf(db, jobOrId);
  return p.job ? (p.partner ? [p.job.id, p.partner.id] : [p.job.id]) : [];
};
export const footageJobIds = pairJobIds;   // both jobs' feeds serve both

export function partnerRoster(db, jobOrId) {
  const p = pairingOf(db, jobOrId);
  return p.partner ? commandRoster(db, p.partner) : [];
}

// The job a player's evidence belongs on: this job if the player is on its
// roster, the paired job if on that one's; null otherwise.
export function jobForPlayer(db, jobOrId, playerId) {
  if (!playerId) return null;
  const p = pairingOf(db, jobOrId);
  if (!p.job) return null;
  if (commandRoster(db, p.job).some(x => x.id === Number(playerId))) return p.job.id;
  if (p.partner && commandRoster(db, p.partner).some(x => x.id === Number(playerId))) return p.partner.id;
  return null;
}

const teamName = (db, teamId) => db.prepare('SELECT name FROM teams WHERE id = ?').get(teamId)?.name || '';
const scorebookCount = (db, jobId) => db.prepare(
  `SELECT COUNT(*) c FROM cmd_events WHERE job_id = ? AND status != 'superseded' AND event_type IN (${SCOREBOOK_TYPES.map(() => '?').join(',')})`
).get(jobId, ...SCOREBOOK_TYPES).c;
const feedCount = (db, jobId) => db.prepare("SELECT COUNT(*) c FROM cmd_video_feeds WHERE job_id = ? AND status != 'deleted'").get(jobId).c;

export function describeJob(db, job) {
  return {
    id: job.id, team_id: job.team_id, team_name: teamName(db, job.team_id), game_date: job.game_date,
    opponent_label: job.opponent_label || '', tournament_game_id: job.tournament_game_id ?? null,
    scorebook_events: scorebookCount(db, job.id), feeds: feedCount(db, job.id),
  };
}

// Jobs this one could pair with: the other team, same game date, not paired.
// The same tournament game first.
export function pairingCandidates(db, job) {
  return db.prepare(
    `SELECT * FROM cmd_jobs
      WHERE id != ? AND team_id != ? AND game_date = ? AND game_host_job_id IS NULL
        AND id NOT IN (SELECT game_host_job_id FROM cmd_jobs WHERE game_host_job_id IS NOT NULL)
      ORDER BY (tournament_game_id IS NOT NULL AND tournament_game_id = ?) DESC, id DESC LIMIT 20`
  ).all(job.id, job.team_id, job.game_date, job.tournament_game_id ?? -1).map(j => describeJob(db, j));
}

// Pair two jobs. The host is the one that already has a scorebook — or else
// the one with footage, or else the job named as the partner.
export function pairJobs(db, jobId, partnerId, actorId) {
  const a = jobRow(db, jobId);
  const b = jobRow(db, partnerId);
  if (!a || !b) throw err('Job not found', 404);
  if (a.id === b.id) throw err('Pick the other team’s job.');
  if (a.team_id === b.team_id) throw err('Both jobs are for the same team — pick the other team’s job.');
  if (a.game_date !== b.game_date) throw err(`The jobs are for different dates (${a.game_date} and ${b.game_date}).`);
  if (a.tournament_game_id && b.tournament_game_id && a.tournament_game_id !== b.tournament_game_id) throw err('The jobs are for different tournament games.');
  for (const j of [a, b]) if (pairingOf(db, j).role) throw err(`Job #${j.id} is already paired with another job.`, 409);
  const sa = scorebookCount(db, a.id);
  const sb = scorebookCount(db, b.id);
  if (sa && sb) throw err('Both jobs already have a scorebook. Keep one game’s scoring on one job, then pair.', 409);
  const [host, guest] = sa || (!sb && feedCount(db, a.id) > feedCount(db, b.id)) ? [a, b] : [b, a];
  db.transaction(() => {
    db.prepare('UPDATE cmd_jobs SET game_host_job_id = ? WHERE id = ?').run(host.id, guest.id);
    audit(db, host.id, actorId, 'jobs_paired', `shares footage and scorebook with job #${guest.id} (${teamName(db, guest.team_id)})`);
    audit(db, guest.id, actorId, 'jobs_paired', `uses job #${host.id}'s footage and scorebook (${teamName(db, host.team_id)})`);
  })();
  return { host_job_id: host.id, guest_job_id: guest.id };
}

export function unpairJobs(db, jobId, actorId) {
  const p = pairingOf(db, jobId);
  if (!p.role) throw err('This job is not paired.', 409);
  const guest = p.role === 'guest' ? p.job : p.partner;
  const host = p.role === 'guest' ? p.partner : p.job;
  if (guest.game_record_status === 'released') {
    throw err(`Job #${guest.id}'s game record is released from the shared scorebook. Withdraw it before unpairing.`, 409);
  }
  const onShared = db.prepare(
    `SELECT COUNT(*) c FROM cmd_events e JOIN cmd_video_feeds f ON f.id = e.selected_feed_id
      WHERE e.job_id = ? AND f.job_id = ? AND e.status != 'superseded'`
  ).get(guest.id, host.id).c;
  if (onShared) throw err(`Job #${guest.id} has ${onShared} timing attempt${onShared === 1 ? '' : 's'} on the shared footage. Remove ${onShared === 1 ? 'it' : 'them'} before unpairing.`, 409);
  db.transaction(() => {
    db.prepare('UPDATE cmd_jobs SET game_host_job_id = NULL WHERE id = ?').run(guest.id);
    audit(db, host.id, actorId, 'jobs_unpaired', `no longer shares with job #${guest.id}`);
    audit(db, guest.id, actorId, 'jobs_unpaired', `no longer uses job #${host.id}'s footage and scorebook`);
  })();
  return { host_job_id: host.id, guest_job_id: guest.id };
}

// ── The other team's view of the scorebook ─────────────────────────────────
// A payload's us_is_home is "is this perspective's us the home team" — a
// fact about the perspective, so it inverts with it. A lineup that now reads
// as "us" but never said (a label lineup entered as the opponent) takes it
// from the other perspective: `usIsHome` is that perspective's value.
const SWAP = { us: 'them', them: 'us' };
const swapSides = o => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [SWAP[k] || k, v])) : o);

export function flipPayload(type, p = {}, { usIsHome = null } = {}) {
  if (type === 'lineup') {
    const out = { ...p, side: SWAP[p.side] || p.side };
    if (typeof p.us_is_home === 'boolean') out.us_is_home = !p.us_is_home;
    else if (out.side === 'us' && typeof usIsHome === 'boolean') out.us_is_home = !usIsHome;
    return out;
  }
  if (type === 'substitution') return { ...p, side: SWAP[p.side] || p.side };
  if (type === 'state_adjustment') {
    const out = { ...p };
    if (p.score) out.score = swapSides(p.score);
    if (p.next_slot) out.next_slot = swapSides(p.next_slot);
    return out;
  }
  return p;   // half innings, plate appearances, pitches, runners, finals carry no side
}

// The host's event log as the guest sees it.
export function flipEvents(events) {
  const lineups = events.filter(e => e.event_type === 'lineup' && typeof e.payload?.us_is_home === 'boolean');
  const usHome = (lineups.filter(e => e.payload.side === 'us').at(-1) || lineups.at(-1))?.payload.us_is_home ?? null;
  return events.map(e => ({ ...e, payload: flipPayload(e.event_type, e.payload, { usIsHome: usHome }) }));
}

// Radar evidence follows its player: a reading credited to the other team's
// pitcher moves to that team's job (with its derived result), so it is
// reviewed and released there. A published value is never moved.
export function moveReadingToJob(db, readingId, jobId) {
  const reading = db.prepare('SELECT * FROM cmd_radar_readings WHERE id = ?').get(readingId);
  if (!reading || reading.job_id === jobId) return reading;
  const published = db.prepare(
    "SELECT 1 FROM cmd_metric_results WHERE evidence_kind = 'radar_reading' AND evidence_id = ? AND status = 'published'"
  ).get(readingId);
  if (published) throw err(`Reading ${readingId} is already published on job #${reading.job_id}. Withdraw it there before giving it to the other team.`, 409);
  db.prepare('UPDATE cmd_radar_readings SET job_id = ? WHERE id = ?').run(jobId, readingId);
  db.prepare("UPDATE cmd_metric_results SET job_id = ? WHERE evidence_kind = 'radar_reading' AND evidence_id = ?").run(jobId, readingId);
  return { ...reading, job_id: jobId };
}
