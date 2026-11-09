// The giveaway's entry window and drawing date — pure rules, no database.
// They are settings (Command → Events → Giveaway), never code: the public
// page, the official rules and the entry route all read the same row.
// Times are stored as UTC instants and set and shown in Mountain time, the
// time zone the official rules state.
export const GIVEAWAY_TZ = 'America/Denver';

const pad = n => String(n).padStart(2, '0');
const isLocal = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v);
export const isIsoDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
  && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

// The wall-clock parts of an instant in a time zone.
function partsIn(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

// "2026-11-06T07:00" in Mountain time → the UTC instant (ISO). Daylight time
// is handled by asking Intl for the zone's offset at that moment.
export function zonedToUtc(local, tz = GIVEAWAY_TZ) {
  if (!isLocal(local)) return null;
  const [date, time] = local.split('T');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  if (Number.isNaN(asUtc)) return null;
  let guess = asUtc;
  for (let i = 0; i < 3; i++) {
    const p = partsIn(guess, tz);
    const shown = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    guess += asUtc - shown;
  }
  return new Date(guess).toISOString();
}

// The UTC instant → "2026-11-06T07:00" in Mountain time, for the setup form.
export function utcToZoned(iso, tz = GIVEAWAY_TZ) {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const p = partsIn(ms, tz);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

// Whether entries are taken now. No opening time means open now; no closing
// time means no end.
export function windowState(settings, now = Date.now()) {
  const opens = settings?.opens_at ? Date.parse(settings.opens_at) : null;
  const closes = settings?.closes_at ? Date.parse(settings.closes_at) : null;
  if (opens != null && now < opens) return { accepting: false, reason: 'not_open_yet' };
  if (closes != null && now >= closes) return { accepting: false, reason: 'ended' };
  return { accepting: true, reason: null };
}

// Command → Giveaway → Save: { opens_local, closes_local, drawing_on }, each
// optional, a blank one clearing it.
export function readSettingsPatch(body = {}) {
  const value = {};
  for (const [key, column, label] of [['opens_local', 'opens_at', 'the opening time'], ['closes_local', 'closes_at', 'the closing time']]) {
    if (!Object.hasOwn(body, key)) continue;
    const raw = typeof body[key] === 'string' ? body[key].trim() : '';
    if (!raw) { value[column] = null; continue; }
    const iso = zonedToUtc(raw);
    if (!iso) return { error: `Enter ${label} as a date and time.` };
    value[column] = iso;
  }
  if (Object.hasOwn(body, 'drawing_on')) {
    const raw = typeof body.drawing_on === 'string' ? body.drawing_on.trim() : '';
    if (raw && !isIsoDate(raw)) return { error: 'Enter the drawing date as a date.' };
    value.drawing_on = raw || null;
  }
  return Object.keys(value).length ? { value } : { error: 'Nothing to change.' };
}

// The window after a patch must still close after it opens.
export function windowProblem(settings) {
  if (settings.opens_at && settings.closes_at && Date.parse(settings.closes_at) <= Date.parse(settings.opens_at)) {
    return 'The giveaway must close after it opens.';
  }
  return '';
}
