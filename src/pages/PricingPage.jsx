import { ArrowRight, Check, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import MarketingLayout from '../components/MarketingLayout';
import './PricingPage.css';

const packages = [
  {
    label: 'Position Player',
    title: 'Season Player Analytics',
    price: '$495',
    description: 'Up to 25 games for one position player.',
    features: [
      'Game-based hitting analytics',
      'Baserunning and speed insights',
      'Available fielding metrics',
      'Evolving Diamond Metrics player profile',
      'Performance trends and personal bests',
      'Shareable player card and profile',
    ],
    cta: 'Get Player Analytics',
    href: 'https://buy.stripe.com/14A5kFguD6ry99u1VH4wM01',
  },
  {
    label: 'Pitcher',
    title: 'Season Pitcher Analytics',
    price: '$895',
    description: 'Up to 25 games for one regular pitcher.',
    features: [
      'Everything in Player Analytics',
      'Pitch velocity tracking',
      'Strike and command analysis',
      'Whiff and time-to-home metrics',
      'Pitch-by-pitch pitching insights',
      'Season-long pitching trends',
    ],
    cta: 'Get Pitcher Analytics',
    href: 'https://buy.stripe.com/6oUcN77Y72bi1H2eIt4wM02',
    featured: true,
  },
];

const tournamentPackages = [
  {
    id: 'tournament_basic',
    label: 'Tournament Analysis · 3–5 games included',
    title: 'Basic',
    price: '$125',
    description: 'A more complete view of a player’s overall performance across the tournament.',
    features: ['Box score', 'Pitch velocity', 'Home-to-first time', 'Steal time'],
  },
  {
    id: 'tournament_pro',
    label: 'Tournament Analysis · 3–5 games included',
    title: 'Pro',
    price: '$150',
    description: 'Everything in Basic, plus deeper performance metrics from tournament footage.',
    features: [
      'Everything in Basic',
      'Strike percentage and whiff rate',
      'Command and accuracy',
      'Exit velocity and hard-hit rate',
      'Launch angle and spray tendency',
      'Throw accuracy and release-to-catch',
    ],
    featured: true,
  },
];

const singleGamePackages = [
  {
    id: 'individual_basic',
    label: 'Single-Game Analysis',
    title: 'Basic',
    price: '$50',
    description: 'A quick performance snapshot from one filmed game.',
    features: ['Box score', 'Pitch velocity', 'Home-to-first time', 'Steal time'],
  },
  {
    id: 'individual_pro',
    label: 'Single-Game Analysis',
    title: 'Pro',
    price: '$75',
    description: 'Everything in Basic, plus deeper performance metrics from one filmed game.',
    features: [
      'Everything in Basic',
      'Strike percentage and whiff rate',
      'Command and accuracy',
      'Exit velocity and hard-hit rate',
      'Launch angle and spray tendency',
      'Throw accuracy and release-to-catch',
    ],
  },
];

function TournamentCard({ pkg }) {
  return (
    <article className={`pricing-card${pkg.featured ? ' pricing-card--featured' : ''}`}>
      {pkg.featured && <span className="pricing-badge">Best value</span>}
      <p className="pricing-label">{pkg.label}</p>
      <h3>{pkg.title}</h3>
      <p className="pricing-price">{pkg.price}</p>
      <p className="pricing-description">{pkg.description}</p>
      <ul className="pricing-features">
        {pkg.features.map((feature) => (
          <li key={feature}><Check size={18} aria-hidden="true" />{feature}</li>
        ))}
      </ul>
      <Link className="pricing-button" to={`/find-your-player?package=${pkg.id}`}>
        Choose {pkg.label} <ArrowRight size={18} aria-hidden="true" />
      </Link>
    </article>
  );
}

export default function PricingPage() {
  return (
    <MarketingLayout>
      <section className="pricing-hero">
        <p className="eyebrow">For Parents & Guardians</p>
        <h1>Choose the analysis that fits your player.</h1>
        <p>
          Purchase individual player analysis for your athlete: a quick snapshot
          from one filmed game, a more complete tournament view, or season-long analytics.
        </p>
      </section>

      <section className="pricing-package-section" aria-labelledby="tournament-analysis">
        <div className="pricing-section-heading">
          <div>
            <p className="eyebrow">Recommended</p>
            <h2 id="tournament-analysis">Tournament Analysis</h2>
            <p>For individual parents and guardians. 3–5 games included, designed to give a more complete view of a player’s overall performance.</p>
          </div>
          <span className="pricing-value-callout">Best value</span>
        </div>
        <div className="pricing-grid" aria-label="Tournament analysis packages">
          {tournamentPackages.map((pkg) => <TournamentCard key={pkg.title} pkg={pkg} />)}
        </div>
      </section>

      <section className="pricing-package-section pricing-package-section--single" aria-labelledby="single-game-analysis">
        <div className="pricing-section-heading">
          <div>
            <p className="eyebrow">One filmed game</p>
            <h2 id="single-game-analysis">Single-Game Analysis</h2>
            <p>A quick performance snapshot from one filmed game.</p>
          </div>
        </div>
        <div className="pricing-grid" aria-label="Single-game analysis packages">
          {singleGamePackages.map((pkg) => <TournamentCard key={pkg.title} pkg={pkg} />)}
        </div>
      </section>

      <section className="pricing-package-section pricing-package-section--season" aria-labelledby="season-analysis">
        <div className="pricing-section-heading">
          <div>
            <p className="eyebrow">Season Analytics</p>
            <h2 id="season-analysis">Season-long analysis</h2>
            <p>Up to 25 compatible games for one player.</p>
          </div>
        </div>

      <section className="pricing-grid" aria-label="Season analytics packages">
        {packages.map((pkg) => (
          <article className={`pricing-card${pkg.featured ? ' pricing-card--featured' : ''}`} key={pkg.title}>
            {pkg.featured && <span className="pricing-badge">Expanded analysis</span>}
            <p className="pricing-label">{pkg.label}</p>
            <h2>{pkg.title}</h2>
            <p className="pricing-price">{pkg.price}</p>
            <p className="pricing-description">{pkg.description}</p>
            <ul className="pricing-features">
              {pkg.features.map((feature) => (
                <li key={feature}><Check size={18} aria-hidden="true" />{feature}</li>
              ))}
            </ul>
            <a className="pricing-button" href={pkg.href}>
              {pkg.cta}<ArrowRight size={18} aria-hidden="true" />
            </a>
          </article>
        ))}
      </section>
      </section>

      <section className="pricing-partner-section">
        <div className="pricing-partner-heading">
          <p className="eyebrow">For Organizations</p>
          <h2>Build a plan around your players, games, and goals.</h2>
          <p>Team and tournament engagements are customized around coverage, footage access, and the metrics that matter most to your group.</p>
        </div>
        <div className="pricing-partner-grid">
          <article>
            <p className="pricing-label">Teams & Programs</p>
            <h3>Season tracking for your roster.</h3>
            <p>Give coaches and families organized player profiles, position-specific metrics, and a clearer picture of development across the season.</p>
            <ul><li><Check size={17} aria-hidden="true" />Roster-wide player insight</li><li><Check size={17} aria-hidden="true" />Custom coverage and metric plans</li><li><Check size={17} aria-hidden="true" />Team and player reporting</li></ul>
            <Link className="pricing-partner-link" to="/programs?inquiry=program#contact">Talk to our sales team <ArrowRight size={17} aria-hidden="true" /></Link>
          </article>
          <article>
            <p className="pricing-label">Tournament Directors</p>
            <h3>Make your event more measurable.</h3>
            <p>Turn tournament footage into player, team, and event-level insights—built around your schedule, fields, and available capture.</p>
            <ul><li><Check size={17} aria-hidden="true" />Tournament-wide player reporting</li><li><Check size={17} aria-hidden="true" />Featured coverage for key games</li><li><Check size={17} aria-hidden="true" />Shareable event recaps and insights</li></ul>
            <Link className="pricing-partner-link" to="/programs?inquiry=tournament#contact">Talk to our sales team <ArrowRight size={17} aria-hidden="true" /></Link>
          </article>
        </div>
      </section>

      <section className="pricing-eligibility">
        <ShieldCheck size={25} aria-hidden="true" />
        <div>
          <h2>Footage eligibility</h2>
          <p>Compatible game footage is required. After purchase, Diamond Metrics will confirm the player, tournament or season, and footage availability before analysis begins.</p>
        </div>
      </section>

      <section className="pricing-next-steps">
        <p className="eyebrow">What Happens Next</p>
        <h2>Simple enrollment. Meaningful progress.</h2>
        <div>
          <article><span>01</span><h3>Choose your package</h3><p>Select the tournament, single-game, or season package that fits your athlete.</p></article>
          <article><span>02</span><h3>Share player details</h3><p>We confirm the player, event or season, and available footage.</p></article>
          <article><span>03</span><h3>Get your analysis</h3><p>Receive a clearer picture of your player’s performance.</p></article>
        </div>
      </section>
    </MarketingLayout>
  );
}
