function VisualInsights() {
  return (
    <section id="visual-insights">
      <p className="eyebrow">Visual Insights</p>
      <h2>Performance visuals that make evaluation easier.</h2>
      <p className="section-text">
        Diamond Metrics helps turn raw player data into visuals that coaches can
        review quickly during evaluations, roster decisions, and development conversations.
      </p>

      <div className="visual-grid">
        <div className="visual-card">
          <h3>Exit Velocity Leaders</h3>
          <div className="bar-chart">
            <div className="bar-row">
              <span className="bar-label">Top Performer</span>
              <div className="bar-track">
                <div className="bar-fill bar-fill-95"></div>
              </div>
              <span className="bar-value">94.8</span>
            </div>

            <div className="bar-row">
              <span className="bar-label">Upper Tier</span>
              <div className="bar-track">
                <div className="bar-fill bar-fill-89"></div>
              </div>
              <span className="bar-value">88.9</span>
            </div>

            <div className="bar-row">
              <span className="bar-label">Mid Tier</span>
              <div className="bar-track">
                <div className="bar-fill bar-fill-84"></div>
              </div>
              <span className="bar-value">84.3</span>
            </div>

            <div className="bar-row">
              <span className="bar-label">Developing</span>
              <div className="bar-track">
                <div className="bar-fill bar-fill-79"></div>
              </div>
              <span className="bar-value">79.6</span>
            </div>
          </div>
        </div>

        <div className="visual-card">
          <h3>Sprint Speed Tiers</h3>
          <div className="ranking-list">
            <div className="ranking-item">
              <span className="ranking-rank">1</span>
              <span className="ranking-text">Top Speed Tier</span>
              <span className="ranking-value">7.31 sec</span>
            </div>
            <div className="ranking-item">
              <span className="ranking-rank">2</span>
              <span className="ranking-text">Upper Group</span>
              <span className="ranking-value">7.52 sec</span>
            </div>
            <div className="ranking-item">
              <span className="ranking-rank">3</span>
              <span className="ranking-text">Mid Group</span>
              <span className="ranking-value">7.78 sec</span>
            </div>
            <div className="ranking-item">
              <span className="ranking-rank">4</span>
              <span className="ranking-text">Developing</span>
              <span className="ranking-value">8.04 sec</span>
            </div>
          </div>
        </div>

        <div className="visual-card visual-card-wide">
          <h3>Pitch Velocity Bands</h3>
          <div className="velocity-bands">
            <div className="velocity-band">
              <span className="velocity-range">75+ mph</span>
              <span className="velocity-desc">Top varsity-ready band</span>
            </div>
            <div className="velocity-band">
              <span className="velocity-range">70–74 mph</span>
              <span className="velocity-desc">Competitive development band</span>
            </div>
            <div className="velocity-band">
              <span className="velocity-range">65–69 mph</span>
              <span className="velocity-desc">Emerging arm strength tier</span>
            </div>
            <div className="velocity-band">
              <span className="velocity-range">Under 65 mph</span>
              <span className="velocity-desc">Development focus group</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default VisualInsights;
