import { Link } from 'react-router-dom';

export default function MarketingCta({
  eyebrow = 'Built to Be Seen',
  title = 'The Game Is Already on Your Phone',
  text = 'See what it can tell you.',
  secondary = true,
}) {
  return (
    <section className="marketing-cta">
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      <p>{text}</p>
      <div className="hero-buttons">
        <Link className="primary-button" to="/signup">Analyze Your Player</Link>
        {secondary && <Link className="secondary-button" to="/sample-profile">Explore a Sample Profile</Link>}
      </div>
    </section>
  );
}
