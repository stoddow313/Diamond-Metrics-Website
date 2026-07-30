import { Camera, Check, Focus, HelpCircle, Smartphone, Video } from 'lucide-react';
import { Link } from 'react-router-dom';
import MarketingLayout from '../components/MarketingLayout';
import MarketingCta from '../components/MarketingCta';
import ProcessRail from '../components/ProcessRail';

const faqs = [
  ['Do I need a special camera?', 'No. Diamond Metrics works with footage captured on a phone or standard camera, and we provide clear filming guidance before you record.'],
  ['Can I submit only one play?', 'Yes. A single play can support a focused breakdown. Multiple plays or complete games provide more context.'],
  ['Does every player receive the same metrics?', 'Each player receives position-specific metrics tailored to their performance and development goals.'],
  ['Can a player profile grow over time?', 'Yes. Additional games and evaluations can be added to create a clearer record of performance and development.'],
  ['How accurate is the analysis?', 'Diamond Metrics uses calibrated capture and review workflows, with measurements connected directly to supporting video.'],
];

export default function HowItWorksPage() {
  return (
    <MarketingLayout>
      <section className="page-hero">
        <p className="eyebrow">How It Works</p>
        <h1>From Baseball Footage to Player Insight</h1>
        <p>Diamond Metrics turns game footage into clear, video-backed information for individual players and entire baseball programs.</p>
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
        <div className="footage-art" aria-label="Example of a player kept fully visible while recording">
          <div className="filming-status"><span /> Recording</div>
          <div className="filming-phone">
            <div className="filming-screen">
              <div className="field-horizon" />
              <div className="player-silhouette"><i /><b /></div>
              <div className="camera-frame"><span /><span /><span /><span /></div>
            </div>
          </div>
          <div className="filming-callouts">
            <span><Smartphone size={17} /> Phone or camera</span>
            <span><Focus size={17} /> Full play visible</span>
            <span><Video size={17} /> Stable position</span>
          </div>
        </div>
        <div>
          <p className="eyebrow">Footage Guidance</p>
          <h2>Better Footage Creates Better Insight</h2>
          <p className="section-text">A clear, steady angle gives our analysts the best view of the player, the ball, and the complete result of the play.</p>
          <ul>{['Keep the camera stable', 'Capture the full play', 'Keep the player visible', 'Avoid excessive zooming', 'Include the player’s name, position, and jersey number'].map(item => <li key={item}><Check size={18} />{item}</li>)}</ul>
          <div className="filming-tip"><Camera size={20} /><span><strong>Simple rule:</strong> prioritize keeping the entire play in frame over getting a tight close-up.</span></div>
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
