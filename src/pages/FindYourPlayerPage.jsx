import { useState } from 'react';
import MarketingLayout from '../components/MarketingLayout';
import heroImage from '../assets/find-your-player-hero.jpeg';
import './FindYourPlayerPage.css';

const tournaments = [
  { id: 'better-baseball-nephi-2026', label: 'Better Baseball — Nephi, Utah' },
  { id: 'bingham-pro-day', label: 'Bingham High School Pro Day' },
  { id: 'other', label: 'Other Diamond Metrics tournament' },
];

// Keep these ids in sync with the Stripe Price IDs when Checkout is connected.
// Wes can use `id` and the submitted player details as Checkout metadata.
const packages = [
  {
    id: 'individual-basic',
    coverage: 'Individual Game',
    name: 'Basic',
    label: 'Individual Game — Basic',
    price: '$50',
    description: 'A quick performance snapshot from one filmed game.',
    items: ['Box Score', 'Pitch Velocity (Pocket Radar)', 'Home-to-First Time', 'Steal Time'],
  },
  {
    id: 'individual-pro',
    coverage: 'Individual Game',
    name: 'Pro',
    label: 'Individual Game — Pro',
    price: '$75',
    featured: true,
    description: 'A deeper one-game report with advanced performance metrics where capture supports them.',
    items: ['Everything in Basic', 'Strike % + Whiff Rate', 'Command / Target Accuracy', 'Exit Velocity + Hard-Hit Rate', 'Launch Angle + Spray Tendency', 'Throw Accuracy + Release-to-Catch'],
  },
  {
    id: 'tournament-basic',
    coverage: 'Single Tournament',
    name: 'Basic',
    label: 'Single Tournament — Basic',
    price: '$125',
    description: 'Basic performance results across every successfully captured tournament game.',
    items: ['Box Score', 'Pitch Velocity (Pocket Radar)', 'Home-to-First Time', 'Steal Time'],
  },
  {
    id: 'tournament-pro',
    coverage: 'Single Tournament',
    name: 'Pro',
    label: 'Single Tournament — Pro',
    price: '$150',
    description: 'Complete tournament analysis with advanced metrics where capture supports them.',
    items: ['Everything in Basic', 'Strike % + Whiff Rate', 'Command / Target Accuracy', 'Exit Velocity + Hard-Hit Rate', 'Launch Angle + Spray Tendency', 'Throw Accuracy + Release-to-Catch'],
  },
];

export default function FindYourPlayerPage() {
  const [step, setStep] = useState('details');
  const [selectedPackage, setSelectedPackage] = useState('individual-pro');
  const [form, setForm] = useState({ guardianName: '', playerName: '', email: '', phone: '', tournament: '' });

  function updateField(event) {
    setForm((current) => ({ ...current, [event.target.name]: event.target.value }));
  }

  function continueToPackages(event) {
    event.preventDefault();
    setStep('packages');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const selected = packages.find((item) => item.id === selectedPackage);

  return (
    <MarketingLayout contact={false}>
      <section className="player-finder" aria-labelledby="player-finder-title">
        <div className="player-finder-progress" aria-label={`Step ${step === 'details' ? 'one' : 'two'} of two`}>
          <span className={step === 'details' ? 'is-active' : ''} />
          <span className={step === 'packages' ? 'is-active' : ''} />
        </div>

        {step === 'details' ? (
          <div className="player-finder-grid">
            <div className="player-finder-story">
              <div className="player-finder-image-wrap">
                <img src={heroImage} alt="Aerial view of a baseball diamond" className="player-finder-image" />
                <p className="player-finder-tag">Tournament footage, made useful</p>
              </div>
              <p className="player-finder-eyebrow">Your game, clearly measured</p>
              <h1 id="player-finder-title">We already have the footage.<br /><span>Now let’s analyze your player.</span></h1>
              <p className="player-finder-intro">Diamond Metrics analyzes the game footage captured at your tournament to give you a clearer picture of your player’s performance.</p>
            </div>

            <form className="player-finder-card" onSubmit={continueToPackages}>
              <p className="player-finder-eyebrow">Start your analysis</p>
              <h2>Find your player</h2>
              <p className="player-finder-card-copy">Enter a few details so we can match your player with the footage we captured.</p>
              <div className="player-finder-fields">
                <label>Parent or Guardian Name<input name="guardianName" value={form.guardianName} onChange={updateField} autoComplete="name" required /></label>
                <label>Player Name<input name="playerName" value={form.playerName} onChange={updateField} required /></label>
                <label>Email<input name="email" type="email" value={form.email} onChange={updateField} autoComplete="email" required /></label>
                <label>Phone Number <span>(optional)</span><input name="phone" type="tel" value={form.phone} onChange={updateField} autoComplete="tel" /></label>
                <label className="full">Tournament Attended<select name="tournament" value={form.tournament} onChange={updateField} required><option value="" disabled>Select your tournament</option>{tournaments.map((tournament) => <option value={tournament.id} key={tournament.id}>{tournament.label}</option>)}</select></label>
              </div>
              <button className="player-finder-primary" type="submit">Continue to packages</button>
              <p className="player-finder-note">Your details are used only to match your player and deliver their analysis.</p>
            </form>
          </div>
        ) : (
          <div className="player-finder-packages">
            <p className="player-finder-eyebrow">Step 2 of 2</p>
            <h1 id="player-finder-title">Choose your player package</h1>
            <p className="player-finder-intro">Choose one filmed game or every successfully captured game from this tournament, then select the level of analysis that fits your player’s goals.</p>
            <div className="player-finder-package-grid">
              {packages.map((item) => <article className={`player-package ${selectedPackage === item.id ? 'selected' : ''}`} key={item.id}>
                {item.featured && <span className="player-package-featured">Most popular</span>}
                <p className="player-package-coverage">{item.coverage}</p>
                <h2>{item.name}</h2><p className="player-package-price">{item.price}</p><p className="player-package-description">{item.description}</p>
                <ul>{item.items.map((feature) => <li key={feature}>{feature}</li>)}</ul>
                <button type="button" onClick={() => setSelectedPackage(item.id)}>{selectedPackage === item.id ? 'Selected' : `Choose ${item.label}`}</button>
              </article>)}
            </div>
            <p className="player-finder-coverage-note">Tournament packages include all successfully captured games. Capture availability and metric eligibility can vary by game and camera angle.</p>
            <div className="player-finder-selection">
              <p><strong>{form.playerName}</strong> · {tournaments.find((item) => item.id === form.tournament)?.label}</p>
              <p className="player-finder-selection-detail">Selected package: <strong>{selected.label} · {selected.price}</strong></p>
              <button className="player-finder-primary" type="button" disabled title="Secure checkout will be connected after Stripe products are configured.">Continue to secure checkout</button>
              <p className="player-finder-note">Secure checkout will open here once Diamond Metrics’ Stripe products are connected.</p>
            </div>
            <button className="player-finder-back" type="button" onClick={() => setStep('details')}>Back to player details</button>
          </div>
        )}
      </section>
    </MarketingLayout>
  );
}
