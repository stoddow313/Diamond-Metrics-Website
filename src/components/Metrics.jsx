import { Activity, Crosshair, Gauge, Shield, Timer } from 'lucide-react';
import { createElement } from 'react';

const metricGroups = [
  {
    title: 'Hitting',
    icon: Gauge,
    metrics: [
      'Max Exit Velocity',
      'Average Exit Velocity',
      'Launch Angle',
      'Hard-Hit Rate',
      'Field Tendencies',
    ],
  },
  {
    title: 'Pitching',
    icon: Crosshair,
    metrics: [
      'Max Velocity',
      'Average Velocity',
      'Strike Percentage',
      'Target Accuracy',
    ],
  },
  {
    title: 'Fielding',
    icon: Shield,
    metrics: ['Arm Strength', 'Reaction Time', 'Throw Accuracy'],
  },
  {
    title: 'Catching',
    icon: Activity,
    metrics: ['Pop Time', 'Arm Strength', 'Throw Accuracy'],
  },
  {
    title: 'Athletic Testing',
    icon: Timer,
    metrics: ['Home-to-First', '30-Yard Sprint', '60-Yard Dash'],
  },
];

function Metrics() {
  return (
    <section id="metrics" className="metrics-section" aria-labelledby="metrics-title">
      <div className="metrics-section-header">
        <div>
          <p className="eyebrow">What We Measure</p>
          <h2 id="metrics-title">The numbers that make performance visible.</h2>
        </div>
        <p className="section-text">
          Diamond Metrics organizes position-specific performance data into
          understandable insights players, families, and coaches can use.
        </p>
      </div>

      <div className="metric-groups">
        {metricGroups.map(({ title, icon, metrics }) => (
          <article className="metric-group" key={title}>
            <div className="metric-group-heading">
              <div className="metric-group-icon" aria-hidden="true">
                {createElement(icon, { size: 22 })}
              </div>
              <h3>{title}</h3>
            </div>

            <ul>
              {metrics.map((metric) => (
                <li key={metric}>{metric}</li>
              ))}
            </ul>
          </article>
        ))}
      </div>

      <p className="metrics-scope-note">
        Available metrics vary by event type, athlete position, footage
        quality, and capture setup.
      </p>
    </section>
  )
}

export default Metrics
