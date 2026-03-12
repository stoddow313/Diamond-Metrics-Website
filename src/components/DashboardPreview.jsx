function DashboardPreview() {
  return (
    <section id="dashboard-preview">
      <p className="eyebrow">Example Evaluation Output</p>
      <h2>See the type of reporting coaches can receive after an evaluation.</h2>
      <p className="section-text">
        Diamond Metrics turns captured performance data into organized,
        coach-friendly summaries that support evaluation, development, and
        recruiting conversations.
      </p>

      <div className="evaluation-layout">
        <div className="evaluation-summary-card">
          <p className="evaluation-label">Sample Tryout Snapshot</p>
          <h3 className="evaluation-title">Program Evaluation Summary</h3>

          <div className="evaluation-stat-grid">
            <div className="evaluation-stat">
              <span className="evaluation-stat-value">95.4 mph</span>
              <span className="evaluation-stat-label">Top Exit Velocity</span>
            </div>

            <div className="evaluation-stat">
              <span className="evaluation-stat-value">4.21 sec</span>
              <span className="evaluation-stat-label">Best Sprint Time</span>
            </div>

            <div className="evaluation-stat">
              <span className="evaluation-stat-value">88.1 mph</span>
              <span className="evaluation-stat-label">Top Pitch Velocity</span>
            </div>

            <div className="evaluation-stat">
              <span className="evaluation-stat-value">37</span>
              <span className="evaluation-stat-label">Players Evaluated</span>
            </div>
          </div>
        </div>

        <div className="evaluation-insights-card">
          <p className="evaluation-label">Included Insights</p>
          <h3 className="evaluation-title">What Coaches Can Review</h3>

          <ul className="insight-list">
            <li>Top performers by key measurable metrics</li>
            <li>Player comparison points across evaluation groups</li>
            <li>Pitch velocity, exit velocity, and sprint leaders</li>
            <li>Structured summaries for development conversations</li>
            <li>Recruiting-support outputs for standout players</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

export default DashboardPreview;
