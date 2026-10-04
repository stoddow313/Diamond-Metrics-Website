import { Link } from 'react-router-dom';
import { useIntakeConfig } from '../lib/intake';

export default function MarketingCta({
  eyebrow = 'Built to Be Seen',
  title = 'The Game Is Already on Your Phone',
  text = 'See what it can tell you.',
  secondary = true,
}) {
  const intake = useIntakeConfig();
  return (
    <section className="marketing-cta">
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      <p>{text}</p>
      <div className="hero-buttons">
        <Link className="primary-button" to="/pricing">View Season Packages</Link>
        {intake?.enabled && <Link className="secondary-button" to="/submit?source=marketing_cta">Start an Analysis Request</Link>}
        {secondary && <Link className="secondary-button" to="/sample-profile">Explore a Sample Profile</Link>}
      </div>
    </section>
  );
}
