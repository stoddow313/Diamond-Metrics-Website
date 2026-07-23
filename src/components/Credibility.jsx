import { BriefcaseBusiness, ChartNoAxesCombined, Users } from 'lucide-react';
import { createElement } from 'react';

const proofPoints = [
  {
    icon: Users,
    value: '41',
    label: 'Athletes Evaluated',
    description:
      'A recent Utah high school Pro Day captured position-specific performance data for 41 participating athletes.',
  },
  {
    icon: ChartNoAxesCombined,
    value: 'Utah 6A',
    label: 'Field-Tested Experience',
    description:
      'Our capture and reporting workflows have been used in real tryout, evaluation, and Pro Day environments.',
  },
  {
    icon: BriefcaseBusiness,
    value: 'Pro-Level',
    label: 'Baseball Perspective',
    description:
      'Diamond Metrics is informed by professional baseball systems and operations experience, adapted for developing players.',
  },
];

function Credibility() {
  return (
    <section className="credibility-section" aria-labelledby="credibility-title">
      <div className="credibility-header">
        <p className="eyebrow">Built in Real Baseball Environments</p>
        <h2 id="credibility-title">
          Practical analytics, tested where players actually perform.
        </h2>
      </div>

      <div className="credibility-grid">
        {proofPoints.map(({ icon, value, label, description }) => (
          <article className="credibility-proof" key={label}>
            <div className="credibility-proof-icon" aria-hidden="true">
              {createElement(icon, { size: 22 })}
            </div>
            <strong>{value}</strong>
            <h3>{label}</h3>
            <p>{description}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

export default Credibility;
