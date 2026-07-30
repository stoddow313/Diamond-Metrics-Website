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
            media="(max-width: 700px)"
            srcSet="/images/marketing/hero-demo-mobile.webp"
          />
          <img
            src="/images/marketing/hero-demo-desktop.webp"
            alt="Demo Diamond Metrics player profile showing hard-hit rate, sprint speed, exit velocity, and an overall rating"
            width="1959"
            height="803"
            fetchPriority="high"
          />
        </picture>
      </div>
    </section>
  );
}

export default Hero;
