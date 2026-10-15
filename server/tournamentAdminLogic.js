// Tournament admin corrections — pure rules, no database. Admins fix event
// data in place (server/tournamentAdminRoutes.js): edit the event, its
// divisions, team entries and games; move an entry to another division; and
// withdraw, archive or delete records. Shared teams and player profiles are
// not event records, so nothing here ever removes them.

// A game's bracket stage, separate from its age division.
export const GAME_STAGES = { pool: 'Pool Play', gold: 'Gold', silver: 'Silver', single: 'Single Bracket' };
export const GAME_STAGE_KEYS = Object.keys(GAME_STAGES);
export const GAME_STATUSES = ['scheduled', 'final', 'canceled'];
export const ENTRY_STATUSES = ['active', 'withdrawn', 'archived'];
export const RECORD_KINDS = ['tournament', 'division', 'entry', 'game'];
export const stageLabel = key => (Object.hasOwn(GAME_STAGES, key || '') ? GAME_STAGES[key] : '');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// The public URL piece of a tournament (/tournaments/<slug>).
export function slugProblem(slug) {
  if (!slug) return 'Enter the URL.';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return 'Use lowercase letters, numbers and single hyphens in the URL.';
  if (slug.length < 3 || slug.length > 80) return 'Use 3 to 80 characters in the URL.';
  return null;
}

const text = value => (value == null ? '' : String(value).trim());

// '' and null clear the value; anything else must be a whole number >= min.
function wholeNumber(value, label, min) {
  if (value === '' || value == null) return { value: null };
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < min) return { error: `${label} must be a whole number${min > 0 ? ` of ${min} or more` : ' (0 or more)'}.` };
  return { value: n };
}

function id(value, label) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? { value: n } : { error: `Choose ${label}.` };
}

function capped(value, label, limit) {
  const v = text(value);
  return [...v].length > limit ? { error: `Shorten ${label} to ${limit} characters or fewer.` } : { value: v };
}

// Runs each present field's reader; the first error wins.
function readPatch(body, readers) {
  const value = {};
  for (const [key, read] of Object.entries(readers)) {
    if (!body || !Object.hasOwn(body, key)) continue;
    const r = read(body[key]);
    if (r.error) return { error: r.error };
    value[key] = r.value;
  }
  return Object.keys(value).length ? { value } : { error: 'Nothing to change.' };
}

const flag = v => ({ value: v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0 });

export function readTournamentPatch(body, current) {
  const r = readPatch(body, {
    name: v => (text(v) ? capped(v, 'the name', 200) : { error: 'The tournament needs a name.' }),
    start_date: v => (isIsoDate(v) ? { value: v } : { error: 'Enter the start date as YYYY-MM-DD.' }),
    end_date: v => (isIsoDate(v) ? { value: v } : { error: 'Enter the end date as YYYY-MM-DD.' }),
    location: v => capped(v, 'the location', 200),
    organizer: v => capped(v, 'the organizer', 200),
    logo_url: v => capped(v, 'the logo URL', 500),
    visibility: v => (v === 'public' || v === 'private' ? { value: v } : { error: 'Visibility is public or private.' }),
    published: flag,
    archived: flag,
    slug: v => {
      const slug = text(v).toLowerCase();
      const problem = slugProblem(slug);
      return problem ? { error: problem } : { value: slug };
    },
  });
  if (r.error) return r;
  const start = r.value.start_date ?? current?.start_date;
  const end = r.value.end_date ?? current?.end_date;
  if (start && end && end < start) return { error: 'The end date is before the start date.' };
  return r;
}

export function readDivisionPatch(body) {
  return readPatch(body, {
    name: v => (text(v) ? capped(v, 'the division name', 80) : { error: 'The division needs a name.' }),
    age_group: v => capped(v, 'the age group', 20),
    level: v => capped(v, 'the level', 40),
  });
}

export function readEntryPatch(body) {
  return readPatch(body, {
    seed: v => wholeNumber(v, 'Seed', 1),
    pool: v => capped(v, 'the pool', 40),
    placement: v => capped(v, 'the placement', 60),
    wins: v => wholeNumber(v, 'Wins', 0),
    losses: v => wholeNumber(v, 'Losses', 0),
    status: v => (ENTRY_STATUSES.includes(v) ? { value: v } : { error: `Status is one of ${ENTRY_STATUSES.join(', ')}.` }),
  });
}

export function readGamePatch(body) {
  const r = readPatch(body, {
    game_date: v => (isIsoDate(v) ? { value: v } : { error: 'Enter the game date as YYYY-MM-DD.' }),
    game_time: v => (text(v) === '' || TIME.test(text(v)) ? { value: text(v) } : { error: 'Enter the time as HH:MM (24-hour).' }),
    field: v => capped(v, 'the field', 80),
    home_score: v => wholeNumber(v, 'The home score', 0),
    away_score: v => wholeNumber(v, 'The away score', 0),
    status: v => (GAME_STATUSES.includes(v) ? { value: v } : { error: `Status is one of ${GAME_STATUSES.join(', ')}.` }),
    stage: v => (v === '' || v == null ? { value: null }
      : GAME_STAGE_KEYS.includes(v) ? { value: v } : { error: `Stage is one of ${Object.values(GAME_STAGES).join(', ')}.` }),
    division_id: v => id(v, 'a division'),
    home_entry_id: v => id(v, 'the home team'),
    away_entry_id: v => id(v, 'the away team'),
  });
  if (r.error) return r;
  if (r.value.home_entry_id && r.value.home_entry_id === r.value.away_entry_id) return { error: 'A team cannot play itself.' };
  return r;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// The verb and pronoun that agree with a count: agree(1, 'lists', 'list').
const agree = (n, one, many) => (n === 1 ? one : many);

// What an action would do to a record and what stops it, from counts the
// store gathers. Each action: { allowed, blockers, effects, warnings }.
// blockers stop the action; warnings need a deliberate confirm.
export function assessRecord(kind, c) {
  const act = (blockers, effects, warnings = []) => ({ allowed: blockers.length === 0, blockers, effects, warnings });
  const keeps = 'Shared teams and player profiles are kept.';
  if (kind === 'tournament') {
    const blockers = [];
    if (c.command_jobs) blockers.push(`${plural(c.command_jobs, 'Command job')} ${agree(c.command_jobs, 'analyzes', 'analyze')} this event. Archive it instead.`);
    if (c.player_games) blockers.push(`${plural(c.player_games, 'player stat line')} ${agree(c.player_games, 'is', 'are')} linked to its games. Archive it instead.`);
    if (c.intake_submissions) blockers.push(`${plural(c.intake_submissions, 'footage submission')} ${agree(c.intake_submissions, 'points', 'point')} at its games. Archive it instead.`);
    const removes = [
      c.divisions && plural(c.divisions, 'division'), c.entries && plural(c.entries, 'team entry', 'team entries'),
      c.games && plural(c.games, 'game'), c.roster_rows && plural(c.roster_rows, 'event-roster player'),
      c.appearances && plural(c.appearances, 'lineup appearance'),
    ].filter(Boolean);
    return {
      archive: act([], ['Hidden from the public dashboard and team pages until restored.']),
      delete: act(blockers, [removes.length ? `Removes ${removes.join(', ')}.` : 'Removes the empty event.', keeps, 'Restorable from Recently deleted.'],
        c.final_games ? [`${plural(c.final_games, 'final score')} ${agree(c.final_games, 'is', 'are')} removed with it.`] : []),
    };
  }
  if (kind === 'division') {
    const blockers = [];
    if (c.entries) blockers.push(`${plural(c.entries, 'team entry', 'team entries')} — move ${agree(c.entries, 'it', 'them')} first.`);
    if (c.games) blockers.push(`${plural(c.games, 'game')} — move ${agree(c.games, 'it', 'them')} first.`);
    return { delete: act(blockers, ['Removes the division.']) };
  }
  if (kind === 'entry') {
    const scheduled = c.scheduled_games
      ? [`${plural(c.scheduled_games, 'scheduled game')} still ${agree(c.scheduled_games, 'lists', 'list')} this team — cancel or reassign ${agree(c.scheduled_games, 'it', 'them')}.`]
      : [];
    const deleteBlockers = [];
    if (c.games) deleteBlockers.push(`${plural(c.games, 'game')} ${agree(c.games, 'lists', 'list')} this team${c.archived_games ? ' (archived ones included)' : ''} — delete or reassign ${agree(c.games, 'it', 'them')} first, or withdraw the team.`);
    if (c.appearances && !c.games) deleteBlockers.push(`${plural(c.appearances, 'lineup appearance')} ${agree(c.appearances, 'references', 'reference')} this entry.`);
    return {
      withdraw: act([], ['Stays on the event with its roster and results, marked withdrawn.'], scheduled),
      archive: act(c.active_games ? [`${plural(c.active_games, 'game')} on the schedule ${agree(c.active_games, 'lists', 'list')} this team — archive or reassign ${agree(c.active_games, 'it', 'them')} first, or withdraw the team.`] : [],
        ['Hidden from the dashboard and standings; its event roster is kept.']),
      delete: act(deleteBlockers, [
        c.roster_rows ? `Removes the entry and its ${plural(c.roster_rows, 'event-roster player')}.` : 'Removes the entry.',
        keeps, 'Restorable from Recently deleted.',
      ]),
    };
  }
  if (kind === 'game') {
    const blockers = [];
    if (c.command_jobs) blockers.push(`${plural(c.command_jobs, 'Command job')} ${agree(c.command_jobs, 'analyzes', 'analyze')} this game. Archive it instead.`);
    if (c.player_games) blockers.push(`${plural(c.player_games, 'player stat line')} ${agree(c.player_games, 'is', 'are')} linked to it. Archive it instead.`);
    if (c.intake_submissions) blockers.push(`${plural(c.intake_submissions, 'footage submission')} ${agree(c.intake_submissions, 'points', 'point')} at it. Archive it instead.`);
    return {
      archive: act([], ['Hidden from the schedule and standings until restored.']),
      delete: act(blockers, [
        c.appearances ? `Removes the game and its ${plural(c.appearances, 'lineup appearance')}.` : 'Removes the game.',
        'Restorable from Recently deleted.',
      ], c.has_score ? ['Its score is removed with it.'] : []),
    };
  }
  throw new Error(`Unknown record kind: ${kind}`);
}
