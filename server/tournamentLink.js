// A Command job linked to its tournament game after the fact. A job created
// as a standalone game still belongs to its team, but the tournament and team
// dashboards look for tournament games: their scoreboard and record come from
// the game's final score, and in a tournament a player's stats count for an
// entry through its event roster. Linking puts the finished work there
// without a new job: the job and the player games it published carry the
// tournament game (so they count for the team's entry whoever played —
// aggregates.attributedGames), a paired job follows to the same game, and
// the job's released final can be recorded on a game that has no score yet.
import { pairingOf } from './gamePairing.js';

const err = (message, status = 400) => Object.assign(new Error(message), { status });
const audit = (db, jobId, actorId, action, note) => db.prepare(
  "INSERT INTO cmd_review_actions (target_table, target_id, actor_id, action, note) VALUES ('cmd_jobs', ?, ?, ?, ?)"
).run(jobId, actorId ?? null, action, note);

const GAMES = `
  SELECT tg.*, tr.name AS tournament_name, d.name AS division_name,
         he.team_id AS home_team_id, ae.team_id AS away_team_id, ht.name AS home_team_name, at.name AS away_team_name
    FROM tournament_games tg
    JOIN tournaments tr ON tr.id = tg.tournament_id
    JOIN divisions d ON d.id = tg.division_id
    JOIN tournament_entries he ON he.id = tg.home_entry_id JOIN teams ht ON ht.id = he.team_id
    JOIN tournament_entries ae ON ae.id = tg.away_entry_id JOIN teams at ON at.id = ae.team_id`;

const jobRow = (db, id) => db.prepare('SELECT * FROM cmd_jobs WHERE id = ?').get(id);
const gameRow = (db, id) => db.prepare(`${GAMES} WHERE tg.id = ?`).get(id);
const otherJobOn = (db, gameId, teamId, notIds) => db.prepare(
  `SELECT id FROM cmd_jobs WHERE tournament_game_id = ? AND team_id = ? AND id NOT IN (${notIds.map(() => '?').join(',')})`
).get(gameId, teamId, ...notIds);
const resultOf = (db, jobId) => db.prepare('SELECT us_runs, them_runs, winner FROM cmd_game_results WHERE job_id = ?').get(jobId) || null;

export function describeTournamentGame(g, teamId) {
  if (!g) return null;
  const home = g.home_team_id === teamId;
  return {
    id: g.id, tournament_id: g.tournament_id, tournament_name: g.tournament_name, division_name: g.division_name,
    game_date: g.game_date, game_time: g.game_time || '', field: g.field || '', stage: g.stage || null,
    home_team_name: g.home_team_name, away_team_name: g.away_team_name,
    opponent: home ? g.away_team_name : g.home_team_name, is_home: home,
    status: g.status, home_score: g.home_score, away_score: g.away_score,
    archived: !!g.archived_at,
  };
}

// The job's link, the games it could link to (its team's, on its date), and
// the released final that could be recorded on a game with no score.
export function tournamentLinkOf(db, jobId) {
  const job = jobRow(db, jobId);
  if (!job) return null;
  const { partner } = pairingOf(db, job);
  const linked = job.tournament_game_id ? describeTournamentGame(gameRow(db, job.tournament_game_id), job.team_id) : null;
  const games = db.prepare(
    `${GAMES} WHERE (he.team_id = ? OR ae.team_id = ?) AND tg.archived_at IS NULL AND tr.archived = 0 ORDER BY tg.game_date, tg.game_time`
  ).all(job.team_id, job.team_id);
  const taken = g => otherJobOn(db, g.id, job.team_id, [job.id, partner?.id ?? job.id]);
  const candidates = games.filter(g => g.game_date === job.game_date && g.id !== job.tournament_game_id)
    .map(g => ({ ...describeTournamentGame(g, job.team_id), linked_job_id: taken(g)?.id ?? null }));
  // Near misses: the same team within a week, when nothing matches the date.
  const day = d => Date.parse(`${d}T00:00:00Z`) / 86400000;
  const nearby = candidates.length ? [] : games.filter(g => g.id !== job.tournament_game_id && Math.abs(day(g.game_date) - day(job.game_date)) <= 7)
    .map(g => describeTournamentGame(g, job.team_id));
  return {
    job_id: job.id, team_id: job.team_id, game_date: job.game_date,
    linked, candidates, nearby,
    result: resultOf(db, job.id),
    partner: partner ? { id: partner.id, team_id: partner.team_id, tournament_game_id: partner.tournament_game_id ?? null } : null,
  };
}

function setLink(db, job, game) {
  db.prepare("UPDATE cmd_jobs SET tournament_game_id = ?, tournament_id = ?, updated_at = datetime('now') WHERE id = ?").run(game?.id ?? null, game?.tournament_id ?? null, job.id);
  db.prepare('UPDATE games SET tournament_game_id = ? WHERE command_job_id = ?').run(game?.id ?? null, job.id);
  if (game) db.prepare('UPDATE intake_submissions SET tournament_game_id = ? WHERE job_id = ? AND tournament_game_id IS NULL').run(game.id, job.id);
}

// Link a job (and its paired job, when that team plays in the game) to a
// tournament game of its team on its date. record_score: the job's released
// final becomes the game's score — only on a game with no score yet.
export function linkTournamentGame(db, jobId, { tournament_game_id, record_score = false } = {}, actorId) {
  const job = jobRow(db, jobId);
  if (!job) throw err('Job not found', 404);
  const game = gameRow(db, Number(tournament_game_id));
  if (!game || game.archived_at) throw err('That tournament game is not available', 404);
  const sides = [game.home_team_id, game.away_team_id];
  if (!sides.includes(job.team_id)) throw err(`This job's team doesn't play in that game (${game.home_team_name} vs ${game.away_team_name})`);
  if (game.game_date !== job.game_date) throw err(`That game is on ${game.game_date}; this job is dated ${job.game_date}. Fix whichever date is wrong first.`);
  const { partner } = pairingOf(db, job);
  const ids = [job.id, partner?.id ?? job.id];
  const clash = otherJobOn(db, game.id, job.team_id, ids);
  if (clash) throw err(`Job #${clash.id} is already linked to that game for this team`, 409);
  // The paired job is the other team's: it follows when that team is the opponent here.
  const partnerFollows = partner && partner.team_id !== job.team_id && sides.includes(partner.team_id);
  const partnerElsewhere = partnerFollows && partner.tournament_game_id && ![game.id, job.tournament_game_id].includes(partner.tournament_game_id);
  if (partnerElsewhere) throw err(`The paired job #${partner.id} is linked to a different tournament game — unlink it first`, 409);
  if (partnerFollows) {
    const pc = otherJobOn(db, game.id, partner.team_id, ids);
    if (pc) throw err(`Job #${pc.id} is already linked to that game for the other team`, 409);
  }

  const result = resultOf(db, job.id);
  const unscored = game.status !== 'final' && game.home_score == null && game.away_score == null;
  if (record_score && !result) throw err("This job's game record hasn't been released — there is no final score to record");
  if (record_score && !unscored) throw err('That tournament game already has a score — it is kept as entered');
  const what = `${game.tournament_name} · ${game.game_date} · ${game.home_team_name} vs ${game.away_team_name}`;
  db.transaction(() => {
    setLink(db, job, game);
    audit(db, job.id, actorId, 'tournament_game_linked', `linked to tournament game #${game.id} (${what})${job.tournament_game_id ? ` — was #${job.tournament_game_id}` : ''}`);
    if (partnerFollows && partner.tournament_game_id !== game.id) {
      setLink(db, partner, game);
      audit(db, partner.id, actorId, 'tournament_game_linked', `linked to tournament game #${game.id} (${what}) with paired job #${job.id}`);
    }
    if (record_score) {
      const home = game.home_team_id === job.team_id;
      const [hs, as] = home ? [result.us_runs, result.them_runs] : [result.them_runs, result.us_runs];
      db.prepare("UPDATE tournament_games SET home_score = ?, away_score = ?, status = 'final' WHERE id = ?").run(hs, as, game.id);
      audit(db, job.id, actorId, 'tournament_score_recorded', `final ${game.home_team_name} ${hs} – ${game.away_team_name} ${as} recorded on tournament game #${game.id} from this job's released game record`);
    }
  })();
  return tournamentLinkOf(db, job.id);
}

// Back to a standalone game. A score already recorded on the tournament game
// stays — it is the tournament's record now.
export function unlinkTournamentGame(db, jobId, actorId) {
  const job = jobRow(db, jobId);
  if (!job) throw err('Job not found', 404);
  if (!job.tournament_game_id) throw err('This job is not linked to a tournament game', 409);
  const { partner } = pairingOf(db, job);
  db.transaction(() => {
    setLink(db, job, null);
    audit(db, job.id, actorId, 'tournament_game_unlinked', `unlinked from tournament game #${job.tournament_game_id}`);
    if (partner && partner.tournament_game_id === job.tournament_game_id) {
      setLink(db, partner, null);
      audit(db, partner.id, actorId, 'tournament_game_unlinked', `unlinked from tournament game #${job.tournament_game_id} with paired job #${job.id}`);
    }
  })();
  return tournamentLinkOf(db, job.id);
}
