function Hero() {
  return (
    <section className="hero hero-background">
      <div className="hero-overlay"></div>

      <p className="eyebrow">Baseball Analytics for High School Programs</p>
      <h1>Bring advanced baseball analytics to your program.</h1>
      <p className="hero-text">
        Diamond Metrics helps coaches and athletic departments turn video and
        performance data into actionable insights for evaluation, development,
        and recruiting support.
      </p>

      <div className="hero-buttons">
        <a className="primary-button" href="#contact">
          Request Program Info
        </a>
        <a className="secondary-button" href="#services">
          View Services
        </a>
      </div>

      <div className="hero-badges">
        <span className="hero-badge">Video Capture</span>
        <span className="hero-badge">Tagging Workflows</span>
        <span className="hero-badge">Coach-Friendly Reports</span>
      </div>
    </section>
  );
}

export default Hero;
