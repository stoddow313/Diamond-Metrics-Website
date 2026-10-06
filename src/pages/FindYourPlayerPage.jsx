import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import MarketingLayout from '../components/MarketingLayout';
import heroImage from '../assets/find-your-player-hero.jpeg';
import './FindYourPlayerPage.css';

const tournaments = [
  { id: 'better-baseball-nephi-2026', label: 'Better Baseball — Nephi, Utah · October 9–10, 2026' },
];

// These keys are the only package values the browser sends. The server maps them
// to Stripe Price IDs; do not put Stripe Price IDs or amounts in the frontend.
const packages = [
  { id: 'individual_basic', coverage: 'Individual Game', name: 'Basic', label: 'Individual Game — Basic', price: '$50', description: 'A quick performance snapshot from one filmed game.', items: ['Box Score', 'Pitch Velocity (Pocket Radar)', 'Home-to-First Time', 'Steal Time'] },
  { id: 'individual_pro', coverage: 'Individual Game', name: 'Pro', label: 'Individual Game — Pro', price: '$75', featured: true, description: 'A deeper one-game report with advanced performance metrics where capture supports them.', items: ['Everything in Basic', 'Strike % + Whiff Rate', 'Command / Target Accuracy', 'Exit Velocity + Hard-Hit Rate', 'Launch Angle + Spray Tendency', 'Throw Accuracy + Release-to-Catch'] },
  { id: 'tournament_basic', coverage: 'Single Tournament', name: 'Basic', label: 'Single Tournament — Basic', price: '$125', description: 'Basic performance results across every successfully captured tournament game.', items: ['Box Score', 'Pitch Velocity (Pocket Radar)', 'Home-to-First Time', 'Steal Time'] },
  { id: 'tournament_pro', coverage: 'Single Tournament', name: 'Pro', label: 'Single Tournament — Pro', price: '$150', description: 'Complete tournament analysis with advanced metrics where capture supports them.', items: ['Everything in Basic', 'Strike % + Whiff Rate', 'Command / Target Accuracy', 'Exit Velocity + Hard-Hit Rate', 'Launch Angle + Spray Tendency', 'Throw Accuracy + Release-to-Catch'] },
];

const emptyForm = { guardianName: '', playerName: '', email: '', phone: '', tournamentId: '' };

function validateDetails(form) {
  const errors = {};
  if (!form.guardianName.trim()) errors.guardianName = 'Enter the parent or guardian name.';
  if (!form.playerName.trim()) errors.playerName = 'Enter the player name.';
  if (!form.email.trim()) errors.email = 'Enter an email address.';
  else if (!/^\S+@\S+\.\S+$/.test(form.email)) errors.email = 'Enter a valid email address.';
  if (!form.tournamentId) errors.tournamentId = 'Choose the tournament attended.';
  return errors;
}

export default function FindYourPlayerPage() {
  const [searchParams] = useSearchParams();
  const requestedPackage = searchParams.get('package');
  const [step, setStep] = useState('details');
  const [selectedPackage, setSelectedPackage] = useState(
    packages.some((item) => item.id === requestedPackage) ? requestedPackage : 'individual_pro',
  );
  const [form, setForm] = useState(emptyForm);
  const [errors, setErrors] = useState({});
  const [checkoutError, setCheckoutError] = useState('');
  const [isCreatingCheckout, setIsCreatingCheckout] = useState(false);
  const checkoutCancelled = searchParams.get('checkout') === 'cancelled';
  const selected = packages.find((item) => item.id === selectedPackage);
  const tournamentLabel = useMemo(() => tournaments.find((item) => item.id === form.tournamentId)?.label, [form.tournamentId]);

  function updateField(event) {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: undefined }));
  }

  function continueToPackages(event) {
    event.preventDefault();
    const nextErrors = validateDetails(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    setCheckoutError('');
    setStep('packages');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function createCheckout() {
    setCheckoutError('');
    setIsCreatingCheckout(true);
    try {
      const response = await fetch('/api/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, packageId: selectedPackage }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !(data.url || data.checkoutUrl)) throw new Error(data.message || 'We could not start secure checkout. Please try again.');
      window.location.assign(data.url || data.checkoutUrl);
    } catch (error) {
      setCheckoutError(error.message || 'We could not start secure checkout. Please try again.');
    } finally {
      setIsCreatingCheckout(false);
    }
  }

  return (
    <MarketingLayout contact={false}>
      <section className="player-finder" aria-labelledby="player-finder-title">
        <div className="player-finder-progress" aria-label={`Step ${step === 'details' ? 'one' : 'two'} of two`}><span className={step === 'details' ? 'is-active' : ''} /><span className={step === 'packages' ? 'is-active' : ''} /></div>
        {checkoutCancelled && <div className="player-finder-alert" role="status">Checkout was canceled. Your player details are still here—choose a package whenever you’re ready.</div>}

        {step === 'details' ? (
          <div className="player-finder-grid">
            <div className="player-finder-story">
              <div className="player-finder-image-wrap"><img src={heroImage} alt="Aerial view of a baseball diamond" className="player-finder-image" /><p className="player-finder-tag">Tournament footage, made useful</p></div>
              <p className="player-finder-eyebrow">Your game, clearly measured</p>
              <h1 id="player-finder-title">We already have the footage.<br /><span>Now let’s analyze your player.</span></h1>
              <p className="player-finder-intro">Diamond Metrics analyzes the game footage captured at your tournament to give you a clearer picture of your player’s performance.</p>
            </div>
            <form className="player-finder-card" onSubmit={continueToPackages} noValidate>
              <p className="player-finder-eyebrow">Start your analysis</p><h2>Find your player</h2><p className="player-finder-card-copy">Enter a few details so we can match your player with the footage we captured.</p>
              <div className="player-finder-fields">
                <Field label="Parent or Guardian Name" name="guardianName" value={form.guardianName} onChange={updateField} error={errors.guardianName} autoComplete="name" />
                <Field label="Player Name" name="playerName" value={form.playerName} onChange={updateField} error={errors.playerName} />
                <Field label="Email" name="email" type="email" value={form.email} onChange={updateField} error={errors.email} autoComplete="email" />
                <Field label="Phone Number" optional name="phone" type="tel" value={form.phone} onChange={updateField} autoComplete="tel" />
                <label className="full">Tournament Attended<select name="tournamentId" value={form.tournamentId} onChange={updateField} aria-invalid={Boolean(errors.tournamentId)} aria-describedby={errors.tournamentId ? 'tournamentId-error' : undefined}><option value="">Select your tournament</option>{tournaments.map((tournament) => <option value={tournament.id} key={tournament.id}>{tournament.label}</option>)}</select>{errors.tournamentId && <span className="player-finder-field-error" id="tournamentId-error">{errors.tournamentId}</span>}</label>
              </div>
              <button className="player-finder-primary" type="submit">Continue to packages</button>
              <p className="player-finder-note">Your details are used to match your player and deliver their analysis. <a href="/privacy">Privacy Policy</a></p>
            </form>
          </div>
        ) : (
          <div className="player-finder-packages">
            <p className="player-finder-eyebrow">Step 2 of 2</p><h1 id="player-finder-title">Choose your player package</h1><p className="player-finder-intro">Choose one filmed game or every successfully captured game from this tournament, then select the level of analysis that fits your player’s goals.</p>
            <div className="player-finder-package-grid">{packages.map((item) => <article className={`player-package ${selectedPackage === item.id ? 'selected' : ''}`} key={item.id}>{item.featured && <span className="player-package-featured">Most popular</span>}<p className="player-package-coverage">{item.coverage}</p><h2>{item.name}</h2><p className="player-package-price">{item.price}</p><p className="player-package-description">{item.description}</p><ul>{item.items.map((feature) => <li key={feature}>{feature}</li>)}</ul><button type="button" onClick={() => setSelectedPackage(item.id)} aria-pressed={selectedPackage === item.id}>{selectedPackage === item.id ? 'Selected' : `Choose ${item.label}`}</button></article>)}</div>
            <p className="player-finder-coverage-note">Tournament packages include all successfully captured games. Capture availability and metric eligibility can vary by game and camera angle.</p>
            <div className="player-finder-selection"><p><strong>{form.playerName}</strong> · {tournamentLabel}</p><p className="player-finder-selection-detail">Selected package: <strong>{selected.label} · {selected.price}</strong></p>{checkoutError && <p className="player-finder-checkout-error" role="alert">{checkoutError}</p>}<button className="player-finder-primary" type="button" onClick={createCheckout} disabled={isCreatingCheckout}>{isCreatingCheckout ? 'Opening secure checkout…' : 'Continue to secure checkout'}</button><p className="player-finder-note">Secure checkout is provided by Stripe.</p></div>
            <button className="player-finder-back" type="button" onClick={() => setStep('details')}>Back to player details</button>
          </div>
        )}
      </section>
    </MarketingLayout>
  );
}

function Field({ label, optional, error, ...props }) {
  const errorId = `${props.name}-error`;
  return <label>{label} {optional && <span>(optional)</span>}<input {...props} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} />{error && <span className="player-finder-field-error" id={errorId}>{error}</span>}</label>;
}
