// Identity and duplicate signals for intake (doc §8 "Duplicate prevention
// rules"). Everything here SUGGESTS — nothing links, merges or creates a
// record. A staff decision is the only way a submission becomes attached to a
// player, team or job, and an ambiguous minor is never matched automatically.
import { normalizeName } from './intakeLogic.js';

function levenshtein(a, b, cap = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

const tokens = s => normalizeName(s).split(' ').filter(t => t.length >= 2);
function similarLabel(a, b) {
  const x = normalizeName(a); const y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if ((x.length >= 4 && y.includes(x)) || (y.length >= 4 && x.includes(y))) return 0.75;
  const tx = tokens(a); const ty = new Set(tokens(b));
  if (!tx.length) return 0;
  const shared = tx.filter(t => ty.has(t)).length;
  return shared / Math.max(tx.length, ty.size || 1) >= 0.5 ? 0.5 : 0;
}

// ── Athletes ─────────────────────────────────────────────────────────────
// Loaded once per request and scored in memory: the players table is small
// (thousands), and scoring every athlete on a coach's submission against one
// snapshot keeps the reasons consistent across rows.
export function loadPlayerIndex(db) {
  return db.prepare(
    `SELECT p.id, p.first_name, p.last_name, p.slug, p.date_of_birth, p.grad_year, p.is_public,
            EXISTS (SELECT 1 FROM cmd_job_guests g WHERE g.player_id = p.id) AS is_placeholder
       FROM players p`
  ).all().map(p => ({ ...p, fn: normalizeName(p.first_name), ln: normalizeName(p.last_name) }));
}

const CONFIDENCE = [[105, 'high'], [75, 'medium'], [45, 'low']];

export function scorePlayerCandidates(db, index, athlete, { teamIds = [], gameDate = null, limit = 6 } = {}) {
  const fn = normalizeName(athlete.first_name);
  const ln = normalizeName(athlete.last_name);
  if (!ln) return [];
  const rosterStmt = db.prepare(
    `SELECT m.team_id, m.start_date, m.end_date, t.name FROM roster_memberships m JOIN teams t ON t.id = m.team_id WHERE m.player_id = ?`
  );
  const out = [];
  for (const p of index) {
    const lastExact = p.ln === ln;
    if (!lastExact && (ln.length < 5 || levenshtein(p.ln, ln, 1) > 1)) continue;
    const reasons = [];
    let score = lastExact ? 40 : 20;
    reasons.push(lastExact ? 'same last name' : 'last name one letter different');
    if (fn && p.fn === fn) { score += 40; reasons.push('same first name'); }
    else if (fn && p.fn && Math.min(fn.length, p.fn.length) >= 3 && (p.fn.startsWith(fn) || fn.startsWith(p.fn))) { score += 25; reasons.push('first name is a short form of the other'); }
    else if (fn && p.fn && fn[0] === p.fn[0]) { score += 10; reasons.push('same first initial'); }
    else continue;

    const by = Number(athlete.birth_year) || null;
    if (by && p.date_of_birth) {
      if (Number(String(p.date_of_birth).slice(0, 4)) === by) { score += 25; reasons.push(`born ${by}`); }
      else { score -= 40; reasons.push(`birth year differs (${String(p.date_of_birth).slice(0, 4)})`); }
    } else if (by && p.grad_year) {
      if (Math.abs(p.grad_year - (by + 18)) <= 1) { score += 10; reasons.push(`class of ${p.grad_year} fits a ${by} birth year`); }
      else { score -= 15; reasons.push(`class of ${p.grad_year} does not fit a ${by} birth year`); }
    }

    const memberships = rosterStmt.all(p.id);
    const onTeam = memberships.filter(m => teamIds.includes(m.team_id));
    if (onTeam.length) {
      score += 20;
      const dated = gameDate && onTeam.some(m => (!m.start_date || m.start_date <= gameDate) && (!m.end_date || m.end_date >= gameDate));
      if (dated) score += 5;
      reasons.push(dated ? `on the ${onTeam[0].name} roster for this game date` : `on the ${onTeam[0].name} roster`);
    } else if (athlete.team_label && memberships.some(m => similarLabel(athlete.team_label, m.name) >= 0.5)) {
      score += 10;
      reasons.push('plays for a team with a similar name');
    }
    if (p.is_placeholder) { score -= 10; reasons.push('a job guest placeholder'); }

    const confidence = (CONFIDENCE.find(([min]) => score >= min) || [])[1];
    if (!confidence) continue;
    out.push({
      player_id: p.id, name: `${p.first_name} ${p.last_name}`, slug: p.slug, is_public: !!p.is_public,
      date_of_birth: p.date_of_birth, grad_year: p.grad_year, placeholder: !!p.is_placeholder,
      teams: [...new Set(memberships.map(m => m.name))].slice(0, 3),
      score, confidence, reasons,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// "Require staff selection when more than one reasonable match exists" (§8).
export function isAmbiguous(candidates) {
  const reasonable = candidates.filter(c => c.confidence !== 'low');
  return reasonable.length > 1 || (candidates.length > 0 && candidates[0].confidence !== 'high');
}

// ── Teams ────────────────────────────────────────────────────────────────
export function teamCandidates(db, { label = '', level = '', accountId = null, limit = 5 } = {}) {
  const linked = accountId
    ? new Set(db.prepare('SELECT team_id FROM customer_team_links WHERE account_id = ?').all(accountId).map(r => r.team_id))
    : new Set();
  const rows = db.prepare(
    `SELECT t.id, t.name, t.age_group, t.level, o.name AS organization_name
       FROM teams t JOIN organizations o ON o.id = t.organization_id WHERE t.active = 1`
  ).all();
  const out = [];
  for (const t of rows) {
    const reasons = [];
    let score = 0;
    const sim = Math.max(similarLabel(label, t.name), similarLabel(label, `${t.organization_name} ${t.name}`) * 0.9);
    if (sim === 1) { score += 60; reasons.push('same team name'); }
    else if (sim >= 0.75) { score += 35; reasons.push('team name contains the other'); }
    else if (sim >= 0.45) { score += 25; reasons.push('team names share words'); }
    if (linked.has(t.id)) { score += 40; reasons.push('this account is linked to the team'); }
    if (!score) continue;
    if (level && t.age_group && normalizeName(level) === normalizeName(t.age_group)) { score += 15; reasons.push(`same age group (${t.age_group})`); }
    out.push({ team_id: t.id, name: t.name, organization_name: t.organization_name, age_group: t.age_group, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ── Games and jobs ("game date plus team plus opponent/event") ──────────
// Jobs are per team, so a link suggestion needs the team to match; opponent
// and event only raise confidence. Two teams playing the same opponent on the
// same day are different games. The opponent's own job for the same game is
// surfaced too, flagged other_side — useful to know, never to link.
export function jobCandidates(db, { teamIds = [], opponentTeamIds = [], teamLabel = '', gameDate = null, opponent = '', event = '', excludeJobId = null, limit = 5 } = {}) {
  if (!gameDate) return [];
  const rows = db.prepare(
    `SELECT j.id, j.team_id, j.game_date, j.opponent_label, j.event_label, j.metric_release_status, j.game_record_status,
            t.name AS team_name, o.package_key, o.synthetic, tr.name AS tournament_name
       FROM cmd_jobs j JOIN teams t ON t.id = j.team_id JOIN cmd_orders o ON o.id = j.order_id
       LEFT JOIN tournaments tr ON tr.id = j.tournament_id
      WHERE j.game_date BETWEEN date(?, '-1 day') AND date(?, '+1 day')`
  ).all(gameDate, gameDate);
  const out = [];
  for (const j of rows) {
    if (j.id === excludeJobId) continue;
    const sameTeam = teamIds.includes(j.team_id);
    const otherSide = !sameTeam && opponentTeamIds.includes(j.team_id) && similarLabel(teamLabel, j.opponent_label) >= 0.5;
    if (!sameTeam && !otherSide) continue;
    const reasons = [sameTeam ? 'same team' : 'the opponent’s job for this game'];
    let score = sameTeam ? 50 : 20;
    if (j.game_date === gameDate) { score += 30; reasons.push('same date'); } else { score += 10; reasons.push('a day apart'); }
    if (sameTeam && opponent && similarLabel(opponent, j.opponent_label) >= 0.5) { score += 20; reasons.push('same opponent'); }
    if (event && (similarLabel(event, j.event_label) >= 0.5 || similarLabel(event, j.tournament_name) >= 0.5)) { score += 15; reasons.push('same event'); }
    out.push({ ...j, synthetic: !!j.synthetic, other_side: otherSide, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function tournamentGameCandidates(db, { teamIds = [], gameDate = null, limit = 5 } = {}) {
  if (!gameDate || !teamIds.length) return [];
  const marks = teamIds.map(() => '?').join(',');
  return db.prepare(
    `SELECT tg.id, tg.tournament_id, tg.game_date, tg.game_time, tg.field, tr.name AS tournament_name,
            ht.name AS home_team_name, at.name AS away_team_name, he.team_id AS home_team_id, ae.team_id AS away_team_id
       FROM tournament_games tg
       JOIN tournaments tr ON tr.id = tg.tournament_id
       JOIN tournament_entries he ON he.id = tg.home_entry_id JOIN teams ht ON ht.id = he.team_id
       JOIN tournament_entries ae ON ae.id = tg.away_entry_id JOIN teams at ON at.id = ae.team_id
      WHERE tg.game_date = ? AND (he.team_id IN (${marks}) OR ae.team_id IN (${marks}))
      ORDER BY tg.game_time LIMIT ?`
  ).all(gameDate, ...teamIds, ...teamIds, limit);
}

// Two families (or a family and a coach) sending the same game.
export function submissionDuplicates(db, sub, { limit = 5 } = {}) {
  if (!sub.game_date) return [];
  const rows = db.prepare(
    `SELECT s.id, s.public_id, s.status, s.team_id, s.team_label, s.opponent_label, s.game_date, s.job_id, s.account_id,
            a.first_name, a.last_name, a.role
       FROM intake_submissions s JOIN customer_accounts a ON a.id = s.account_id
      WHERE s.id != ? AND s.game_date = ? AND s.status NOT IN ('draft', 'closed', 'declined')`
  ).all(sub.id, sub.game_date);
  return rows.filter(r => (sub.team_id && r.team_id === sub.team_id) || similarLabel(sub.team_label, r.team_label) >= 0.5)
    .slice(0, limit)
    .map(r => ({ ...r, same_account: r.account_id === sub.account_id }));
}

// ── Contacts ("verified email or normalized phone match") ───────────────
export function contactDuplicates(db, account) {
  const out = [];
  if (account.phone_normalized) {
    for (const r of db.prepare('SELECT id, email, first_name, last_name, role FROM customer_accounts WHERE phone_normalized = ? AND id != ?').all(account.phone_normalized, account.id)) {
      out.push({ kind: 'customer_account', id: r.id, label: `${r.first_name} ${r.last_name} <${r.email}>`, reason: 'same phone number' });
    }
  }
  const fn = normalizeName(account.first_name); const ln = normalizeName(account.last_name);
  if (fn && ln) {
    for (const r of db.prepare('SELECT id, email, first_name, last_name FROM customer_accounts WHERE id != ?').all(account.id)) {
      if (normalizeName(r.first_name) === fn && normalizeName(r.last_name) === ln && !out.some(o => o.id === r.id)) {
        out.push({ kind: 'customer_account', id: r.id, label: `${r.first_name} ${r.last_name} <${r.email}>`, reason: 'same name' });
      }
    }
  }
  const staff = db.prepare('SELECT id, name FROM staff_users WHERE email = ?').get(account.email);
  if (staff) out.push({ kind: 'staff_user', id: staff.id, label: `Coach/director login — ${staff.name || account.email}`, reason: 'same email (linked login)' });
  const player = db.prepare(
    'SELECT pu.id, p.first_name, p.last_name, p.id AS player_id FROM player_users pu JOIN players p ON p.id = pu.player_id WHERE pu.email = ?'
  ).get(account.email);
  if (player) out.push({ kind: 'player_user', id: player.id, player_id: player.player_id, label: `Player portal — ${player.first_name} ${player.last_name}`, reason: 'same email (linked login)' });
  return out;
}

// ── Files ("file hash or same upload session") ──────────────────────────
export function fileDuplicates(db, file) {
  if (!file.content_hash || !file.size_bytes) return { intake: [], command: [] };
  const intake = db.prepare(
    `SELECT f.id, f.submission_id, f.account_id, s.public_id, f.original_name
       FROM intake_files f JOIN intake_submissions s ON s.id = f.submission_id
      WHERE f.content_hash = ? AND f.size_bytes = ? AND f.id != ? AND f.status NOT IN ('deleted', 'archived')`
  ).all(file.content_hash, file.size_bytes, file.id ?? -1);
  // Not the feed this very file became, and not a feed already deleted.
  const command = db.prepare(
    `SELECT id AS feed_id, job_id, label, original_name FROM cmd_video_feeds
      WHERE content_hash = ? AND size_bytes = ? AND id != ? AND COALESCE(intake_file_id, -1) != ? AND status != 'deleted'`
  ).all(file.content_hash, file.size_bytes, file.feed_id ?? -1, file.id ?? -1);
  return { intake, command };
}
