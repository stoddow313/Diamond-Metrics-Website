// Event registration — pure rules, no database and no Stripe. An event (a Pro
// Day, showcase or camp) has one public sign-up page; a registration is saved
// before the parent pays, and the Stripe Checkout our server starts for it
// carries its id, so the payment needs no matching afterwards. Set up in
// Command → Events (docs/COMMAND_OPS.md §3.23).
import { createHash, randomInt } from 'node:crypto';
import { slugProblem } from './tournamentAdminLogic.js';

export const EVENT_TYPES = { pro_day: 'Pro Day', showcase: 'Showcase', camp: 'Camp', clinic: 'Clinic', other: 'Event' };
export const EVENT_STATUSES = ['draft', 'open', 'closed', 'archived'];
// How a registration was paid. Stripe's signed webhook is the only path to 'stripe'.
export const PAYMENT_METHODS = { stripe: 'Card', cash: 'Cash', venmo: 'Venmo', other: 'Other', comp: 'Comped' };
export const BOOTH_METHODS = ['cash', 'venmo', 'other', 'comp'];

// Starting wording for a new event; each event's own text is what parents accept.
export const DEFAULT_CONSENT = 'I am the parent or legal guardian of this player. I consent to their taking part in this Diamond Metrics event, including being filmed and measured, and to Diamond Metrics using the results for their player profile and report.';
// What a coach or manager accepts when registering a whole team.
export const DEFAULT_TEAM_CONSENT = 'I am this team’s coach or manager and I register it for this Diamond Metrics event. Each player’s parent or guardian has agreed to the player taking part, including being filmed and measured, and to Diamond Metrics using the results for their player profile and report.';
export const MAX_TEAM_SIZE = 60;

const TEXT_LIMIT = 200;
const LONG_LIMIT = 2000;
const MAX_DAYS = 14;

const text = value => (typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '');
const tooLong = (label, limit) => `Shorten ${label} to ${limit.toLocaleString('en-US')} characters or fewer.`;
export const isIsoDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

// What each registration agreed to: a short hash of the exact wording.
export const consentVersion = consent => createHash('sha256').update(String(consent)).digest('hex').slice(0, 12);

// ER-XXXX-XXXX: random, never the row number, read aloud without 0/O/1/I/L/U mix-ups.
const ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newRegistrationId(rand = randomInt) {
  const block = () => Array.from({ length: 4 }, () => ID_ALPHABET[rand(ID_ALPHABET.length)]).join('');
  return `ER-${block()}-${block()}`;
}
export const isRegistrationId = v => typeof v === 'string' && /^ER-[2-9A-Z]{4}-[2-9A-Z]{4}$/.test(v);

// "Thu, Nov 6" — read from the string, never through a local-time Date.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function dayLabel(date) {
  if (!isIsoDate(date)) return String(date || '');
  const d = new Date(`${date}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
export const choiceLabel = (event, choice) => (choice === 'either' ? 'Either day' : (parseDays(event.days).find(d => d.date === choice)?.label || dayLabel(choice)));

export function parseDays(raw) {
  let days = raw;
  if (typeof raw === 'string') { try { days = JSON.parse(raw || '[]'); } catch { days = []; } }
  return (Array.isArray(days) ? days : []).filter(d => d && isIsoDate(d.date)).map(d => ({
    date: d.date, label: text(d.label) || dayLabel(d.date), capacity: Number.isInteger(d.capacity) && d.capacity > 0 ? d.capacity : null,
  }));
}

function readDays(value) {
  if (!Array.isArray(value) || value.length === 0) return { error: 'Add at least one day.' };
  if (value.length > MAX_DAYS) return { error: `An event has at most ${MAX_DAYS} days.` };
  const days = [];
  for (const d of value) {
    const date = text(d?.date);
    if (!isIsoDate(date)) return { error: 'Enter each day as YYYY-MM-DD.' };
    if (days.some(x => x.date === date)) return { error: `${dayLabel(date)} is listed twice.` };
    const label = text(d?.label);
    if ([...label].length > 60) return { error: tooLong('a day’s label', 60) };
    let capacity = null;
    if (d?.capacity !== '' && d?.capacity != null) {
      capacity = Number(d.capacity);
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10000) return { error: 'A day’s limit is a whole number of 1 or more (blank for no limit).' };
    }
    days.push({ date, ...(label ? { label } : {}), ...(capacity ? { capacity } : {}) });
  }
  return { value: days.sort((a, b) => a.date.localeCompare(b.date)) };
}

const flag = v => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
const readCents = (v, what) => {
  const cents = Number(v);
  return Number.isInteger(cents) && cents >= 100 && cents <= 1000000 ? { value: cents } : { error: `The ${what} is between $1 and $10,000.` };
};

// A team picks its division from the event's list ("8U, 10U, 12U"); with no list it types one.
export const parseDivisions = raw => [...new Set(String(raw || '').split(/[,\n]/).map(d => d.trim()).filter(Boolean))];

// What a registration costs: the price it was quoted when saved (older rows: the event's).
export const registrationPrice = (event, reg) => reg.price_cents ?? (reg.kind === 'team' ? event.team_price_cents : event.price_cents);
const optionalDate = (v, label) => (v === '' || v == null ? { value: null } : isIsoDate(v) ? { value: v } : { error: `Enter ${label} as YYYY-MM-DD.` });

// Command → Events, create or edit. Only the fields sent change; an empty
// patch is refused. consent_version follows consent_text.
export function readEventPatch(body, current = null) {
  const value = {};
  const has = k => body && Object.hasOwn(body, k);
  const field = (k, label, { required = false, limit = TEXT_LIMIT } = {}) => {
    if (!has(k)) return null;
    const v = text(body[k]);
    if (!v && required) return `Enter ${label}.`;
    if ([...v].length > limit) return tooLong(label, limit);
    value[k] = v;
    return null;
  };
  const problems = [
    field('name', 'the event name', { required: true }),
    field('location', 'the location'),
    field('description', 'the description', { limit: LONG_LIMIT }),
    field('what_to_bring', 'what to bring', { limit: LONG_LIMIT }),
    field('consent_text', 'the consent wording', { required: true, limit: LONG_LIMIT }),
    field('team_consent_text', 'the team consent wording', { limit: LONG_LIMIT }),
  ].filter(Boolean);
  if (problems.length) return { error: problems[0] };
  if (has('event_type')) {
    if (!Object.hasOwn(EVENT_TYPES, body.event_type)) return { error: 'Choose the kind of event.' };
    value.event_type = body.event_type;
  }
  if (has('days')) {
    const r = readDays(body.days);
    if (r.error) return r;
    value.days = JSON.stringify(r.value);
  }
  if (has('allow_either')) value.allow_either = flag(body.allow_either);
  if (has('listed')) value.listed = flag(body.listed);
  if (has('price_cents')) {
    const r = readCents(body.price_cents, 'price');
    if (r.error) return r;
    value.price_cents = r.value;
  }
  // Team pricing: a price turns the team option on; blank turns it off.
  if (has('team_price_cents')) {
    if (body.team_price_cents === '' || body.team_price_cents == null) value.team_price_cents = null;
    else {
      const r = readCents(body.team_price_cents, 'team price');
      if (r.error) return r;
      value.team_price_cents = r.value;
    }
  }
  if (has('team_divisions')) {
    const list = parseDivisions(body.team_divisions);
    if (list.some(d => [...d].length > 40)) return { error: tooLong('each division', 40) };
    if (list.length > 30) return { error: 'List at most 30 divisions.' };
    value.team_divisions = list.join(', ');
  }
  if (has('status')) {
    if (!EVENT_STATUSES.includes(body.status)) return { error: 'Status is draft, open, closed or archived.' };
    value.status = body.status;
  }
  for (const [k, label] of [['opens_on', 'the opening date'], ['closes_on', 'the closing date']]) {
    if (!has(k)) continue;
    const r = optionalDate(body[k], label);
    if (r.error) return r;
    value[k] = r.value;
  }
  if (has('tournament_id')) {
    const id = body.tournament_id === '' || body.tournament_id == null ? null : Number(body.tournament_id);
    if (id !== null && (!Number.isInteger(id) || id < 1)) return { error: 'Choose a tournament, or none.' };
    value.tournament_id = id;
  }
  if (has('slug')) {
    const slug = text(body.slug).toLowerCase();
    const problem = slugProblem(slug);
    if (problem) return { error: problem };
    value.slug = slug;
  }
  if (value.consent_text !== undefined) value.consent_version = consentVersion(value.consent_text);
  // A team option always has wording for the coach to accept.
  const teamOn = value.team_price_cents !== undefined ? value.team_price_cents != null : current?.team_price_cents != null;
  if (teamOn && !(value.team_consent_text !== undefined ? value.team_consent_text : current?.team_consent_text)) value.team_consent_text = DEFAULT_TEAM_CONSENT;
  if (value.team_consent_text !== undefined) value.team_consent_version = value.team_consent_text ? consentVersion(value.team_consent_text) : '';
  const opens = value.opens_on !== undefined ? value.opens_on : current?.opens_on;
  const closes = value.closes_on !== undefined ? value.closes_on : current?.closes_on;
  if (opens && closes && closes < opens) return { error: 'Registration closes before it opens.' };
  if (!current) {
    if (!value.name) return { error: 'Enter the event name.' };
    if (!value.days) return { error: 'Add at least one day.' };
    if (value.price_cents === undefined) return { error: 'Enter the price.' };
    if (!value.consent_text) {
      value.consent_text = DEFAULT_CONSENT;
      value.consent_version = consentVersion(DEFAULT_CONSENT);
    }
  }
  return Object.keys(value).length ? { value } : { error: 'Nothing to change.' };
}

// Whether the page takes registrations today, and which days have room.
// Capacity counts paid registrations for that day; "Either day" is offered
// while any day has room (staff place those players).
export function availability(event, paidByDay = {}, today = new Date().toISOString().slice(0, 10)) {
  const days = parseDays(event.days).map(d => {
    const taken = paidByDay[d.date] || 0;
    return { ...d, taken, full: d.capacity != null && taken >= d.capacity };
  });
  const last = days.at(-1)?.date || null;
  let reason = null;
  if (event.status === 'draft') reason = 'draft';
  else if (event.status === 'archived') reason = 'archived';
  else if (event.status === 'closed') reason = 'closed';
  else if (event.opens_on && today < event.opens_on) reason = 'not_open_yet';
  else if (event.closes_on && today > event.closes_on) reason = 'closed';
  else if (last && today > last) reason = 'ended';
  else if (days.length && days.every(d => d.full)) reason = 'full';
  const open = days.filter(d => !d.full);
  return {
    accepting: reason === null,
    reason,
    days,
    either: !!event.allow_either && days.length > 1 && open.length > 0,
  };
}

const CONTACT = [
  { key: 'guardianName', label: 'the parent or guardian name', required: 'Enter the parent or guardian name.' },
  { key: 'email', label: 'the email', required: 'Enter an email address.' },
  { key: 'phone', label: 'the phone number' },
  { key: 'playerName', label: 'the player name', required: 'Enter the player name.' },
  { key: 'playerTeam', label: 'the player’s team', required: 'Enter the player’s team.' },
];

// The tag a QR code carries (?src=flyer): a short word, never personal data.
export const sourceTag = v => text(v).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);

const TEAM_CONTACT = [
  { key: 'coachName', label: 'the coach or manager name', required: 'Enter the coach or manager name.' },
  { key: 'email', label: 'the email', required: 'Enter an email address.' },
  { key: 'phone', label: 'the phone number' },
  { key: 'teamName', label: 'the team name', required: 'Enter the team name.' },
];

// The day a registration asked for, if it can have it: a full day is refused,
// and a team needs room for all its players (on some day, for "Either day").
function readDay(body, avail, players = 1) {
  const days = avail.days;
  let day = text(body?.preferredDay);
  if (!day && days.length === 1) day = days[0].date;
  const left = d => (d.capacity == null ? Infinity : d.capacity - d.taken);
  if (day === 'either') {
    if (!avail.either) return { error: 'Choose a day.' };
    if (players > 1 && !days.some(d => left(d) >= players)) return { error: `No day has room for ${players} more players — call us to place your team.` };
    return { value: day };
  }
  const d = days.find(x => x.date === day);
  if (!d) return { error: 'Choose a day.' };
  if (d.full) return { error: `${d.label} is full — choose another day.` };
  if (players > 1 && left(d) < players) return { error: `${d.label} has room for ${left(d)} more players, fewer than your ${players}.` };
  return { value: day };
}

// A team registration: the coach's contact, the team, its size and division.
function validateTeam(body, event, avail) {
  if (event.team_price_cents == null) return { error: 'This event doesn’t take team registrations.' };
  const v = {};
  for (const f of TEAM_CONTACT) {
    const x = text(body?.[f.key]);
    if (!x && f.required) return { error: f.required };
    if ([...x].length > TEXT_LIMIT) return { error: tooLong(f.label, TEXT_LIMIT) };
    v[f.key] = x;
  }
  if (!/^\S+@\S+\.\S+$/.test(v.email)) return { error: 'Enter a valid email address.' };
  const size = Number(text(body?.teamSize));
  if (!text(body?.teamSize)) return { error: 'Enter the number of players.' };
  if (!Number.isInteger(size) || size < 1 || size > MAX_TEAM_SIZE) return { error: `Enter the number of players (1 to ${MAX_TEAM_SIZE}).` };
  const division = text(body?.division);
  const divisions = parseDivisions(event.team_divisions);
  if (!division) return { error: 'Choose the division or age group.' };
  if (divisions.length && !divisions.includes(division)) return { error: 'Choose one of the listed divisions.' };
  if ([...division].length > 40) return { error: tooLong('the division', 40) };
  const day = readDay(body, avail, size);
  if (day.error) return day;
  if (body?.consent !== true) return { error: 'The coach or manager must agree to the consent statement.' };
  return { value: {
    kind: 'team', guardianName: v.coachName, email: v.email, phone: v.phone, playerName: '', playerAge: null, playerTeam: v.teamName,
    teamSize: size, division, preferredDay: day.value, source: sourceTag(body?.source),
  } };
}

// The sign-up form, from the public page or the booth's walk-up form. Only
// these fields are read; a price or anything else the browser adds is ignored.
export function validateRegistration(body, event, avail = availability(event)) {
  if (body?.kind === 'team') return validateTeam(body, event, avail);
  const value = { kind: 'player' };
  for (const f of CONTACT) {
    const v = text(body?.[f.key]);
    if (!v && f.required) return { error: f.required };
    if ([...v].length > TEXT_LIMIT) return { error: tooLong(f.label, TEXT_LIMIT) };
    value[f.key] = v;
  }
  if (!/^\S+@\S+\.\S+$/.test(value.email)) return { error: 'Enter a valid email address.' };
  const age = Number(text(body?.playerAge));
  if (!text(body?.playerAge)) return { error: 'Enter the player’s age.' };
  if (!Number.isInteger(age) || age < 4 || age > 25) return { error: 'Enter the player’s age in years (4 to 25).' };
  value.playerAge = age;
  const day = readDay(body, avail);
  if (day.error) return day;
  value.preferredDay = day.value;
  if (body?.consent !== true) return { error: 'The parent or guardian must agree to the consent statement.' };
  value.source = sourceTag(body?.source);
  return { value };
}

// What the public page may show: no counts beyond "full", no ids.
export function publicEvent(event, avail, extras = {}) {
  return {
    slug: event.slug, name: event.name, event_type: event.event_type, type_label: EVENT_TYPES[event.event_type] || 'Event',
    location: event.location, description: event.description, what_to_bring: event.what_to_bring,
    price_cents: event.price_cents, consent_text: event.consent_text, opens_on: event.opens_on, closes_on: event.closes_on,
    team: event.team_price_cents != null ? { price_cents: event.team_price_cents, divisions: parseDivisions(event.team_divisions), consent_text: event.team_consent_text || DEFAULT_TEAM_CONSENT, max_size: MAX_TEAM_SIZE } : null,
    days: avail.days.map(d => ({ date: d.date, label: d.label, full: d.full })),
    either: avail.either, accepting: avail.accepting, reason: avail.reason,
    ...extras,
  };
}

// The roster as CSV for a printed backup or a spreadsheet (RFC 4180 quoting;
// a leading =, +, - or @ is prefixed so a spreadsheet never runs it).
const cell = v => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function rosterCsv(event, rows) {
  const head = ['Registration', 'Type', 'Player', 'Age', 'Team', 'Players', 'Division', 'Day', 'Parent/guardian or coach', 'Email', 'Phone', 'Paid', 'Payment', 'Amount', 'Checked in', 'Walk-up', 'Source', 'Registered'];
  const lines = rows.map(r => [
    r.registration_id, r.kind === 'team' ? 'Team' : 'Player', r.player_name, r.player_age, r.player_team, r.kind === 'team' ? r.team_size : 1, r.division,
    choiceLabel(event, r.preferred_day), r.guardian_name, r.email, r.phone,
    r.status === 'paid' ? 'yes' : 'no', r.payment_method ? PAYMENT_METHODS[r.payment_method] || r.payment_method : '',
    r.amount_total != null ? (r.amount_total / 100).toFixed(2) : '', r.checked_in_at || '', r.walk_up ? 'yes' : '', r.source, r.created_at,
  ].map(cell).join(','));
  return [head.join(','), ...lines].join('\r\n') + '\r\n';
}
