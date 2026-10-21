import MarketingLayout from '../components/MarketingLayout';
import heroImage from '../assets/pro-day-hero.png';
import './ProDayPage.css';

const baseballTools = [
  {
    number: '01',
    name: 'Hitting',
    summary: 'See how your contact, power, and batted-ball direction come together.',
    metrics: [
      'Maximum and average exit velocity',
      'Hard-hit rate',
      'Spray chart',
      'Launch angle',
    ],
  },
  {
    number: '02',
    name: 'Running',
    summary: 'Measure your speed over short and longer distances.',
    metrics: ['Home-to-first splits', '60-yard dash'],
  },
  {
    number: '03',
    name: 'Pitching',
    summary: 'Get a snapshot of velocity, strike throwing, and command.',
    metrics: [
      'Maximum and average velocity',
      'Strike percentage',
      'Command and accuracy',
    ],
  },
  {
    number: '04',
    name: 'Fielding',
    summary: 'Measure throwing strength and how cleanly you field the ball.',
    metrics: [
      'Arm strength: shortstop to first and/or right field to third',
      'Fielding percentage',
    ],
  },
  {
    number: '05',
    name: 'Catchers',
    summary: 'Measure quickness behind the plate and throwing strength.',
    metrics: ['Pop time', 'Catcher arm strength'],
  },
];

export default function ProDayPage() {
  return (
    <MarketingLayout contact={false}>
      <div className="pro-day-page">
        <section className="pro-day-hero" aria-labelledby="pro-day-title">
          <div className="pro-day-hero-copy">
            <p className="pro-day-eyebrow">Gobbler Last Chance Tournament · Field 4</p>
            <h1 id="pro-day-title">Pro Day</h1>
            <p className="pro-day-presented">Presented by Diamond Metrics</p>
            <p className="pro-day-tagline">
              Get real MLB-level metrics. See where your game stands.
            </p>

            <div className="pro-day-event-details">
              <div>
                <span className="pro-day-detail-label">Location</span>
                <strong>Nebo View Baseball Complex · Field 4</strong>
                <span>940 North 400 East, Nephi, Utah</span>
              </div>
              <div>
                <span className="pro-day-detail-label">Event dates</span>
                <strong>November 6–7, 2026</strong>
                <span>During the Gobbler Last Chance Tournament</span>
              </div>
              <div>
                <span className="pro-day-detail-label">Players</span>
                <strong>Ages 8–14</strong>
                <span>Open to tournament athletes</span>
              </div>
            </div>

            <a className="pro-day-button" href="#pro-day-signup">
              Sign up today <span aria-hidden="true">→</span>
            </a>
          </div>

          <figure className="pro-day-hero-figure">
            <img src={heroImage} alt="Youth baseball player preparing to hit" />
            <figcaption>Your game, measured.</figcaption>
          </figure>
        </section>

        <section className="pro-day-intro" aria-label="About Pro Day">
          <p>
            At Gobbler Last Chance Pro Day, athletes are measured on performance metrics
            used at the highest levels of baseball, with an MLB-level scout supervising.
            Each athlete receives a personalized Diamond Metrics player profile with a
            data-backed snapshot of their performance. Share results through a personalized
            online baseball card, identify strengths, evaluate development, and track
            improvements over time.
          </p>
        </section>

        <section className="pro-day-metrics" aria-labelledby="pro-day-metrics-title">
          <div className="pro-day-section-heading">
            <p className="pro-day-eyebrow">Five tools of baseball</p>
            <h2 id="pro-day-metrics-title">What you’ll measure</h2>
            <p>See the metrics and player insights available across the Pro Day stations.</p>
          </div>

          <div className="pro-day-metrics-box">
            <div className="pro-day-tools-grid">
              {baseballTools.map((tool) => (
                <article className="pro-day-tool-card" key={tool.number}>
                  <span className="pro-day-tool-number">{tool.number}</span>
                  <h3>{tool.name}</h3>
                  <p>{tool.summary}</p>
                  <ul>
                    {tool.metrics.map((metric) => (
                      <li key={metric}>{metric}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
            <p className="pro-day-metrics-note">
              Metrics received may vary by player position and station.
            </p>
          </div>
        </section>

        <section className="pro-day-profile-band" aria-label="Diamond Metrics player profile">
          <div className="pro-day-profile-mark" aria-hidden="true">DM</div>
          <div>
            <p className="pro-day-eyebrow">Your results, all in one place</p>
            <h2>A player profile<br />you can share.</h2>
          </div>
          <p>
            Each athlete receives a personalized online baseball card with a data-backed
            snapshot of their performance.
          </p>
        </section>

        <section
          className="pro-day-signup"
          id="pro-day-signup"
          aria-labelledby="pro-day-signup-title"
        >
          <div className="pro-day-signup-copy">
            <p className="pro-day-eyebrow">Gobbler Last Chance · Field 4</p>
            <h2 id="pro-day-signup-title">
              Take the field.<br /><span>Know your game.</span>
            </h2>
            <p>Register in advance for Diamond Metrics Pro Day on November 6 or 7.</p>
            <div className="pro-day-prices" aria-label="Pro Day pricing">
              <p>Pro Day pricing</p>
              <div><span>Team price</span><strong>Coming soon</strong></div>
              <div><span>Individual price</span><strong>$75</strong></div>
            </div>
            <p className="pro-day-address">
              <strong>Nebo View Baseball Complex</strong><br />
              940 North 400 East, Nephi, Utah
            </p>
          </div>

          <div className="pro-day-form-card">
            <p className="pro-day-eyebrow">Player registration</p>
            <h3>Sign up today</h3>
            <p className="pro-day-form-copy">
              Parent or guardian: please complete the registration form for your player.
            </p>
            <iframe
              className="pro-day-google-form"
              src="https://docs.google.com/forms/d/e/1FAIpQLSdLtzONA0ENMoVq2x6hUt8vCTCI7wC85blJXKHWvyvejSUkrQ/viewform?embedded=true"
              title="Diamond Metrics Pro Day signup form"
              width="100%"
              height="2266"
              frameBorder="0"
              marginHeight="0"
              marginWidth="0"
              loading="lazy"
            >
              Loading…
            </iframe>
          </div>
        </section>
      </div>
    </MarketingLayout>
  );
}