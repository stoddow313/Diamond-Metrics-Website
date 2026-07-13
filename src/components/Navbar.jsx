import { Link } from 'react-router-dom'
import BrandMark from './BrandMark'

function Navbar() {
  return (
    <header className="header">
      <div className="nav">
        <BrandMark />
        <nav className="nav-links">
          <a href="#services">Services</a>
          <a href="#metrics">Metrics</a>
          <a href="#process">How It Works</a>
          <a href="#contact">Contact</a>
          <Link to="/login" style={{ color: '#38bdf8', fontWeight: 700 }}>Sign In</Link>
        </nav>
      </div>
    </header>
  )
}

export default Navbar
