import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Menu, X } from 'lucide-react'
import BrandMark from './BrandMark'

function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <header className="header marketing-header">
      <div className="nav">
        <Link className="nav-brand" to="/" aria-label="Diamond Metrics home">
          <BrandMark />
        </Link>

        <button
          className="nav-menu-toggle"
          type="button"
          aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={menuOpen}
          aria-controls="primary-navigation"
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? <X size={24} aria-hidden="true" /> : <Menu size={24} aria-hidden="true" />}
        </button>

        <nav
          id="primary-navigation"
          className={`nav-links${menuOpen ? ' nav-links--open' : ''}`}
          aria-label="Primary navigation"
          onClick={(event) => {
            if (event.target.closest('a')) setMenuOpen(false)
          }}
        >
          <Link to="/how-it-works">How It Works</Link>
          <Link to="/sample-profile">Sample Profile</Link>
          <Link to="/programs">For Programs</Link>
          <Link to="/blog">Playbook</Link>
          <Link className="nav-sign-in" to="/login">Sign In</Link>
          <Link className="nav-sign-up" to="/signup">
            Analyze Your Player
          </Link>
        </nav>
      </div>
    </header>
  )
}

export default Navbar
