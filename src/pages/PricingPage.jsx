import { ArrowRight, Check, ShieldCheck } from 'lucide-react';
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
