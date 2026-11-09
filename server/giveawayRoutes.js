// The giveaway: the public entry form (/giveaway) and, in Command → Events →
// Giveaway, its entry window and drawing date and the entries themselves.
//
//   GET  /api/giveaway                          the window and drawing date (the page and the official rules read it)
//   POST /api/giveaway/entries                  one entry, while the window is open
//   GET  /api/giveaway/entries.csv              every entry as CSV          (admin, fulfillment)
//   GET  /api/command/giveaway                  settings, counts and entries (admin, fulfillment)
//   PUT  /api/command/giveaway/settings         { opens_local, closes_local, drawing_on } (Mountain time)
import { createHash } from 'node:crypto';
import { windowState, readSettingsPatch, windowProblem, utcToZoned } from './giveawayLogic.js';
import { log } from './observability.js';

const CONSENT_TEXT = 'By checking this box, I agree to receive promotional emails from Diamond Metrics LLC about player development insights, upcoming events, product updates, and special offers. I may unsubscribe at any time using the unsubscribe link in those emails. Unsubscribing after I enter will not affect my eligibility to win.';
const CONSENT_VERSION = createHash('sha256').update(CONSENT_TEXT).digest('hex').slice(0, 16);
const text = value => (typeof value === 'string' ? value.trim() : '');

function csvCell(value) {
  let cell = value == null ? '' : String(value);
  if (/^[=+\-@]/.test(cell)) cell = `'${cell}`;
  return /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

// "Friday, November 6, 2026 at 7:00 AM MST", in the zone the rules state.
const when = iso => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Denver', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
}).format(new Date(iso)).replace(/, (\d{1,2}:\d{2})/, ' at $1');

export function mountGiveawayRoutes(app, { db, requireInternalRole }) {
  const canManage = requireInternalRole('admin', 'fulfillment');
  const settings = () => db.prepare('SELECT opens_at, closes_at, drawing_on, updated_at FROM giveaway_settings WHERE id = 1').get()
    || { opens_at: null, closes_at: null, drawing_on: null, updated_at: null };
  const publicView = s => ({ opens_at: s.opens_at, closes_at: s.closes_at, drawing_on: s.drawing_on, ...windowState(s) });

  app.get('/api/giveaway', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ giveaway: publicView(settings()) });
  });

  app.post('/api/giveaway/entries', (req, res) => {
    const body = req.body || {};
    // Quietly accept a filled honeypot so basic form bots don't learn the check.
    if (text(body.website)) return res.status(201).json({ ok: true });

    const s = settings();
    const state = windowState(s);
    if (state.reason === 'not_open_yet') return res.status(403).json({ error: `Entries open ${when(s.opens_at)}.` });
    if (state.reason === 'ended') return res.status(403).json({ error: 'The giveaway entry period has ended.' });

    const fullName = text(body.fullName);
    const email = text(body.email).toLowerCase();
    const phone = text(body.phone);
    const marketingConsent = body.marketingConsent === true;
    if (!fullName || [...fullName].length > 120) return res.status(400).json({ error: 'Enter your full name.' });
    if (!email || [...email].length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if ([...phone].length > 40) return res.status(400).json({ error: 'Enter a phone number of 40 characters or fewer.' });
    if (body.ageConfirmed !== true) return res.status(400).json({ error: 'Confirm that you are 18 or older to enter.' });
    if (body.eligibilityConfirmed !== true) return res.status(400).json({ error: 'Confirm that you meet the eligibility requirements in the Official Rules.' });
    if (!marketingConsent) return res.status(400).json({ error: 'Check the marketing consent box to enter.' });

    const insert = db.prepare(`
      INSERT INTO giveaway_entries (
        full_name, email, phone, age_confirmed, utah_resident,
        tournament_attendance_confirmed, sponsor_eligibility_confirmed, marketing_consent, consent_version
      )
      SELECT ?, ?, ?, 1, 1, 1, 1, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM giveaway_entries WHERE lower(email) = ?)
    `).run(fullName, email, phone, marketingConsent ? 1 : 0, CONSENT_VERSION, email);
    if (insert.changes !== 1) return res.status(409).json({ error: 'Only one entry per person is allowed. This email address has already been used.' });
    return res.status(201).json({ ok: true });
  });

  app.get('/api/giveaway/entries.csv', canManage, (_req, res) => {
    const rows = db.prepare(`
      SELECT full_name, email, phone, age_confirmed, utah_resident, tournament_attendance_confirmed,
             sponsor_eligibility_confirmed,
             marketing_consent, consent_version, consented_at
      FROM giveaway_entries ORDER BY created_at, id
    `).all();
    const header = ['Full Name', 'Email Address', 'Phone Number', '18+ Confirmed', 'Utah Resident Confirmed', 'Tournament Attendance Confirmed', 'Sponsor Eligibility Confirmed', 'Marketing Consent', 'Consent Version', 'Consent Timestamp'];
    const body = rows.map(row => [
      row.full_name, row.email, row.phone, row.age_confirmed ? 'Yes' : 'No', row.utah_resident ? 'Yes' : 'No',
      row.tournament_attendance_confirmed ? 'Yes' : 'No',
      row.sponsor_eligibility_confirmed ? 'Yes' : 'No',
      row.marketing_consent ? 'Yes' : 'No', row.consent_version, row.consented_at,
    ].map(csvCell).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="diamond-metrics-giveaway-entries.csv"');
    return res.send([header.join(','), ...body].join('\r\n') + '\r\n');
  });

  app.get('/api/command/giveaway', canManage, (_req, res) => {
    const s = settings();
    const entries = db.prepare(
      'SELECT id, full_name, email, phone, marketing_consent, created_at FROM giveaway_entries ORDER BY created_at DESC, id DESC'
    ).all();
    res.json({
      giveaway: { ...publicView(s), opens_local: utcToZoned(s.opens_at), closes_local: utcToZoned(s.closes_at), updated_at: s.updated_at },
      entries,
      counts: { entries: entries.length, last_24h: entries.filter(e => Date.parse(`${e.created_at.replace(' ', 'T')}Z`) > Date.now() - 864e5).length },
    });
  });

  app.put('/api/command/giveaway/settings', canManage, (req, res) => {
    const r = readSettingsPatch(req.body || {});
    if (r.error) return res.status(400).json({ error: r.error });
    const next = { ...settings(), ...r.value };
    const problem = windowProblem(next);
    if (problem) return res.status(400).json({ error: problem });
    db.prepare(`UPDATE giveaway_settings SET opens_at = ?, closes_at = ?, drawing_on = ?, updated_at = datetime('now'), updated_by = ? WHERE id = 1`)
      .run(next.opens_at ?? null, next.closes_at ?? null, next.drawing_on ?? null, req.internal.id);
    log('info', 'giveaway_settings_changed', { by: req.internal.id, opens_at: next.opens_at, closes_at: next.closes_at, drawing_on: next.drawing_on });
    const s = settings();
    res.json({ giveaway: { ...publicView(s), opens_local: utcToZoned(s.opens_at), closes_local: utcToZoned(s.closes_at), updated_at: s.updated_at } });
  });
}
