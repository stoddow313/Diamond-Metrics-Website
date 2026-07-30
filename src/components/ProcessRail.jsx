import { Camera, Upload, TrendingUp } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createElement } from 'react';

const steps = [
  { number: '01', title: 'Record.', icon: Camera, text: 'Capture your player during a game using a phone or available camera. No specialized equipment. No complicated setup.' },
  { number: '02', title: 'Submit.', icon: Upload, text: 'Upload your footage and identify the player you want analyzed. We organize the relevant plays and performance data.' },
  { number: '03', title: 'Track.', icon: TrendingUp, text: 'Receive video-backed analytics that help you follow progress, recognize patterns, and understand what to work on next.' },
];

export default function ProcessRail({ compact = false }) {
  return (
    <section className="process-rail-section" aria-labelledby="process-rail-title">
      <p className="eyebrow">How It Works</p>
      <h2 id="process-rail-title">Record. Submit. Track.</h2>
      <div className="kinetic-rail" tabIndex="0" aria-label="Diamond Metrics analysis steps">
        {steps.map(({ number, title, icon: Icon, text }) => (
          <article className="kinetic-card" key={number}>
            <div className="kinetic-card-top">
              <span>{number}</span>{createElement(Icon, { size: 26, 'aria-hidden': true })}
            </div>
            <h3>{title}</h3>
            <p>{text}</p>
          </article>
        ))}
      </div>
      {!compact && <Link className="secondary-button rail-cta" to="/how-it-works">See How It Works</Link>}
    </section>
  );
}
