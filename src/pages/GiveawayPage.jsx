import { useState } from 'react';
import { Link } from 'react-router-dom';
import './GiveawayPage.css';

const THANK_YOU = 'Thanks for entering! Keep an eye on your email, as we will contact the winner via email after the giveaway concludes';

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
  const [form, setForm] = useState({ fullName: '', email: '', phone: '', ageConfirmed: false, website: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);

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
        body: JSON.stringify(form),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || 'We couldn’t save your entry. Please try again.');
      setSubmitted(true);
      setForm({ fullName: '', email: '', phone: '', ageConfirmed: false, website: '' });
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
          <div className="giveaway-prize" aria-label="$250 DICKS Sporting Goods gift card">
            <span className="giveaway-prize-label">Enter to win</span>
            <strong>$250</strong>
            <span className="giveaway-prize-retailer">DICKS Sporting Goods gift card</span>
          </div>
          <p className="giveaway-copy">Enter for your chance to win a $250 DICKS Sporting Goods gift card, courtesy of Diamond Metrics.</p>
          <p className="giveaway-age-note"><span aria-hidden="true">18+</span> Must be 18 years or older to enter.</p>
          <div className="giveaway-rule" aria-hidden="true"><span /></div>
          <p className="giveaway-no-purchase">No purchase necessary.</p>
        </section>

        <section className="giveaway-form-card" aria-labelledby="giveaway-form-title">
          <div className="giveaway-card-heading">
            <span className="giveaway-card-kicker">Your chance starts here</span>
            <h2 id="giveaway-form-title">Enter the giveaway</h2>
            <p>Fill out the form below to submit your entry.</p>
          </div>
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

            <div className="giveaway-consent">
              <h3>Marketing Consent Disclosure</h3>
              <p>By entering this giveaway, you agree to receive promotional emails from Diamond Metrics, including player development insights, upcoming events, product updates, and special offers. You may unsubscribe at any time without affecting your eligibility to win.</p>
            </div>
            <p className="giveaway-rules">No purchase necessary. See <Link to="/giveaway/official-rules">Official Rules</Link> for complete eligibility and giveaway details.</p>
            {error && <p className="giveaway-error" role="alert">{error}</p>}
            <button className="giveaway-submit" type="submit" disabled={busy}>
              {busy ? 'Submitting…' : 'Submit Entry'}
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
  return (
    <main className="giveaway-rules-page">
      <p className="giveaway-eyebrow">Diamond Metrics Giveaway</p>
      <h1>Official Rules</h1>
      <p>The official rules are being finalized. Please check back before submitting an entry.</p>
      <Link to="/giveaway">Back to the giveaway</Link>
    </main>
  );
}
