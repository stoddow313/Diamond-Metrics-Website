import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import MarketingLayout from '../components/MarketingLayout';
import { loadSavedPlayerDetails, savePlayerDetails } from '../lib/findYourPlayerSaved';
import heroImage from '../assets/find-your-player-hero.jpeg';
import './FindYourPlayerPage.css';

const tournaments = [
  { id: 'better-baseball-nephi-2026', label: 'Better Baseball Field of Screams — Nephi, Utah · October 9–10, 2026' },
];

// The browser sends only these package keys. Wes will map each key to its live
// Stripe Price ID on the server; do not put Stripe Price IDs in this file.
const packages = [
  {
    id: 'individual_basic', group: 'Individual player', coverage: 'Single game', name: 'Individual Basic', label: 'Individual Player Basic — Single Game', price: '$50',
    description: 'Core performance metrics from one filmed game.',
    items: ['Home-to-first time', 'Steal time', 'Pitcher time to home', 'Spray chart', 'Pitch velocity (radar recorded)', 'Fielding percentage'],
  },
  {
    id: 'individual_pro', group: 'Individual player', coverage: 'Single game', name: 'Individual Advanced', label: 'Individual Player Advanced — Single Game', price: '$75', featured: true,
    description: 'A deeper individual report from one filmed game.',
    items: ['Everything in Individual Basic', 'Strike percentage + whiff rate', 'Exit velocity', 'Hard-hit rate', 'Launch angle'],
  },
  {
    id: 'tournament_basic', group: 'Individual player', coverage: 'Whole tournament', name: 'Tournament Basic', label: 'Individual Player Basic — Whole Tournament', price: '$125',
    description: 'Core metrics across every successfully captured tournament game.',
    items: ['Home-to-first time', 'Steal time', 'Pitcher time to home', 'Spray chart', 'Pitch velocity (radar recorded)', 'Fielding percentage'],
  },
  {
    id: 'tournament_pro', group: 'Individual player', coverage: 'Whole tournament', name: 'Tournament Advanced', label: 'Individual Player Advanced — Whole Tournament', price: '$150',
    description: 'Advanced metrics across every successfully captured tournament game.',
    items: ['Everything in Tournament Basic', 'Strike percentage + whiff rate', 'Exit velocity', 'Hard-hit rate', 'Launch angle'],
  },
  {
    id: 'team_single_basic', group: 'Team coverage', coverage: 'Single game', name: 'Team Basic', label: 'Team Basic — Single Game', price: '$150',
    description: 'Base analytics for every rostered player from one filmed game.',
    items: ['Analytics for the full roster', 'Home-to-first time', 'Steal time + pitcher time to home', 'Spray chart', 'Pitch velocity (radar recorded)', 'Fielding percentage'],
  },
  {
    id: 'team_single_advanced', group: 'Team coverage', coverage: 'Single game', name: 'Team Advanced', label: 'Team Advanced — Single Game', price: '$300',
    description: 'Advanced analytics for every rostered player from one filmed game.',
    items: ['Everything in Team Basic', 'Strike percentage + whiff rate', 'Exit velocity', 'Hard-hit rate', 'Launch angle'],
  },
  {
    id: 'team_tournament_basic', group: 'Team coverage', coverage: 'Whole tournament', name: 'Team Tournament Basic', label: 'Team Basic — Whole Tournament', price: '$450',
    description: 'Base analytics for the roster across the full tournament.',
    items: ['Analytics for the full roster', 'Three-game minimum included', 'Additional games priced proportionally', 'Championship game included at no extra charge', 'Individual upgrades available separately'],
  },
  {
    id: 'team_tournament_advanced', group: 'Team coverage', coverage: 'Whole tournament', name: 'Team Tournament Advanced', label: 'Team Advanced — Whole Tournament', price: '$900',
    description: 'Advanced analytics for the roster across the full tournament.',
    items: ['Everything in Team Tournament Basic', 'Three-game minimum included', 'Additional games priced proportionally', 'Championship game included at no extra charge', 'Individual upgrades available separately'],
  },
];

const emptyForm = { guardianName: '', playerName: '', teamName: '', email: '', phone: '', tournamentId: '' };
const CHECKOUT_FAILED = 'We could not start secure checkout. Please try again.';

function isTeamPackage(packageId) {
  return packageId.startsWith('team_');
}

function validateDetails(form, packageId) {
  const errors = {};
  if (!form.guardianName.trim()) errors.guardianName = 'Enter the parent, guardian, or team contact name.';
  if (isTeamPackage(packageId)) {
    if (!form.teamName.trim()) errors.teamName = 'Enter the team name for this team purchase.';
  } else if (!form.playerName.trim()) {
    errors.playerName = 'Enter the player name.';
  }
  if (!form.email.trim()) errors.email = 'Enter an email address.';
  else if (!/^\S+@\S+\.\S+$/.test(form.email)) errors.email = 'Enter a valid email address.';
  if (!form.tournamentId) errors.tournamentId = 'Choose the tournament attended.';
  return errors;
}

// The details saved just before leaving for Stripe (this tab only), if they
// still make a complete form for their package; anything else is nothing saved.
function restoreDetails() {
  const saved = loadSavedPlayerDetails();
  const form = Object.fromEntries(Object.keys(emptyForm).map((key) => [key, typeof saved?.form?.[key] === 'string' ? saved.form[key] : '']));
  const packageId = packages.some((item) => item.id === saved?.packageId) ? saved.packageId : 'individual_pro';
  return Object.keys(validateDetails(form, packageId)).length ? null : { form, packageId };
}

export default function FindYourPlayerPage() {
  const [searchParams] = useSearchParams();
  const requestedPackage = searchParams.get('package');
  const checkoutCancelled = searchParams.get('checkout') === 'cancelled';
  // Back from a canceled checkout in the same tab: everything typed and the package come back.
  const [restored] = useState(() => (checkoutCancelled ? restoreDetails() : null));
  const [selectedPackage, setSelectedPackage] = useState(
    restored?.packageId || (packages.some((item) => item.id === requestedPackage) ? requestedPackage : 'individual_pro'),
  );
  const [form, setForm] = useState(restored?.form || emptyForm);
  const [errors, setErrors] = useState({});
  const [checkoutError, setCheckoutError] = useState('');
  const [isCreatingCheckout, setIsCreatingCheckout] = useState(false);
  const selected = packages.find((item) => item.id === selectedPackage);
  const selectingTeamPackage = isTeamPackage(selectedPackage);
  const individualPackages = packages.filter((item) => item.group === 'Individual player');
  const teamPackages = packages.filter((item) => item.group === 'Team coverage');

  function updateField(event) {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: undefined }));
  }

  function choosePackage(packageId) {
    setSelectedPackage(packageId);
    setCheckoutError('');
    window.setTimeout(() => document.getElementById('player-intake')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  }

  async function createCheckout(event) {
    event.preventDefault();
    const nextErrors = validateDetails(form, selectedPackage);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;

    setCheckoutError('');
    setIsCreatingCheckout(true);
    try {
      const response = await fetch('/api/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, packageId: selectedPackage }),
      });
      const data = await response.json().catch(() => ({}));
      // The server's reason when it refuses (API routes answer { error }).
      if (!response.ok || !(data.url || data.checkoutUrl)) setCheckoutError(data.error || data.message || CHECKOUT_FAILED);
      else {
        savePlayerDetails({ form, packageId: selectedPackage });
        window.location.assign(data.url || data.checkoutUrl);
      }
    } catch {
      // The request never reached the server: never show the browser's "Failed to fetch".
      setCheckoutError(CHECKOUT_FAILED);
    } finally {
      setIsCreatingCheckout(false);
    }
  }

  return (
    <MarketingLayout contact={false}>
      <section className="player-finder" aria-labelledby="player-finder-title">
        {checkoutCancelled && <div className="player-finder-alert" role="status">Checkout was canceled. {restored ? 'Your details and package are still filled in below.' : 'Your package selection is still available below.'}</div>}

        <header className="player-finder-hero">
          <div className="player-finder-image-wrap"><img src={heroImage} alt="Aerial view of a baseball diamond" className="player-finder-image" /><p className="player-finder-tag">Tournament footage, made useful</p></div>
          <div className="player-finder-story">
            <p className="player-finder-eyebrow">Your game, clearly measured</p>
            <h1 id="player-finder-title">We already have the footage.<br /><span>Now let’s analyze your player.</span></h1>
            <p className="player-finder-intro">Choose the coverage that fits your player or team. We’ll match the order to the tournament footage we captured and take it from there.</p>
          </div>
        </header>

        <section className="player-package-section" aria-labelledby="individual-packages-title">
          <div className="player-finder-section-heading"><p className="player-finder-eyebrow">For individual players</p><h2 id="individual-packages-title">Choose your player package</h2><p>One-game coverage or a complete tournament view for one player.</p></div>
          <div className="player-finder-package-grid">{individualPackages.map((item) => <PackageCard item={item} selected={selectedPackage === item.id} onChoose={choosePackage} key={item.id} />)}</div>
        </section>

        <section className="player-package-section" aria-labelledby="team-packages-title">
          <div className="player-finder-section-heading"><p className="player-finder-eyebrow">For teams</p><h2 id="team-packages-title">Cover the entire roster</h2><p>One team purchase gives every rostered player personal analytics. Players can still upgrade separately for deeper analysis.</p></div>
          <div className="player-finder-package-grid">{teamPackages.map((item) => <PackageCard item={item} selected={selectedPackage === item.id} onChoose={choosePackage} key={item.id} />)}</div>
        </section>

        <section className="player-finder-intake" id="player-intake" aria-labelledby="player-intake-title">
          <div className="player-finder-intake-copy"><p className="player-finder-eyebrow">Ready when you are</p><h2 id="player-intake-title">Find your player</h2><p>Enter a few details so we can match your order with the footage we captured.</p><p className="player-finder-intake-selected">Selected package<br /><strong>{selected.label} · {selected.price}</strong></p></div>
          <form className="player-finder-card" onSubmit={createCheckout} noValidate>
            <div className="player-finder-fields">
              <Field label="Parent, Guardian, or Team Contact Name" name="guardianName" value={form.guardianName} onChange={updateField} error={errors.guardianName} autoComplete="name" />
              <Field label={selectingTeamPackage ? 'Player Name (optional for team coverage)' : 'Player Name'} name="playerName" value={form.playerName} onChange={updateField} error={errors.playerName} />
              <Field label={selectingTeamPackage ? 'Team Name' : 'Team Name (optional)'} name="teamName" value={form.teamName} onChange={updateField} error={errors.teamName} />
              <Field label="Email" name="email" type="email" value={form.email} onChange={updateField} error={errors.email} autoComplete="email" />
              <Field label="Phone Number" optional name="phone" type="tel" value={form.phone} onChange={updateField} autoComplete="tel" />
              <label>Package Selection<select name="packageId" value={selectedPackage} onChange={(event) => setSelectedPackage(event.target.value)}><optgroup label="Individual player">{individualPackages.map((item) => <option value={item.id} key={item.id}>{item.label} · {item.price}</option>)}</optgroup><optgroup label="Team coverage">{teamPackages.map((item) => <option value={item.id} key={item.id}>{item.label} · {item.price}</option>)}</optgroup></select></label>
              <label className="full">Tournament Attended<select name="tournamentId" value={form.tournamentId} onChange={updateField} aria-invalid={Boolean(errors.tournamentId)} aria-describedby={errors.tournamentId ? 'tournamentId-error' : undefined}><option value="">Select your tournament</option>{tournaments.map((tournament) => <option value={tournament.id} key={tournament.id}>{tournament.label}</option>)}</select>{errors.tournamentId && <span className="player-finder-field-error" id="tournamentId-error">{errors.tournamentId}</span>}</label>
            </div>
            {checkoutError && <p className="player-finder-checkout-error" role="alert">{checkoutError}</p>}
            <button className="player-finder-primary" type="submit" disabled={isCreatingCheckout}>{isCreatingCheckout ? 'Opening secure checkout…' : 'Continue to secure checkout'}</button>
            <p className="player-finder-note">Your details are used to match your order and deliver the analysis. Secure checkout is provided by Stripe. <a href="/privacy">Privacy Policy</a></p>
          </form>
        </section>
      </section>
    </MarketingLayout>
  );
}

function PackageCard({ item, selected, onChoose }) {
  return <article className={`player-package ${selected ? 'selected' : ''}`}>
    {item.featured && <span className="player-package-featured">Most popular</span>}
    <p className="player-package-coverage">{item.coverage}</p><h3>{item.name}</h3><p className="player-package-price">{item.price}</p><p className="player-package-description">{item.description}</p>
    <ul>{item.items.map((feature) => <li key={feature}>{feature}</li>)}</ul>
    <button type="button" onClick={() => onChoose(item.id)} aria-pressed={selected}>{selected ? 'Selected' : 'Choose this package'}</button>
  </article>;
}

function Field({ label, optional, error, ...props }) {
  const errorId = `${props.name}-error`;
  return <label><span className="player-finder-label">{label}{optional && <small> (optional)</small>}</span><input {...props} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} />{error && <span className="player-finder-field-error" id={errorId}>{error}</span>}</label>;
}
