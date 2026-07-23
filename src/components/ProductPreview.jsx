import { Activity, ArrowUpRight, Share2, TrendingUp } from 'lucide-react';
import { Link } from 'react-router-dom';

const previewMetrics = [
  { value: '103.2', unit: 'mph', label: 'Max Exit Velocity' },
  { value: '.375', unit: '', label: 'Batting Average' },
  { value: '6.78', unit: 'sec', label: '60-Yard Dash' },
  { value: '87', unit: 'mph', label: 'Arm Strength' },
];

function ProductPreview() {
  return (
    <section className="product-preview" aria-labelledby="product-preview-title">
      <div className="product-preview-copy">
        <p className="eyebrow">Your Performance, in One Place</p>
        <h2 id="product-preview-title">
          More than numbers. A profile built to show the complete player.
        </h2>
        <p className="section-text">
          Review measurable performance, follow progress across games and
          events, and share a clear player profile with coaches and recruiters.
        </p>

        <ul className="product-benefits" aria-label="Player profile benefits">
          <li>
            <Activity size={19} aria-hidden="true" />
            Performance metrics organized by hitting, running, and defense
          </li>
          <li>
            <TrendingUp size={19} aria-hidden="true" />
            Season-long trends alongside event and Pro Day results
          </li>
          <li>
            <Share2 size={19} aria-hidden="true" />
            One public profile that is easy to view and share
          </li>
        </ul>

        <Link className="primary-button product-preview-cta" to="/p/joe-larsen">
          Explore the Sample Profile
          <ArrowUpRight size={18} aria-hidden="true" />
        </Link>
      </div>

      <div className="profile-preview-frame" aria-label="Sample Joe Larsen player profile">
        <div className="profile-preview-browser" aria-hidden="true">
          <span />
          <span />
          <span />
          <p>diamondmetrics.ai/p/joe-larsen</p>
        </div>

        <div className="profile-preview-header">
          <img
            src="/images/marketing/joe-larsen-preview.webp"
            alt=""
            width="480"
            height="480"
            loading="lazy"
          />

          <div className="profile-preview-identity">
            <span className="profile-preview-label">Sample Player Profile</span>
            <h3>Joe Larsen</h3>
            <p>3B / SS · Class of 2027</p>
            <p>Bingham High School · South Jordan, Utah</p>
          </div>

          <div className="profile-preview-rating">
            <strong>82</strong>
            <span>Overall</span>
          </div>
        </div>

        <div className="profile-preview-tabs" aria-hidden="true">
          <span className="active">Overview</span>
          <span>Hitting</span>
          <span>Running</span>
          <span>Defense</span>
        </div>

        <div className="profile-preview-metrics">
          {previewMetrics.map((metric) => (
            <div className="profile-preview-metric" key={metric.label}>
              <p>
                {metric.value}
                {metric.unit && <span>{metric.unit}</span>}
              </p>
              <span>{metric.label}</span>
            </div>
          ))}
        </div>

        <div className="profile-preview-footer">
          <div>
            <span>Season + Pro Day</span>
            <strong>21 Events Tracked</strong>
          </div>
          <span className="profile-preview-demo">Illustrative Sample Data</span>
        </div>
      </div>
    </section>
  );
}

export default ProductPreview;
