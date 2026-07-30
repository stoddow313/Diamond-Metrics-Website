import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import MarketingLayout from '../components/MarketingLayout';
import ProductPreview from '../components/ProductPreview';
import MarketingCta from '../components/MarketingCta';
import { ProDayCardShowcase } from '../components/profile/ProDayCard';
import { api } from '../lib/api';

const groups = [
  ['Hitting', ['Maximum exit velocity', 'Average exit velocity', 'Launch angle', 'Hard-hit rate', 'Contact rate', 'Pull / middle / opposite-field tendencies', 'Batted-ball results']],
  ['Pitching', ['Maximum and average velocity', 'Strike percentage', 'Target accuracy', 'Pitch-type usage', 'Strike percentage by pitch type', 'Pitch selection by count', 'Time to home']],
  ['Running', ['Home-to-first time', '30-yard time', '60-yard time', 'Sprint speed', 'Stolen-base and advancement times']],
  ['Fielding', ['Arm strength', 'Throw accuracy', 'Fielding accuracy', 'Infield and outfield results', 'Reaction time']],
  ['Catching', ['Pop time', 'Exchange time', 'Throwing velocity', 'Throw accuracy', 'Caught-stealing results']],
  ['Development', ['Event-to-event comparisons', 'Season trends', 'Personal bests', 'Position-specific benchmarks', 'Pro Day player cards', 'Video-linked key plays']],
];

export default function SampleProfilePage() {
  const [card, setCard] = useState(null);

  useEffect(() => {
    api.proDayCard('joe-larsen').then(setCard).catch(() => setCard(null));
  }, []);

  return (
    <MarketingLayout>
      <section className="page-hero sample-hero">
        <p className="eyebrow">Sample Player Profile</p>
        <h1>See What Player Development Looks Like</h1>
        <p>Metrics, key plays, progress, and shareable results—organized around one developing athlete.</p>
      </section>
      <section className="sample-card-showcase">
        <div>
          <p className="eyebrow">The Pro Day Card</p>
          <h2>A performance snapshot built to stand out.</h2>
          <p className="section-text">Joe Larsen’s card brings his overall rating, position, standout measurements, and player attributes into one shareable collectible.</p>
          <ul>
            <li>Front-and-back interactive design</li>
            <li>Position-specific ratings and event results</li>
            <li>A direct path to the complete player profile</li>
          </ul>
          <Link className="primary-button" to="/p/joe-larsen#card">Open the Full Pro Day Card</Link>
        </div>
        <div className="sample-card-stage">
          {card
            ? <ProDayCardShowcase data={card} />
            : <div className="sample-card-loading">Loading Joe Larsen’s Pro Day card…</div>}
        </div>
      </section>
      <ProductPreview />
      <div className="centered-action"><Link className="primary-button" to="/p/joe-larsen">Open Joe Larsen’s Full Demo Profile</Link></div>
      <section className="metrics-library">
        <p className="eyebrow">Gain Insights Into</p>
        <h2>Position-specific measurements connected to the performance.</h2>
        <div className="metric-category-grid">
          {groups.map(([title, metrics]) => <article key={title}><h3>{title}</h3><ul>{metrics.map(metric => <li key={metric}>{metric}</li>)}</ul></article>)}
        </div>
        <p className="availability-note">Every Diamond Metrics profile is tailored to the player’s position, performance, and development goals.</p>
      </section>
      <MarketingCta />
    </MarketingLayout>
  );
}
