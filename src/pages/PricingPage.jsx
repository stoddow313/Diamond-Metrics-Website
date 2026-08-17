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

export default function PricingPage() {
  return (
    <MarketingLayout>
      <section className="pricing-hero">
        <p className="eyebrow">Season Analytics</p>
        <h1>Season-long analytics for the player behind the stats.</h1>
        <p>
          Choose the season package that fits your athlete. Each package covers
          up to 25 compatible games for one player.
        </p>
      </section>

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
          <p>Compatible game footage is required. After purchase, Diamond Metrics will confirm the player’s team, season, and footage availability before analysis begins.</p>
        </div>
      </section>

      <section className="pricing-next-steps">
        <p className="eyebrow">What Happens Next</p>
        <h2>Simple enrollment. Meaningful progress.</h2>
        <div>
          <article><span>01</span><h3>Choose your package</h3><p>Purchase the season package that fits your athlete.</p></article>
          <article><span>02</span><h3>Share season details</h3><p>We confirm the player, team, season, and available footage.</p></article>
          <article><span>03</span><h3>Follow the progress</h3><p>Receive an evolving player profile as games are analyzed.</p></article>
        </div>
      </section>
    </MarketingLayout>
  );
}
