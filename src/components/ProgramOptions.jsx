function ProgramOptions() {
  return (
    <section id="program-options">
      <p className="eyebrow">Program Options</p>
      <h2>Flexible service options for schools, teams, and evaluation events.</h2>
      <p className="section-text">
        Diamond Metrics can support full-program analytics, recruiting-focused
        evaluation events, and structured tryout reporting. Services are scoped
        based on program needs, event setup, and reporting requirements.
      </p>

      <div className="program-options-grid">
        <div className="program-option-card">
          <p className="program-option-label">Team Analytics</p>
          <h3>Season and program support</h3>
          <p>
            Ongoing analytics support for high school programs looking to improve
            player evaluation, development workflows, and reporting throughout
            the season.
          </p>

          <ul className="program-option-list">
            <li>Video capture and tagging workflows</li>
            <li>Player performance tracking</li>
            <li>Coach-friendly reports and summaries</li>
            <li>Program evaluation support</li>
          </ul>

          <a className="secondary-button" href="#contact">
            Request Program Info
          </a>
        </div>

        <div className="program-option-card featured-option">
          <p className="program-option-label">Analytics Pro Day</p>
          <h3>Recruiting-focused evaluation events</h3>
          <p>
            A structured, fully managed evaluation event designed to help
            upperclassmen collect measurable data and organized film for
            recruiting support.
          </p>

          <ul className="program-option-list">
            <li>Verified performance metrics captured on-site</li>
            <li>Player video for review and recruiting use</li>
            <li>Evaluation summaries for athletes and programs</li>
            <li>Built and run by the Diamond Metrics team</li>
          </ul>

          <a className="primary-button" href="#contact">
            Schedule a Pro Day
          </a>
        </div>

        <div className="program-option-card">
          <p className="program-option-label">Tryouts & Evaluations</p>
          <h3>Structured evaluation support</h3>
          <p>
            Analytics support for team tryouts, preseason sessions, and internal
            player evaluations where coaches want more measurable comparison
            points.
          </p>

          <ul className="program-option-list">
            <li>Tryout metric capture</li>
            <li>Player rankings and comparison points</li>
            <li>Coach-facing evaluation summaries</li>
            <li>Useful outputs for roster and development decisions</li>
          </ul>

          <a className="secondary-button" href="#contact">
            Contact Us
          </a>
        </div>
      </div>

      <p className="program-options-note">
        Services are customized based on program size, event structure, and reporting needs.
      </p>
    </section>
  );
}

export default ProgramOptions;