// Aggregate engine for Team / Season / Tournament dashboards (Phase 4).
//
// Ground rules (requirements + roadmap):
//  - Every number derives from underlying game/stat_entries records. Player
//    overall ratings are NEVER averaged into a team or tournament rating.
//  - Tournament attribution goes through event rosters; season/team
//    attribution goes through dated roster memberships covering the game day.
//  - Unknown values stay null — a missing metric is absent, not zero.
//  - Sample sizes ride along with every aggregate; results under the
//    configurable minimums are labeled limited, not hidden.
//  - Pro Day / athletic testing games stay out of game-performance totals
//    unless explicitly requested.
//  - Rankings reuse the Pro Day event-relative approach (position-group
//    cohorts, percentile → 40-95 scale) — see ratingEngine.eventRelativeRating.
import { METRICS, positionGroup } from './metricCatalog.js';
import { eventRelativeRating } from './ratingEngine.js';
import { membershipCoversDate } from './rosterLogic.js';

export const AGG_VERSION = 'DM_AGG_V1';

// Configurable qualification minimums (overridable per request).
export const DEFAULT_MINS = { pa: 6, ip: 3, samples: 2 };

// Game types that count as game performance. Pro Day and athletic testing
// remain separate by default (§ ranking/data rules).
export const TESTING_TYPES = ['pro_day', 'athletic_testing'];

const MEASURED = METRICS.filter(m => m.category !== 'box');
const metricByKey = new Map(METRICS.map(m => [m.key, m]));

// ── Attribution ──────────────────────────────────────────────────────────

// All of a team's attributed player-games. A game belongs to the team when
// the player's dated membership covered the game day (season/team view), or
// when the player was on the team's event roster and the game fell inside
// the tournament window (tournament view).
export function attributedGames(db, team, filters = {}) {
  const memberships = db.prepare('SELECT * FROM roster_memberships WHERE team_id = ?').all(team.id);

  let allowedPlayerIds = null;         // null = derive from memberships per game date
  let window = null;                   // {from, to} date window
  let guestIds = new Set();

  if (filters.entry) {                 // tournament context: event roster decides
    const rows = db.prepare('SELECT * FROM event_rosters WHERE entry_id = ?').all(filters.entry.id);
    allowedPlayerIds = new Set(rows.map(r => r.player_id));
    guestIds = new Set(rows.filter(r => r.is_guest).map(r => r.player_id));
    window = { from: filters.entry.start_date, to: filters.entry.end_date };
  }

  const seasonRow = filters.seasonId
    ? db.prepare('SELECT * FROM seasons WHERE id = ?').get(filters.seasonId)
    : null;

  const candidateIds = allowedPlayerIds
    ? [...allowedPlayerIds]
    : [...new Set(memberships.map(m => m.player_id))];
  if (candidateIds.length === 0) return [];

  const players = new Map(
    db.prepare(`SELECT id, first_name, last_name, slug, is_public, grad_year, primary_position, secondary_position
                FROM players WHERE id IN (${candidateIds.map(() => '?').join(',')})`)
      .all(...candidateIds).map(p => [p.id, p])
  );

  const gameRows = db.prepare(
    `SELECT g.*, p.id AS pid FROM games g JOIN players p ON p.id = g.player_id
     WHERE g.player_id IN (${candidateIds.map(() => '?').join(',')})
     ORDER BY g.game_date`
  ).all(...candidateIds);

  const gameIds = gameRows.map(g => g.id);
  const statRows = gameIds.length
    ? db.prepare(`SELECT game_id, metric_key, value FROM stat_entries
                  WHERE excluded = 0 AND game_id IN (${gameIds.map(() => '?').join(',')})`).all(...gameIds)
    : [];
  const statsByGame = new Map();
  for (const s of statRows) {
    if (!statsByGame.has(s.game_id)) statsByGame.set(s.game_id, {});
    statsByGame.get(s.game_id)[s.metric_key] = s.value;
  }

  const types = filters.gameTypes?.length ? filters.gameTypes : null;
  const out = [];
  for (const g of gameRows) {
    if (types ? !types.includes(g.game_type) : TESTING_TYPES.includes(g.game_type)) continue;
    if (window && (g.game_date < window.from || g.game_date > window.to)) continue;
    if (filters.from && g.game_date < filters.from) continue;
    if (filters.to && g.game_date > filters.to) continue;
    if (filters.playerId && g.player_id !== Number(filters.playerId)) continue;
    if (filters.opponent && !(g.opponent || '').toLowerCase().includes(filters.opponent.toLowerCase())) continue;

    if (allowedPlayerIds) {
      if (!allowedPlayerIds.has(g.player_id)) continue;
    } else {
      // membership must cover the game day; season filter narrows to that
      // season's memberships (window falls back to the season dates).
      const mine = memberships.filter(m => m.player_id === g.player_id);
      const inSeason = filters.seasonId ? mine.filter(m => m.season_id === Number(filters.seasonId)) : mine;
      if (!inSeason.some(m => membershipCoversDate(m, g.game_date))) continue;
      if (seasonRow && (g.game_date < seasonRow.start_date || g.game_date > seasonRow.end_date)) continue;
    }

    const p = players.get(g.player_id);
    if (!p) continue;
    if (filters.position && positionGroup(p.primary_position) !== filters.position) continue;
    out.push({
      game_id: g.id, player_id: g.player_id, game_date: g.game_date, game_type: g.game_type,
      opponent: g.opponent, stats: statsByGame.get(g.id) || {},
      player: {
        id: p.id, first_name: p.first_name, last_name: p.last_name,
        slug: p.is_public ? p.slug : null, grad_year: p.grad_year,
        position: p.primary_position || '', position_group: positionGroup(p.primary_position),
        isGuest: guestIds.has(g.player_id),
      },
    });
  }
  return out;
}

// ── Box-score sums + derived rate stats (null-preserving) ────────────────

export function sumBox(games) {
  const sums = {};
  const present = key => games.some(g => g.stats[key] != null);
  for (const m of METRICS.filter(x => x.category === 'box')) {
    if (!present(m.key)) { sums[m.key] = null; continue; }
    sums[m.key] = games.reduce((acc, g) => acc + (g.stats[m.key] ?? 0), 0);
  }
  return sums;
}

const div = (num, den) => (num == null || den == null || den === 0 ? null : num / den);

// Rate stats derived strictly from box sums; every input that is unknown
// keeps the output null rather than pretending it's zero.
export function deriveRates(box) {
  const singles = box.bs_h != null
    ? box.bs_h - (box.bs_2b ?? 0) - (box.bs_3b ?? 0) - (box.bs_hr ?? 0)
    : null;
  const tb = singles == null ? null : singles + 2 * (box.bs_2b ?? 0) + 3 * (box.bs_3b ?? 0) + 4 * (box.bs_hr ?? 0);
  const obpNum = box.bs_h == null && box.bs_bb == null && box.bs_hbp == null
    ? null
    : (box.bs_h ?? 0) + (box.bs_bb ?? 0) + (box.bs_hbp ?? 0);
  return {
    avg: div(box.bs_h, box.bs_ab),
    obp: div(obpNum, box.bs_pa),
    slg: div(tb, box.bs_ab),
    ops: div(obpNum, box.bs_pa) != null && div(tb, box.bs_ab) != null
      ? div(obpNum, box.bs_pa) + div(tb, box.bs_ab)
      : null,
    k_bb: div(box.bs_k, box.bs_bb),                 // hitting strikeouts per walk
    k_bb_pitching: div(box.bs_kp, box.bs_bba),      // pitching K per BB
    runs_scored: box.bs_r, runs_allowed: box.bs_ra,
    stolen_bases: box.bs_sb, errors: box.bs_e,
    pa: box.bs_pa, ab: box.bs_ab, ip: box.bs_ip,
  };
}

// ── Measured-metric rollups per catalog aggregate rules ──────────────────

export function aggregateMeasured(games, categories = null) {
  const out = {};
  for (const m of MEASURED) {
    if (categories && !categories.includes(m.category)) continue;
    const values = games.map(g => g.stats[m.key]).filter(v => v != null);
    if (!values.length) { out[m.key] = { value: null, sample: 0 }; continue; }
    let value;
    if (m.aggregate === 'max') value = m.lowerIsBetter ? Math.min(...values) : Math.max(...values);
    else if (m.aggregate === 'latest') value = values[values.length - 1];
    else value = values.reduce((a, b) => a + b, 0) / values.length;   // avg
    out[m.key] = { value, sample: values.length };
  }
  return out;
}

// ── Per-player aggregation over attributed games ─────────────────────────

export function aggregateByPlayer(attributed) {
  const byPlayer = new Map();
  for (const row of attributed) {
    if (!byPlayer.has(row.player_id)) byPlayer.set(row.player_id, { player: row.player, games: [] });
    byPlayer.get(row.player_id).games.push(row);
  }
  return [...byPlayer.values()].map(({ player, games }) => {
    const box = sumBox(games);
    return {
      player,
      games_played: games.length,
      box,
      rates: deriveRates(box),
      measured: aggregateMeasured(games),
    };
  });
}

// ── Standings from shared tournament games (finals only) ─────────────────

export function standings(db, tournamentId) {
  const entries = db.prepare(
    `SELECT te.*, t.name AS team_name, t.slug AS team_slug, d.name AS division_name
     FROM tournament_entries te JOIN teams t ON t.id = te.team_id JOIN divisions d ON d.id = te.division_id
     WHERE te.tournament_id = ? AND te.status != 'archived'`
  ).all(tournamentId);
  const games = db.prepare('SELECT * FROM tournament_games WHERE tournament_id = ?').all(tournamentId);

  const rows = entries.map(e => {
    const mine = games.filter(g => g.home_entry_id === e.id || g.away_entry_id === e.id);
    const finals = mine.filter(g => g.status === 'final' && g.home_score != null && g.away_score != null);
    let w = 0, l = 0, t = 0, rs = 0, ra = 0;
    for (const g of finals) {
      const home = g.home_entry_id === e.id;
      const [f, a] = home ? [g.home_score, g.away_score] : [g.away_score, g.home_score];
      rs += f; ra += a;
      if (f > a) w++; else if (f < a) l++; else t++;
    }
    const played = finals.length;
    return {
      entry_id: e.id, division_id: e.division_id, division_name: e.division_name,
      team_name: e.team_name, team_slug: e.team_slug,
      seed: e.seed, pool: e.pool, placement: e.placement,
      wins: w, losses: l, ties: t,
      win_pct: played ? (w + 0.5 * t) / played : null,      // null until a final exists
      runs_scored: played ? rs : null,
      runs_allowed: played ? ra : null,
      run_diff: played ? rs - ra : null,
      games_final: played, games_total: mine.length,
    };
  });
  rows.sort((a, b) =>
    a.division_name.localeCompare(b.division_name)
    || (b.win_pct ?? -1) - (a.win_pct ?? -1)
    || (b.run_diff ?? -Infinity) - (a.run_diff ?? -Infinity)
    || (a.seed ?? 99) - (b.seed ?? 99));
  return rows;
}

// ── Leaderboards ─────────────────────────────────────────────────────────

// Headline metric per category, first with data wins. sample: how the row's
// volume is measured for the qualification minimum.
const BOARD_SPECS = {
  hitting: [
    { key: 'ops', derived: true, label: 'OPS', decimals: 3, sample: 'pa', min: 'pa' },
    { key: 'avg', derived: true, label: 'AVG', decimals: 3, sample: 'pa', min: 'pa' },
    { key: 'avg_exit_velo', label: 'Average Exit Velocity', sample: 'games', min: 'samples' },
    { key: 'max_exit_velo', label: 'Max Exit Velocity', sample: 'games', min: 'samples' },
  ],
  pitching: [
    { key: 'strike_pct', label: 'Strike %', sample: 'games', min: 'samples' },
    { key: 'k_bb_pitching', derived: true, label: 'K/BB', decimals: 2, sample: 'ip', min: 'ip' },
    { key: 'max_velo', label: 'Max Velocity', sample: 'games', min: 'samples' },
  ],
  defense: [
    { key: 'fielding_success', label: 'Fielding Success %', sample: 'games', min: 'samples' },
    { key: 'arm_strength', label: 'Arm Strength', sample: 'games', min: 'samples' },
    { key: 'throw_accuracy', label: 'Throw Accuracy', sample: 'games', min: 'samples' },
  ],
  speed: [
    { key: 'home_to_first', label: 'Home-to-First Time', sample: 'games', min: 'samples' },
    { key: 'sprint_speed', label: 'Sprint Speed', sample: 'games', min: 'samples' },
    { key: 'stolen_bases', derived: true, label: 'Stolen Bases', decimals: 0, sample: 'games', min: 'samples' },
  ],
};

function boardValue(agg, spec) {
  if (spec.derived) {
    const v = agg.rates[spec.key];
    return v == null ? null : { value: v, sample: spec.sample === 'pa' ? agg.rates.pa : spec.sample === 'ip' ? agg.rates.ip : agg.games_played };
  }
  const m = agg.measured[spec.key];
  return !m || m.value == null ? null : { value: m.value, sample: m.sample };
}

export function leaderboard(playerAggs, category, mins = DEFAULT_MINS, teamNameFor = () => null) {
  const specs = BOARD_SPECS[category] || [];
  const spec = specs.find(s => playerAggs.some(a => boardValue(a, s) != null));
  if (!spec) return { category, metric: null, rows: [] };

  const catalog = metricByKey.get(spec.key);
  const lowerIsBetter = spec.derived ? false : !!catalog?.lowerIsBetter;
  const minNeeded = mins[spec.min] ?? DEFAULT_MINS.samples;

  const rows = playerAggs
    .map(a => {
      const v = boardValue(a, spec);
      if (v == null) return null;                    // unknown stays out — never a zero
      return {
        player_id: a.player.id,
        name: `${a.player.first_name} ${a.player.last_name}`,
        slug: a.player.slug,
        team: teamNameFor(a.player.id),
        position: a.player.position, isGuest: a.player.isGuest,
        value: v.value, sample: v.sample ?? 0,
        limited: (v.sample ?? 0) < minNeeded,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.limited !== b.limited ? (a.limited ? 1 : -1)
      : lowerIsBetter ? a.value - b.value : b.value - a.value));
  rows.forEach((r, i) => { r.rank = i + 1; });

  return {
    category,
    metric: { key: spec.key, label: spec.label ?? catalog?.label, unit: spec.derived ? '' : catalog?.unit ?? '', decimals: spec.decimals ?? catalog?.decimals ?? 1, lowerIsBetter },
    min_sample: minNeeded,
    rows,
  };
}

// Overall board — the Pro Day approach applied to aggregated game metrics:
// each present metric is rated event-relative (percentile → 40-95) within
// the player's position-group cohort (falling back to the whole field when
// the group is too small), and the overall is the mean of those ratings.
// This never touches stored player overall ratings.
export function overallLeaderboard(playerAggs, mins = DEFAULT_MINS, teamNameFor = () => null) {
  const RATE_KEYS = [
    { key: 'ops', derived: true }, { key: 'avg_exit_velo' }, { key: 'max_exit_velo' },
    { key: 'hard_hit_pct' }, { key: 'contact_pct' },
    { key: 'strike_pct' }, { key: 'max_velo' },
    { key: 'arm_strength' }, { key: 'throw_accuracy' }, { key: 'fielding_success' },
    { key: 'sprint_speed' }, { key: 'home_to_first' },
  ];
  const valueOf = (a, rk) => rk.derived ? a.rates[rk.key] : a.measured[rk.key]?.value ?? null;

  const cohortFor = a => {
    const group = playerAggs.filter(x => x.player.position_group === a.player.position_group);
    return group.length >= 2 ? group : playerAggs;
  };

  const rows = playerAggs.map(a => {
    const cohort = cohortFor(a);
    const rated = [];
    for (const rk of RATE_KEYS) {
      const v = valueOf(a, rk);
      if (v == null) continue;
      const all = cohort.map(x => valueOf(x, rk)).filter(x => x != null);
      const lower = !rk.derived && !!metricByKey.get(rk.key)?.lowerIsBetter;
      const r = eventRelativeRating(v, all, lower);
      if (r != null) rated.push(r.rating);
    }
    if (rated.length < 3) return null;               // not enough signal to rank overall
    return {
      player_id: a.player.id,
      name: `${a.player.first_name} ${a.player.last_name}`,
      slug: a.player.slug,
      team: teamNameFor(a.player.id),
      position: a.player.position, position_group: a.player.position_group, isGuest: a.player.isGuest,
      value: Math.round(rated.reduce((x, y) => x + y, 0) / rated.length),
      sample: a.games_played, metrics_rated: rated.length,
      limited: a.games_played < (mins.samples ?? DEFAULT_MINS.samples),
    };
  }).filter(Boolean)
    .sort((a, b) => (a.limited !== b.limited ? (a.limited ? 1 : -1) : b.value - a.value));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return {
    category: 'overall',
    metric: { key: 'event_overall', label: 'Event Overall', unit: '', decimals: 0, lowerIsBetter: false },
    note: 'Event-relative rating from aggregated game metrics (position-group percentiles) — not an average of Pro Day overalls.',
    min_sample: mins.samples ?? DEFAULT_MINS.samples,
    rows,
  };
}

// ── Team-level category blocks (pooled from the same attributed games) ───

export function teamCategoryBlocks(attributed) {
  const box = sumBox(attributed);
  const rates = deriveRates(box);
  const measured = aggregateMeasured(attributed);
  const stat = (key, label, value, { unit = '', decimals = 1, sample = null } = {}) =>
    ({ key, label, value, unit, decimals, sample });
  const m = (key, overrides = {}) => {
    const c = metricByKey.get(key);
    return stat(key, c.label, measured[key].value, { unit: c.unit, decimals: c.decimals, sample: measured[key].sample, ...overrides });
  };
  return {
    hitting: [
      stat('avg', 'Batting Average', rates.avg, { decimals: 3, sample: rates.pa }),
      stat('obp', 'OBP', rates.obp, { decimals: 3, sample: rates.pa }),
      stat('slg', 'SLG', rates.slg, { decimals: 3, sample: rates.ab }),
      stat('ops', 'OPS', rates.ops, { decimals: 3, sample: rates.pa }),
      stat('k_bb', 'K/BB', rates.k_bb, { decimals: 2, sample: rates.pa }),
      m('hard_hit_pct'), m('avg_exit_velo'), m('max_exit_velo'),
      m('pull_pct'), m('middle_pct'), m('oppo_pct'),
    ],
    pitching: [
      m('strike_pct'), m('whiff_pct'),
      stat('k_bb_pitching', 'K/BB', rates.k_bb_pitching, { decimals: 2, sample: rates.ip }),
      m('max_velo'), m('avg_velo'), m('command_score'),
    ],
    defense_running: [
      m('fielding_success'),
      stat('errors', 'Errors', rates.errors, { decimals: 0 }),
      m('arm_strength'), m('throw_accuracy'),
      m('home_to_first'), m('sprint_speed'),
      stat('stolen_bases', 'Stolen Bases', rates.stolen_bases, { decimals: 0 }),
    ],
  };
}

// ── Trends (season view): per-date series for a metric ───────────────────

export function trendSeries(attributed, metricKey) {
  const catalog = metricByKey.get(metricKey);
  const byDate = new Map();
  for (const g of attributed) {
    const v = g.stats[metricKey];
    if (v == null) continue;
    if (!byDate.has(g.game_date)) byDate.set(g.game_date, []);
    byDate.get(g.game_date).push(v);
  }
  return [...byDate.entries()]
    .map(([date, values]) => ({
      date,
      value: catalog?.aggregate === 'sum'
        ? values.reduce((a, b) => a + b, 0)
        : values.reduce((a, b) => a + b, 0) / values.length,
      n: values.length,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function calcStamp(mins = DEFAULT_MINS) {
  return { version: AGG_VERSION, calculated_at: new Date().toISOString(), mins };
}
