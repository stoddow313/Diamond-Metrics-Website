import { ArrowRight, Building2, Users } from 'lucide-react';

function WhoWeServe() {
  return (
    <section
      id="who-we-serve"
      className="audience-section"
      aria-labelledby="audience-title"
    >
      <div className="audience-section-header">
        <p className="eyebrow">Built for Every Side of Development</p>
        <h2 id="audience-title">
          One platform. Two clear paths to better player insight.
        </h2>
      </div>

      <div className="audience-paths">
        <article className="audience-card audience-card--families">
          <div className="audience-card-icon" aria-hidden="true">
            <Users size={26} />
          </div>
          <p className="audience-card-label">For Players &amp; Families</p>
          <h3>Understand the player. Show the progress.</h3>
          <p>
            Get objective performance feedback in a profile designed to make
            development easier to understand and accomplishments easier to
            share.
          </p>
          <ul>
            <li>Understand current strengths and development opportunities</li>
            <li>Track measurable progress across games and events</li>
            <li>Build a shareable profile for recruiting visibility</li>
          </ul>
          <a className="primary-button audience-cta" href="#contact">
            Get Started
            <ArrowRight size={18} aria-hidden="true" />
          </a>
        </article>

        <article className="audience-card audience-card--programs">
          <div className="audience-card-icon" aria-hidden="true">
            <Building2 size={26} />
          </div>
          <p className="audience-card-label">For Coaches &amp; Programs</p>
          <h3>Evaluate more clearly. Develop more intentionally.</h3>
          <p>
            Add organized performance data to the evaluation and development
            workflows your staff already uses.
          </p>
          <ul>
            <li>Run structured Pro Days and tryout evaluations</li>
            <li>Establish preseason and player-development benchmarks</li>
            <li>Receive coach-friendly team and player reporting</li>
          </ul>
          <a className="secondary-button audience-cta" href="#contact">
            Discuss Your Program
            <ArrowRight size={18} aria-hidden="true" />
          </a>
        </article>
      </div>
    </section>
  )
}

export default WhoWeServe
