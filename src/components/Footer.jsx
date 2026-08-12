import { Link } from 'react-router-dom';
import BrandMark from './BrandMark';

function InstagramMark() {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" /></svg>;
}

function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-top">
        <div className="footer-brand"><BrandMark /><p>Baseball performance analytics for developing players and programs.</p></div>
        <div className="footer-links">
          <Link to="/how-it-works">How It Works</Link>
          <Link to="/sample-profile">Sample Profile</Link>
          <Link to="/pricing">Pricing</Link>
          <Link to="/programs">For Programs</Link>
          <Link to="/#contact">Contact</Link>
          <Link to="/login">Sign In</Link>
        </div>
        <div className="footer-contact">
          <a href="mailto:info@diamondmetrics.ai">info@diamondmetrics.ai</a>
          <a href="mailto:support@diamondmetrics.ai">support@diamondmetrics.ai</a>
          <a className="footer-social-link" href="https://www.instagram.com/diamondmetrics.ai/" target="_blank" rel="noreferrer"><InstagramMark />@diamondmetrics.ai</a>
          <p>Utah, United States</p>
        </div>
      </div>
      <div className="footer-bottom"><p>© 2026 Diamond Metrics LLC. All rights reserved.</p></div>
    </footer>
  );
}

export default Footer;
