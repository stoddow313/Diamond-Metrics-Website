import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import Navbar from './Navbar';
import Contact from './Contact';
import Footer from './Footer';

export default function MarketingLayout({ children, contact = true }) {
  const { pathname, hash } = useLocation();

  useEffect(() => {
    if (hash) {
      requestAnimationFrame(() => {
        document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: 'smooth' });
      });
    } else {
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
  }, [pathname, hash]);

  return (
    <div className="container marketing-page">
      <Navbar />
      <main>{children}{contact && <Contact />}</main>
      <Footer />
    </div>
  );
}
