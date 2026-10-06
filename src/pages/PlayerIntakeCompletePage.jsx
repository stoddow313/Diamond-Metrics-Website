import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import MarketingLayout from '../components/MarketingLayout';
import { clearSavedPlayerDetails } from '../lib/findYourPlayerSaved';
import './FindYourPlayerPage.css';

const SAVE_FAILED = 'We could not save your details. Please try again.';

export default function PlayerIntakeCompletePage() {
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get('session_id');
  const [form, setForm] = useState({ teamClub: '', jerseyNumber: '', primaryPosition: '', batsThrows: '', gameContext: '', notes: '' });
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  function updateField(event) { setForm((current) => ({ ...current, [event.target.name]: event.target.value })); }
  async function submitIntake(event) {
    event.preventDefault();
    setError(''); setIsSubmitting(true);
    try {
      const response = await fetch('/api/post-purchase-intake', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, ...form }) });
      const data = await response.json().catch(() => ({}));
      // The server's reason when it refuses (API routes answer { error }).
      if (!response.ok) setError(data.error || data.message || SAVE_FAILED);
      else {
        clearSavedPlayerDetails();
        setStatus('Thank you—your player details have been received. Our team will begin matching the footage.');
        // The confirmation is short; bring its headline into view on a phone, as step 1 → 2 does.
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } catch { setError(SAVE_FAILED); } finally { setIsSubmitting(false); }
  }

  if (!sessionId) return <MarketingLayout contact={false}><section className="player-intake-page"><h1>We need your order link</h1><p>Please return from your Stripe confirmation page to complete your player details.</p><Link className="player-intake-link" to="/find-your-player">Return to Find Your Player</Link></section></MarketingLayout>;
  if (status) return <MarketingLayout contact={false}><section className="player-intake-page"><p className="player-finder-eyebrow">Order received</p><h1>Thank you.</h1><p>{status}</p></section></MarketingLayout>;
  return <MarketingLayout contact={false}><section className="player-intake-page"><p className="player-finder-eyebrow">One final step</p><h1>Help us identify your player.</h1><p>These details help our team match your player to the tournament footage.</p><form className="player-finder-card player-intake-form" onSubmit={submitIntake}><label>Team or Club<input name="teamClub" value={form.teamClub} onChange={updateField} required /></label><label>Jersey Number<input name="jerseyNumber" value={form.jerseyNumber} onChange={updateField} required /></label><label>Primary Position<input name="primaryPosition" value={form.primaryPosition} onChange={updateField} required /></label><label>Bats / Throws <span>(optional)</span><input name="batsThrows" value={form.batsThrows} onChange={updateField} placeholder="For example: R/R" /></label><label>Game Date or Opponent <span>(optional)</span><input name="gameContext" value={form.gameContext} onChange={updateField} /></label><label>Anything else that helps identify your player? <span>(optional)</span><textarea name="notes" value={form.notes} onChange={updateField} rows="4" /></label>{error && <p className="player-finder-checkout-error" role="alert">{error}</p>}<button className="player-finder-primary" type="submit" disabled={isSubmitting}>{isSubmitting ? 'Saving…' : 'Finish intake'}</button></form></section></MarketingLayout>;
}
