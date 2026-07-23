import { BarChart3, Share2, Video } from 'lucide-react';
import { createElement } from 'react';
import { Link } from 'react-router-dom';

const steps = [
  {
    number: '01',
    icon: Video,
    title: 'Capture the Performance',
    description:
      'Attend a Diamond Metrics event or submit qualifying footage of your player.',
  },
  {
    number: '02',
    icon: BarChart3,
    title: 'We Analyze the Film',
    description:
      'We evaluate the performance and translate it into meaningful baseball metrics.',
  },
  {
    number: '03',
    icon: Share2,
    title: 'See and Share the Results',
    description:
      'Receive a clear player profile highlighting strengths, development opportunities, and progress.',
  },
];

function Process() {
  return (
    <section id="how-it-works" className="process-section" aria-labelledby="process-title">
      <p className="eyebrow">How It Works</p>
      <h2 id="process-title">From baseball footage to player insight.</h2>
      <p className="section-text">
        A straightforward process designed to make advanced performance
        information understandable, useful, and easy to share.
      </p>

      <div className="process-flow">
        {steps.map(({ number, icon: Icon, title, description }) => (
          <article className="process-step" key={number}>
            <div className="process-step-top">
              <div className="process-icon" aria-hidden="true">
                {createElement(Icon, { size: 24 })}
              </div>
              <span className="process-number">{number}</span>
            </div>
            <h3>{title}</h3>
            <p>{description}</p>
          </article>
        ))}
      </div>

      <Link className="secondary-button process-cta" to="/p/joe-larsen">
        Explore a Sample Player Profile
      </Link>
    </section>
  );
}

export default Process;
