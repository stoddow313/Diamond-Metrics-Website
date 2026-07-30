import { Link } from 'react-router-dom';

function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-copy">
        <p className="eyebrow">Built to Be Seen</p>

        <h1 id="hero-title">Turn Game Footage Into Player Insight</h1>

        <p className="hero-subheading">
          The game is already on your phone. See what it can tell you.
        </p>

        <p className="hero-text">
          Upload baseball footage from your phone and receive video-backed
          analytics that help you understand performance, track progress, and
          know what to work on next.
        </p>

        <div className="hero-buttons">
          <Link className="primary-button" to="/signup">
            Analyze Your Player
          </Link>

          <Link className="secondary-button" to="/sample-profile">
            View a Sample Profile
          </Link>
        </div>
      </div>

      <div className="hero-visual">
        <picture>
          <source
            media="(max-width: 900px)"
            srcSet="/images/marketing/hero-demo-mobile.webp"
          />
          <img
            src="/images/marketing/hero-full-bleed-v2.webp"
            alt="Baseball player preparing to hit under the lights in a night stadium"
            width="1774"
            height="887"
            fetchPriority="high"
          />
        </picture>
      </div>

      <div className="hero-data" aria-label="Demo player performance">
        <p className="hero-data-label">Demo Profile</p>

        <div className="hero-metric-list">
          <div className="hero-metric">
            <span className="hero-metric-value">48%</span>
            <span>Hard-Hit Rate</span>
          </div>
          <div className="hero-metric">
            <span className="hero-metric-value">18.7 mph</span>
            <span>Sprint Speed</span>
          </div>
          <div className="hero-metric">
            <span className="hero-metric-value">91.3 mph</span>
            <span>Max Exit Velocity</span>
          </div>
        </div>

        <div className="hero-rating">
          <span>Overall Rating</span>
          <strong>87</strong>
          <small>/100</small>
        </div>
      </div>
    </section>
  );
}

export default Hero;
