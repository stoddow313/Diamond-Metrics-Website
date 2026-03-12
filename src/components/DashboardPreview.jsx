function DashboardPreview() {
  return (
    <section id="dashboard-preview">
      <p className="eyebrow">Example Evaluation Output</p>
      <h2>Sample performance snapshot from a program evaluation.</h2>

      <p className="section-text">
        Diamond Metrics captures measurable player data during evaluations and
        organizes it into structured summaries that coaches can immediately use
        for roster decisions and player development.
      </p>

      <div className="evaluation-layout">

        <div className="evaluation-summary-card">
          <p className="evaluation-label">Evaluation Snapshot</p>
          <h3 className="evaluation-title">Program Performance Summary</h3>

          <div className="evaluation-stat-grid">

            <div className="evaluation-stat">
              <span className="evaluation-stat-value">94.8 mph</span>
              <span className="evaluation-stat-label">Top Exit Velocity</span>
            </div>

            <div className="evaluation-stat">
              <span className="evaluation-stat-value">82.1%</span>
              <span className="evaluation-stat-label">Hard Hit Rate</span>
            </div>

            <div className="evaluation-stat">
              <span className="evaluation-stat-value">77.7 mph</span>
              <span className="evaluation-stat-label">Top Pitch Velocity</span>
            </div>

            <div className="evaluation-stat">
              <span className="evaluation-stat-value">7.31 sec</span>
              <span className="evaluation-stat-label">Best 60-Yard Time</span>
            </div>

          </div>
        </div>

        <div className="evaluation-insights-card">
          <p className="evaluation-label">Program Insights</p>
          <h3 className="evaluation-title">Example Analytical Takeaways</h3>

          <ul className="insight-list">
            <li>25% of hitters reached the program power band (≥85 mph EV)</li>
            <li>9% produced elite exit velocity (≥90 mph)</li>
            <li>31% of athletes recorded top speed tier sprint times</li>
            <li>20% of pitchers reached 75+ mph velocity</li>
            <li>32% of hitters averaged line-drive launch angles</li>
          </ul>
        </div>

      </div>
    </section>
  );
}

export default DashboardPreview;
