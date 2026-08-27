import { Link } from 'react-router-dom';
import BrandMark from './BrandMark';

function InstagramMark() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24">
      <defs>
        <linearGradient id="instagram-gradient" x1="3" y1="22" x2="21" y2="2" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FEDA75" />
          <stop offset="0.35" stopColor="#FA7E1E" />
          <stop offset="0.62" stopColor="#D62976" />
          <stop offset="1" stopColor="#4F5BD5" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="6" fill="url(#instagram-gradient)" />
      <rect x="6.2" y="6.2" width="11.6" height="11.6" rx="3.4" fill="none" stroke="white" strokeWidth="1.7" />
      <circle cx="12" cy="12" r="2.7" fill="none" stroke="white" strokeWidth="1.7" />
      <circle cx="15.9" cy="8.2" r="1" fill="white" />
    </svg>
  );
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
