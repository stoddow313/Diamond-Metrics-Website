import { Link } from 'react-router-dom';
import MarketingLayout from '../components/MarketingLayout';
import ProductPreview from '../components/ProductPreview';

const uses = ['Pro Days', 'Tryouts and roster evaluations', 'Preseason and postseason testing', 'Player-development benchmarks', 'Showcases and recruiting events', 'Season-long performance tracking'];
const deliverables = ['Individual player profiles', 'Position-specific performance metrics', 'Video connected to key results', 'Organized roster reporting', 'Comparable player benchmarks', 'Progress across multiple evaluations', 'Shareable reports for athletes and families'];

export default function ProgramsPage() {
  return (
    <MarketingLayout>
      <section className="page-hero">
        <p className="eyebrow">For Programs</p>
        <h1>Better Player Evaluation. Clearer Program Data.</h1>
        <p>From the opening Pro Day through the end of the season, Diamond Metrics gives coaches a clearer view of every player.</p>
        <div className="hero-buttons">
          <Link className="primary-button" to="/programs?inquiry=pro-day#contact">Schedule a Pro Day</Link>
          <Link className="secondary-button" to="/programs?inquiry=program#contact">Talk to Our Team</Link>
        </div>
      </section>
      <section className="program-grid">
        <div><p className="eyebrow">Built for the Way Programs Evaluate</p><h2>Use Diamond Metrics across the full player-development cycle.</h2><p>We work with club programs, high schools, academies, training facilities, and event operators.</p></div>
        <ul>{uses.map(item => <li key={item}>{item}</li>)}</ul>
      </section>
      <section className="deliverables-section">
        <p className="eyebrow">Follow Every Player Through the Season</p>
        <h2>A consistent performance record from beginning to end.</h2>
        <div className="deliverable-grid">{deliverables.map(item => <div key={item}>{item}</div>)}</div>
        <Link className="secondary-button" to="/sample-profile">View a Sample Player Profile</Link>
      </section>
      <ProductPreview />
      <section className="pro-day-banner">
        <p className="eyebrow">Pro Days Powered by Diamond Metrics</p>
        <h2>Capture an entire event and turn it into organized, actionable player data.</h2>
        <p>We help structure the evaluation, capture the performance, and establish the player profiles your program can use throughout the season.</p>
        <Link className="primary-button" to="/programs?inquiry=pro-day#contact">Schedule a Pro Day</Link>
      </section>
    </MarketingLayout>
  );
}
