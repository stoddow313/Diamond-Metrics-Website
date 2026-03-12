function DashboardPreview() {
  return (
    <section id="dashboard-preview">
      <p className="eyebrow">Analytics Preview</p>
      <h2>Example performance insights generated from player data.</h2>

      <div className="dashboard-grid">

        <div className="dashboard-card">
          <h3>Exit Velocity Leaders</h3>
          <ul>
            <li>Player A — 95.4 mph</li>
            <li>Player B — 93.8 mph</li>
            <li>Player C — 92.6 mph</li>
            <li>Player D — 91.9 mph</li>
          </ul>
        </div>

        <div className="dashboard-card">
          <h3>Sprint Speed Rankings</h3>
          <ul>
            <li>Player A — 4.21 sec</li>
            <li>Player B — 4.28 sec</li>
            <li>Player C — 4.34 sec</li>
            <li>Player D — 4.39 sec</li>
          </ul>
        </div>

        <div className="dashboard-card">
          <h3>Pitch Velocity Distribution</h3>
          <p>
            Track pitcher velocity ranges across the roster to help coaches
            understand staff composition and development progress.
          </p>
        </div>

        <div className="dashboard-card">
          <h3>Contact Quality</h3>
          <p>
            Identify players producing consistent hard contact and monitor
            improvements across the season.
          </p>
        </div>

      </div>
    </section>
  );
}

export default DashboardPreview;
