import { Camera, Check, HelpCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import MarketingLayout from '../components/MarketingLayout';
import MarketingCta from '../components/MarketingCta';
import ProcessRail from '../components/ProcessRail';

const faqs = [
  ['Do I need a special camera?', 'Many types of analysis can begin with footage captured on a phone or standard camera. Certain measurements require specific angles or recording conditions.'],
  ['Can I submit only one play?', 'Yes. A single play can support a focused breakdown. Multiple plays or complete games provide more context.'],
  ['Does every player receive the same metrics?', 'No. Available metrics depend on position, the performance captured, and the quality and angle of the footage.'],
  ['Can a player profile grow over time?', 'Yes. Additional games and evaluations can be added to create a clearer record of performance and development.'],
  ['How accurate is the analysis?', 'Accuracy depends partly on footage quality and camera placement. Available measurements are clearly communicated and connected to supporting footage whenever possible.'],
];

export default function HowItWorksPage() {
  return (
    <MarketingLayout>
      <section className="page-hero">
        <p className="eyebrow">How It Works</p>
        <h1>From Baseball Footage to Player Insight</h1>
        <p>Diamond Metrics turns qualifying game footage into clear, video-backed information for individual players and entire baseball programs.</p>
        <div className="hero-buttons">
          <a className="primary-button" href="#players">For Players &amp; Families</a>
          <a className="secondary-button" href="#programs-overview">For Coaches &amp; Programs</a>
        </div>
      </section>

      <div id="players"><ProcessRail compact /></div>
      <div className="centered-action"><Link className="primary-button" to="/signup">Analyze Your Player</Link></div>

      <section id="programs-overview" className="program-callout">
        <div><p className="eyebrow">Coaches &amp; Programs</p><h2>One organized view of every player.</h2></div>
        <div><p>Diamond Metrics supports Pro Days, tryouts, roster evaluations, and ongoing player development through organized, video-backed player reporting.</p><Link to="/programs">Explore Diamond Metrics for Programs →</Link></div>
      </section>

      <section className="footage-guide">
        <div className="footage-art"><Camera size={68} aria-hidden="true" /><span>Phone or available camera</span></div>
        <div>
          <p className="eyebrow">Footage Guidance</p>
          <h2>Better Footage Creates Better Insight</h2>
          <ul>{['Keep the camera stable', 'Capture the full play', 'Keep the player visible', 'Avoid excessive zooming', 'Include the player’s name, position, and jersey number'].map(item => <li key={item}><Check size={18} />{item}</li>)}</ul>
          <p className="fine-print">Cellphone footage can be useful, but available measurements depend on the angle, quality, and type of footage submitted.</p>
        </div>
      </section>

      <section className="faq-section">
        <p className="eyebrow">Frequently Asked Questions</p>
        <h2>Questions Before You Submit?</h2>
        <div className="faq-rail" tabIndex="0">
          {faqs.map(([question, answer]) => <article className="faq-card" key={question}><HelpCircle size={24} /><h3>{question}</h3><p>{answer}</p></article>)}
        </div>
      </section>
      <MarketingCta />
    </MarketingLayout>
  );
}
