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
        </nav>
      </div>
    </header>
  )
}

export default Navbar
