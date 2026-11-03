import { createHash } from 'node:crypto';

const CONSENT_TEXT = 'By entering this giveaway, you agree to receive promotional emails from Diamond Metrics, including player development insights, upcoming events, product updates, and special offers. You may unsubscribe at any time without affecting your eligibility to win.';
const CONSENT_VERSION = createHash('sha256').update(CONSENT_TEXT).digest('hex').slice(0, 16);
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

    const fullName = text(body.fullName);
    const email = text(body.email).toLowerCase();
    const phone = text(body.phone);
    if (!fullName || [...fullName].length > 120) return res.status(400).json({ error: 'Enter your full name.' });
    if (!email || [...email].length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if ([...phone].length > 40) return res.status(400).json({ error: 'Enter a phone number of 40 characters or fewer.' });
    if (body.ageConfirmed !== true) return res.status(400).json({ error: 'Confirm that you are 18 or older to enter.' });

    db.prepare(`
      INSERT INTO giveaway_entries (full_name, email, phone, age_confirmed, marketing_consent, consent_version)
      VALUES (?, ?, ?, 1, 1, ?)
    `).run(fullName, email, phone, CONSENT_VERSION);
    return res.status(201).json({ ok: true });
  });

  app.get('/api/giveaway/entries.csv', requireAdmin, (_req, res) => {
    const rows = db.prepare(`
      SELECT full_name, email, phone, age_confirmed, marketing_consent, consent_version, consented_at
      FROM giveaway_entries ORDER BY created_at, id
    `).all();
    const header = ['Full Name', 'Email Address', 'Phone Number', '18+ Confirmed', 'Marketing Consent', 'Consent Version', 'Consent Timestamp'];
    const body = rows.map(row => [
      row.full_name, row.email, row.phone, row.age_confirmed ? 'Yes' : 'No',
      row.marketing_consent ? 'Yes' : 'No', row.consent_version, row.consented_at,
    ].map(csvCell).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="diamond-metrics-giveaway-entries.csv"');
    return res.send([header.join(','), ...body].join('\r\n') + '\r\n');
  });
}
