function MetricsPreview() {
  return (
    <section className="metrics-preview">
      <div className="metrics-preview-header">
        <p className="eyebrow">Performance Snapshot</p>
        <h2>See the type of insights Diamond Metrics can deliver.</h2>
        <p className="section-text">
          Our reporting is built to help coaches quickly understand player
          performance, compare metrics, and make more informed development and
          evaluation decisions.
        </p>
      </div>

      <div className="metrics-dashboard">
        <div className="metric-panel large-panel">
          <p className="metric-label">Top Exit Velocity</p>
          <h3 className="metric-value">95.4 mph</h3>
          <p className="metric-note">Captured during preseason evaluation</p>
        </div>

        <div className="metric-panel">
          <p className="metric-label">Best Sprint Time</p>
          <h3 className="metric-value">4.21 sec</h3>
          <p className="metric-note">Home-to-first split</p>
        </div>

        <div className="metric-panel">
          <p className="metric-label">Top Pitch Velocity</p>
          <h3 className="metric-value">88.1 mph</h3>
          <p className="metric-note">Recorded bullpen/live setting</p>
        </div>

        <div className="metric-panel wide-panel">
          <p className="metric-label">Trackable Outputs</p>
          <div className="mini-stat-grid">
            <div className="mini-stat">
              <span className="mini-stat-number">6</span>
              <span className="mini-stat-text">Core Metrics</span>
            </div>
            <div className="mini-stat">
              <span className="mini-stat-number">3</span>
              <span className="mini-stat-text">Workflow Stages</span>
            </div>
            <div className="mini-stat">
              <span className="mini-stat-number">1</span>
              <span className="mini-stat-text">Coach-Friendly Report</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

export default MetricsPreview
