import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import './GiveawayPage.css';

const THANK_YOU = 'Thanks for entering! Keep an eye on your email, as we will contact the winner via email after the giveaway concludes';

// The entry window and drawing date are settings (Command → Events → Giveaway),
// read from the server and shown in Mountain time, as the official rules state.
const TZ = 'America/Denver';
const when = iso => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
  .format(new Date(iso)).replace(/, (\d{1,2}:\d{2})/, ' at $1');
const onDay = ymd => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${ymd}T12:00:00Z`));
function useGiveaway() {
  const [giveaway, setGiveaway] = useState(null);
  useEffect(() => {
    let live = true;
    fetch('/api/giveaway').then(r => (r.ok ? r.json() : null)).then(d => live && setGiveaway(d?.giveaway || {})).catch(() => live && setGiveaway({}));
    return () => { live = false; };
  }, []);
  return giveaway;
}
// Whether entries are taken at this moment (the server checks again on submit).
function openAt(g, now) {
  if (!g) return false;
  if (g.opens_at && now < Date.parse(g.opens_at)) return false;
  if (g.closes_at && now >= Date.parse(g.closes_at)) return false;
  return true;
}
function statusLine(g, now) {
  if (!g) return 'Checking the entry period…';
  if (g.opens_at && now < Date.parse(g.opens_at)) return `Entries open ${when(g.opens_at)}.`;
  if (g.closes_at && now >= Date.parse(g.closes_at)) return 'The entry period has ended.';
  return g.closes_at ? `Entries are open through ${when(g.closes_at)}.` : 'Entries are open.';
}

function ConfirmationDialog({ onClose }) {
  return (
    <div className="giveaway-modal-backdrop" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="giveaway-modal" role="dialog" aria-modal="true" aria-labelledby="giveaway-thanks-title">
        <span className="giveaway-modal-check" aria-hidden="true">✓</span>
        <p className="giveaway-eyebrow">Entry received</p>
        <h2 id="giveaway-thanks-title">You’re in.</h2>
        <p>{THANK_YOU}</p>
        <button className="giveaway-submit" type="button" onClick={onClose}>Done</button>
      </section>
    </div>
  );
}

export default function GiveawayPage() {
  const [form, setForm] = useState({ fullName: '', email: '', phone: '', ageConfirmed: false, marketingConsent: true, website: '' });
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const giveaway = useGiveaway();
  const entryOpen = openAt(giveaway, now);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, []);

  function update(event) {
    const { name, value, checked, type } = event.target;
    setForm(current => ({ ...current, [name]: type === 'checkbox' ? checked : value }));
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/giveaway/entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, eligibilityConfirmed: true }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || 'We couldn’t save your entry. Please try again.');
      setSubmitted(true);
      setForm({ fullName: '', email: '', phone: '', ageConfirmed: false, marketingConsent: true, website: '' });
    } catch (err) {
      setError(err.message || 'We couldn’t save your entry. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="giveaway-page">
      <div className="giveaway-orb giveaway-orb-one" aria-hidden="true" />
      <div className="giveaway-orb giveaway-orb-two" aria-hidden="true" />
      <header className="giveaway-brand" aria-label="Diamond Metrics">
        <span className="giveaway-brand-mark" aria-hidden="true">DM</span>
        <span>Diamond Metrics</span>
      </header>

      <main className="giveaway-content">
        <section className="giveaway-intro">
          <p className="giveaway-eyebrow">A little something for the season</p>
          <h1>Diamond Metrics<br /><span>Giveaway</span></h1>
          <div className="giveaway-prize" aria-label="$250 DICK'S Sporting Goods gift card">
            <span className="giveaway-prize-label">Enter to win</span>
            <strong>$250</strong>
            <span className="giveaway-prize-retailer">DICK'S Sporting Goods gift card</span>
          </div>
          <p className="giveaway-copy">Enter for your chance to win a $250 DICK'S Sporting Goods gift card, courtesy of Diamond Metrics.</p>
          <p className="giveaway-age-note"><span aria-hidden="true">18+</span> Must be 18 years or older to enter.</p>
          <div className="giveaway-rule" aria-hidden="true"><span /></div>
          <p className="giveaway-no-purchase">No purchase necessary.</p>
          <p className="giveaway-sponsor-disclaimer">This giveaway is not sponsored or endorsed by DICK'S Sporting Goods.</p>
        </section>

        <section className="giveaway-form-card" aria-labelledby="giveaway-form-title">
          <div className="giveaway-card-heading">
            <span className="giveaway-card-kicker">Your chance starts here</span>
            <h2 id="giveaway-form-title">Enter the giveaway</h2>
            <p>Fill out the form below to submit your entry.</p>
          </div>
          <p className="giveaway-entry-status" role="status">
            {statusLine(giveaway, now)}
          </p>
          <form className="giveaway-form" onSubmit={submit}>
            <div className="giveaway-honeypot" aria-hidden="true">
              <label htmlFor="giveaway-website">Website</label>
              <input id="giveaway-website" name="website" tabIndex="-1" autoComplete="off" value={form.website} onChange={update} />
            </div>
            <label className="giveaway-field">
              <span>Full Name <b>(Required)</b></span>
              <input name="fullName" type="text" autoComplete="name" maxLength="120" required value={form.fullName} onChange={update} />
            </label>
            <label className="giveaway-field">
              <span>Email Address <b>(Required)</b></span>
              <input name="email" type="email" autoComplete="email" maxLength="254" required value={form.email} onChange={update} />
            </label>
            <label className="giveaway-field">
              <span>Phone Number <i>(Optional)</i></span>
              <input name="phone" type="tel" autoComplete="tel" maxLength="40" value={form.phone} onChange={update} />
            </label>
            <label className="giveaway-age-check">
              <input name="ageConfirmed" type="checkbox" required checked={form.ageConfirmed} onChange={update} />
              <span>I confirm that I am 18 years of age or older.</span>
            </label>
            <label className="giveaway-age-check">
              <input name="marketingConsent" type="checkbox" required checked={form.marketingConsent} onChange={update} />
              <span><strong>Email marketing consent</strong> — By checking this box, I agree to receive promotional emails from Diamond Metrics LLC about player development insights, upcoming events, product updates, and special offers. I may unsubscribe at any time using the unsubscribe link in those emails. Unsubscribing after I enter will not affect my eligibility to win.</span>
            </label>
            <p className="giveaway-rules">By submitting, you confirm that you meet the eligibility requirements in the <Link to="/giveaway/official-rules">Official Rules</Link>, including Utah residency and Gobbler Last Chance attendance. No purchase necessary.</p>
            {error && <p className="giveaway-error" role="alert">{error}</p>}
            <button className="giveaway-submit" type="submit" disabled={busy || !entryOpen}>
              {busy ? 'Submitting…' : entryOpen ? 'Submit Entry' : 'Entries Not Open'}
            </button>
            <p className="giveaway-privacy">Your information will be used to administer the giveaway and provide the promotional emails described above.</p>
          </form>
        </section>
      </main>
      <footer className="giveaway-footer">Diamond Metrics <span>•</span> Player development, made measurable.</footer>
      {submitted && <ConfirmationDialog onClose={() => setSubmitted(false)} />}
    </div>
  );
}

export function GiveawayRulesPage() {
  const giveaway = useGiveaway();
  const period = !giveaway ? <>…</>
    : giveaway.opens_at && giveaway.closes_at ? <>The Giveaway begins on <strong>{when(giveaway.opens_at)}</strong> and ends on <strong>{when(giveaway.closes_at)}</strong>. Entries submitted before or after this period will not be eligible.</>
      : giveaway.closes_at ? <>The Giveaway ends on <strong>{when(giveaway.closes_at)}</strong>. Entries submitted after this time will not be eligible.</>
        : giveaway.opens_at ? <>The Giveaway begins on <strong>{when(giveaway.opens_at)}</strong>. Entries submitted before this time will not be eligible.</>
          : <>The Giveaway entry period is shown on the entry page.</>;
  return (
    <main className="giveaway-rules-page">
      <p className="giveaway-eyebrow">Diamond Metrics Giveaway</p>
      <h1 className="giveaway-rules-title">Diamond Metrics $250 DICK'S Sporting Goods Gift Card Giveaway</h1>
      <h2>Official Rules</h2>
      <p><strong>NO PURCHASE NECESSARY TO ENTER OR WIN. A PURCHASE WILL NOT INCREASE YOUR CHANCES OF WINNING.</strong></p>

      <h2>1. Sponsor</h2>
      <p>The Diamond Metrics $250 DICK'S Sporting Goods Gift Card Giveaway (“Giveaway”) is sponsored and administered by Diamond Metrics LLC (“Sponsor”), located in Utah, United States.</p>
      <p><strong>Sponsor Mailing Address:</strong> 924 Rothbury Ct, North Salt Lake, UT 84054</p>
      <p>The Giveaway takes place in connection with the Gobbler Last Chance baseball tournament, hosted by Better Baseball in Nephi, Utah.</p>
      <p>The Giveaway is not sponsored, endorsed, administered by, or affiliated with DICK'S Sporting Goods or Better Baseball unless expressly authorized.</p>

      <h2>2. Eligibility</h2>
      <p>The Giveaway is open to individuals who:</p>
      <ul><li>Are at least 18 years of age at the time of entry.</li><li>Are legal residents of Utah.</li><li>Attend the Gobbler Last Chance tournament in Nephi, Utah, during the entry period.</li><li>Complete the official entry form and provide a valid email address.</li></ul>
      <p>Employees and owners of Diamond Metrics LLC and their immediate family members are not eligible. Void where prohibited by law.</p>

      <h2>3. Giveaway Period</h2>
      <p>{period} All times are Mountain Time.</p>

      <h2>4. How to Enter</h2>
      <p>To enter:</p>
      <ol><li>Scan the official Diamond Metrics Giveaway QR code displayed at the Gobbler Last Chance tournament.</li><li>Complete the online entry form with your full name and valid email address.</li><li>Confirm that you are at least 18 years old.</li><li>Review the marketing disclosure and submit your entry.</li></ol>
      <p>Limit one (1) entry per person. Duplicate entries may be disqualified.</p>
      <p>No purchase, payment, or participation in any paid Diamond Metrics service is required to enter or win.</p>

      <h2>5. Email Marketing Consent</h2>
      <p>By submitting an entry, participants agree to receive promotional emails from Diamond Metrics LLC, including upcoming events, player development insights, product updates, and special offers.</p>
      <p>Participants may unsubscribe from marketing emails at any time using the unsubscribe link included in those communications.</p>
      <p><strong>Unsubscribing after entering will not disqualify a participant, remove their entry, or affect their chances of winning.</strong></p>
      <p>Email addresses and personal information collected through this Giveaway will be used in accordance with Diamond Metrics' published <Link to="/privacy">Privacy Policy</Link>.</p>

      <h2>6. Prize</h2>
      <p>One (1) winner will receive a <strong>$250 DICK'S Sporting Goods gift card</strong>, subject to DICK'S Sporting Goods' applicable gift card terms and conditions.</p>
      <ul><li>Prize: DICK'S Sporting Goods Gift Card</li><li>Value: $250 USD</li><li>Number of Winners: One (1)</li><li>Total Prize Value: $250 USD</li></ul>
      <p>The prize cannot be redeemed for cash through the Sponsor and is not transferable or exchangeable through the Sponsor. The Sponsor reserves the right to substitute a prize of equal or greater value if the advertised prize becomes unavailable, subject to applicable law. Any applicable taxes are the responsibility of the winner.</p>

      <h2>7. Winner Selection and Notification</h2>
      <p>One (1) winner will be selected through a random drawing from all eligible entries.</p>
      {giveaway?.drawing_on && <p><strong>The drawing will take place on {onDay(giveaway.drawing_on)}.</strong></p>}
      <p>The selected winner will be notified at the email address provided during entry. The potential winner must respond within seven (7) calendar days of notification.</p>
      <p>If the selected winner does not respond within that period, cannot verify eligibility, or declines the prize, Diamond Metrics may select an alternate winner through another random drawing.</p>

      <h2>8. Odds of Winning</h2>
      <p>The odds of winning depend on the total number of eligible entries received during the Giveaway period. Each eligible entry has an equal chance of winning.</p>

      <h2>9. Prize Delivery</h2>
      <p>The winner will receive instructions for claiming the gift card following verification of eligibility. The gift card will be delivered electronically to the winner's provided email address or through another delivery method arranged by Diamond Metrics. No purchase or additional payment is required to claim the prize.</p>

      <h2>10. General Conditions</h2>
      <p>By entering, participants agree to comply with these Official Rules and the Sponsor's decisions regarding administration of the Giveaway, subject to applicable law.</p>
      <p>The Sponsor reserves the right to disqualify fraudulent, incomplete, automated, or otherwise invalid entries.</p>
      <p>The Sponsor may modify, suspend, or cancel the Giveaway if technical failures, fraud, or circumstances beyond its reasonable control compromise its fairness or integrity, subject to applicable law.</p>

      <h2>11. Privacy and Personal Information</h2>
      <p>Diamond Metrics collects participants' names, email addresses, and entry information to administer the Giveaway, contact the winner, and deliver marketing communications as disclosed during entry.</p>
      <p>Entrants may unsubscribe from promotional communications without affecting their Giveaway eligibility.</p>
      <p>For details on how personal information is collected, used, stored, and protected, please review the Diamond Metrics <Link to="/privacy">Privacy Policy</Link>.</p>

      <h2>12. Governing Law</h2>
      <p>The Giveaway is governed by applicable laws of the State of Utah and the United States.</p>

      <h2>13. Contact Information</h2>
      <p><strong>Diamond Metrics LLC</strong></p>
      <p>Website: <a href="https://www.diamondmetrics.ai">https://www.diamondmetrics.ai</a></p>
      <p>Email: <a href="mailto:info@diamondmetrics.ai">info@diamondmetrics.ai</a></p>
      <p><strong>Mailing Address:</strong> 924 Rothbury Ct, North Salt Lake, UT 84054</p>
      <p>For questions regarding the Giveaway, please contact the Sponsor using the information above.</p>
      <Link to="/giveaway">Back to the giveaway</Link>
    </main>
  );
}
