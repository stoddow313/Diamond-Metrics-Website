import { Link } from 'react-router-dom';
import BrandMark from './BrandMark';

function InstagramMark() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M7.75 2h8.5A5.76 5.76 0 0 1 22 7.75v8.5A5.76 5.76 0 0 1 16.25 22h-8.5A5.76 5.76 0 0 1 2 16.25v-8.5A5.76 5.76 0 0 1 7.75 2Zm-.18 2A3.58 3.58 0 0 0 4 7.57v8.86A3.58 3.58 0 0 0 7.57 20h8.86A3.58 3.58 0 0 0 20 16.43V7.57A3.58 3.58 0 0 0 16.43 4H7.57ZM17 5.5a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5ZM12 6.5A5.5 5.5 0 1 1 6.5 12 5.51 5.51 0 0 1 12 6.5Zm0 2A3.5 3.5 0 1 0 15.5 12 3.5 3.5 0 0 0 12 8.5Z" />
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
