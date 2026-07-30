import { Link } from 'react-router-dom';
import MarketingLayout from '../components/MarketingLayout';
import ProductPreview from '../components/ProductPreview';
import MarketingCta from '../components/MarketingCta';

const groups = [
  ['Hitting', ['Maximum exit velocity', 'Average exit velocity', 'Launch angle', 'Hard-hit rate', 'Contact rate', 'Pull / middle / opposite-field tendencies', 'Batted-ball results']],
  ['Pitching', ['Maximum and average velocity', 'Strike percentage', 'Target accuracy', 'Pitch-type usage when identifiable', 'Strike percentage by pitch type', 'Pitch selection by count', 'Time to home']],
  ['Running', ['Home-to-first time', '30-yard time', '60-yard time', 'Sprint speed', 'Stolen-base and advancement times when captured']],
  ['Fielding', ['Arm strength when measurable', 'Throw accuracy', 'Fielding accuracy', 'Infield and outfield results', 'Reaction time when captured reliably']],
  ['Catching', ['Pop time', 'Exchange time when measurable', 'Throwing velocity', 'Throw accuracy', 'Caught-stealing results']],
  ['Development', ['Event-to-event comparisons', 'Season trends', 'Personal bests', 'Position-specific benchmarks', 'Pro Day player cards', 'Video-linked key plays']],
];

export default function SampleProfilePage() {
  return (
    <MarketingLayout>
      <section className="page-hero sample-hero">
        <p className="eyebrow">Sample Player Profile</p>
        <h1>See What Player Development Looks Like</h1>
        <p>Metrics, key plays, progress, and shareable results—organized around one developing athlete.</p>
      </section>
      <ProductPreview />
      <div className="centered-action"><Link className="primary-button" to="/p/joe-larsen">Open Joe Larsen’s Full Demo Profile</Link></div>
      <section className="metrics-library">
        <p className="eyebrow">Gain Insights Into</p>
        <h2>Position-specific measurements connected to the performance.</h2>
        <div className="metric-category-grid">
          {groups.map(([title, metrics]) => <article key={title}><h3>{title}</h3><ul>{metrics.map(metric => <li key={metric}>{metric}</li>)}</ul></article>)}
        </div>
        <p className="availability-note">Measurements available may vary based on the player’s position, play captured, camera placement, video quality, and recording frame rate.</p>
      </section>
      <MarketingCta />
    </MarketingLayout>
  );
}
