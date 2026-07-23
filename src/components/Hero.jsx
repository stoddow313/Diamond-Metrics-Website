import { Link } from 'react-router-dom';

function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-copy">
        <p className="eyebrow">Baseball Performance, Made Visible</p>

        <h1 id="hero-title">Built to Be Seen</h1>

        <p className="hero-subheading">
          Professional-level baseball insights for developing players.
        </p>

        <p className="hero-text">
          Diamond Metrics turns baseball footage into measurable player
          data—helping athletes understand their strengths, track their
          progress, and showcase their performance.
        </p>

        <p className="hero-proof">
          See their strengths. Track their progress. Show their growth.
        </p>

        <div className="hero-buttons">
          <Link className="primary-button" to="/p/joe-larsen">
            View a Sample Player Profile
          </Link>

          <a className="secondary-button" href="#contact">
            Get Started
          </a>
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
