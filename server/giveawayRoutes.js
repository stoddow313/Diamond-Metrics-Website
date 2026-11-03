import { createHash } from 'node:crypto';

const CONSENT_TEXT = 'By entering this giveaway, you agree to receive promotional emails from Diamond Metrics LLC, including player development insights, upcoming events, product updates, and special offers. You may unsubscribe at any time using the unsubscribe link in those communications without affecting your eligibility to win.';
const CONSENT_VERSION = createHash('sha256').update(CONSENT_TEXT).digest('hex').slice(0, 16);
// The rules specify MST; these fixed UTC boundaries correspond to Nov 6–7, 2026 in America/Denver.
const ENTRY_START = Date.parse('2026-11-06T14:00:00Z');
const ENTRY_END = Date.parse('2026-11-08T07:00:00Z');
const text = value => (typeof value === 'string' ? value.trim() : '');

function csvCell(value) {
  let cell = value == null ? '' : String(value);
  if (/^[=+\-@]/.test(cell)) cell = `'${cell}`;
  return /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

export function mountGiveawayRoutes(app, { db, requireAdmin }) {
  app.post('/api/giveaway/entries', (req, res) => {
    const body = req.body || {};
    // Quietly accept a filled honeypot so basic form bots don't learn the check.
    if (text(body.website)) return res.status(201).json({ ok: true });

    const now = Date.now();
    if (now < ENTRY_START) return res.status(403).json({ error: 'Entries open Friday, November 6, 2026 at 7:00 AM MST.' });
    if (now >= ENTRY_END) return res.status(403).json({ error: 'The giveaway entry period has ended.' });

    const fullName = text(body.fullName);
    const email = text(body.email).toLowerCase();
    const phone = text(body.phone);
    if (!fullName || [...fullName].length > 120) return res.status(400).json({ error: 'Enter your full name.' });
    if (!email || [...email].length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if ([...phone].length > 40) return res.status(400).json({ error: 'Enter a phone number of 40 characters or fewer.' });
    if (body.ageConfirmed !== true) return res.status(400).json({ error: 'Confirm that you are 18 or older to enter.' });
    if (body.utahResident !== true) return res.status(400).json({ error: 'Confirm that you are a legal resident of Utah.' });
    if (body.tournamentAttendanceConfirmed !== true) return res.status(400).json({ error: 'Confirm that you are attending the Gobbler Last Chance tournament in Nephi, Utah.' });
    if (body.sponsorEligibilityConfirmed !== true) return res.status(400).json({ error: 'Confirm that you are not an employee or owner of Diamond Metrics LLC or an immediate family member of one.' });

    const insert = db.prepare(`
      INSERT INTO giveaway_entries (
        full_name, email, phone, age_confirmed, utah_resident,
        tournament_attendance_confirmed, sponsor_eligibility_confirmed, marketing_consent, consent_version
      )
      SELECT ?, ?, ?, 1, 1, 1, 1, 1, ?
      WHERE NOT EXISTS (SELECT 1 FROM giveaway_entries WHERE lower(email) = ?)
    `).run(fullName, email, phone, CONSENT_VERSION, email);
    if (insert.changes !== 1) return res.status(409).json({ error: 'Only one entry per person is allowed. This email address has already been used.' });
    return res.status(201).json({ ok: true });
  });

  app.get('/api/giveaway/entries.csv', requireAdmin, (_req, res) => {
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
}
