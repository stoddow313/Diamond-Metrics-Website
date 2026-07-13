import { useState, useRef, useEffect } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { Film, ChevronDown, LogOut, Shield, Menu, X } from 'lucide-react';

function BrandmarkSmall() {
  return (
    <div className="flex items-center gap-3">
      <svg className="w-10 h-10 shrink-0" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="admG" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#7dd3fc" />
            <stop offset="55%" stopColor="#38bdf8" />
            <stop offset="100%" stopColor="#2563eb" />
          </linearGradient>
          <linearGradient id="admIG" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#67e8f9" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#1d4ed8" stopOpacity="0.95" />
          </linearGradient>
          <filter id="admGl" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <path d="M60 10 C82 10, 100 20, 110 36 L90 56 L60 88 L30 56 L10 36 C20 20, 38 10, 60 10 Z" fill="none" stroke="url(#admG)" strokeWidth="5" filter="url(#admGl)" />
        <polygon points="60,34 82,56 60,78 38,56" fill="none" stroke="url(#admG)" strokeWidth="4" />
        <circle cx="60" cy="86" r="5" fill="#7dd3fc" />
        <circle cx="60" cy="56" r="11" fill="#e0f2fe" />
        <circle cx="60" cy="56" r="6" fill="#94a3b8" />
        <path d="M28 34 C42 22, 78 20, 94 34" fill="none" stroke="url(#admIG)" strokeWidth="7" strokeLinecap="round" opacity="0.9" />
        <path d="M28 49 L39 58" stroke="#dbeafe" strokeWidth="3" strokeLinecap="round" opacity="0.85" />
        <path d="M92 49 L81 58" stroke="#dbeafe" strokeWidth="3" strokeLinecap="round" opacity="0.85" />
      </svg>
      <div className="flex flex-col leading-tight">
        <span className="font-bold text-base text-white">Diamond Metrics</span>
        <span className="text-[10px] tracking-widest uppercase" style={{ color: '#7dd3fc' }}>Admin Panel</span>
      </div>
    </div>
  );
}

function SidebarContent({ onNavClick }) {
  return (
    <>
      <div className="px-5 py-6 border-b" style={{ borderColor: '#1e3a5f' }}>
        <BrandmarkSmall />
      </div>

      <nav className="flex-1 px-3 py-4 flex flex-col gap-1">
        <NavLink
          to="/admin"
          end
          onClick={onNavClick}
          className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all"
          style={({ isActive }) => ({
            backgroundColor: isActive ? 'rgba(56, 189, 248, 0.12)' : 'transparent',
            color: isActive ? 'white' : '#94a3b8',
          })}
        >
          <Film size={18} />
          Film Room
        </NavLink>
      </nav>

      <div className="px-5 py-4 border-t flex items-center gap-2" style={{ borderColor: '#1e3a5f' }}>
        <Shield size={14} style={{ color: '#f59e0b' }} />
        <p className="text-xs" style={{ color: '#f59e0b' }}>Admin Access</p>
      </div>
    </>
  );
}

export default function AdminShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const dropdownRef = useRef(null);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    function handleClick(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [mobileMenuOpen]);

  function handleLogout() {
    logout();
    navigate('/');
  }

  return (
    <div className="flex h-screen" style={{ background: 'linear-gradient(180deg, #06122b 0%, #081a3d 100%)' }}>
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-64 shrink-0 flex-col border-r" style={{ borderColor: '#1e3a5f', backgroundColor: 'rgba(6, 18, 43, 0.95)' }}>
        <SidebarContent onNavClick={() => {}} />
      </aside>

      {/* Mobile overlay */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Mobile drawer */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 flex flex-col border-r transition-transform duration-300 ease-in-out lg:hidden ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{ borderColor: '#1e3a5f', backgroundColor: 'rgba(6, 18, 43, 0.98)' }}
      >
        <button
          onClick={() => setMobileMenuOpen(false)}
          className="absolute top-5 right-4 p-1 rounded-lg cursor-pointer"
          style={{ color: '#94a3b8' }}
        >
          <X size={20} />
        </button>
        <SidebarContent onNavClick={() => setMobileMenuOpen(false)} />
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="h-16 shrink-0 flex items-center justify-between px-4 sm:px-6 border-b" style={{ borderColor: '#1e3a5f', backgroundColor: 'rgba(6, 18, 43, 0.6)' }}>
          <button
            onClick={() => setMobileMenuOpen(true)}
            className="lg:hidden p-2 -ml-2 rounded-lg cursor-pointer"
            style={{ color: '#94a3b8' }}
          >
            <Menu size={22} />
          </button>

          <div className="hidden lg:block" />

          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="flex items-center gap-2 px-3 py-2 rounded-xl transition-colors cursor-pointer"
              style={{ color: '#cbd5e1' }}
              onMouseEnter={e => e.currentTarget.style.backgroundColor = 'rgba(56, 189, 248, 0.08)'}
              onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}
            >
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold" style={{ backgroundColor: '#92400e', color: '#fbbf24' }}>
                A
              </div>
              <span className="text-sm font-medium hidden sm:inline">{user?.name}</span>
              <ChevronDown size={14} />
            </button>

            {dropdownOpen && (
              <div className="absolute right-0 top-12 w-56 rounded-xl border py-2 z-50 shadow-2xl" style={{ backgroundColor: 'rgba(15, 23, 42, 0.98)', borderColor: '#1e3a5f' }}>
                <div className="px-4 py-3 border-b" style={{ borderColor: '#1e3a5f' }}>
                  <p className="text-sm font-medium text-white truncate">{user?.name}</p>
                  <p className="text-xs truncate" style={{ color: '#64748b' }}>{user?.email}</p>
                </div>
                <button
                  onClick={handleLogout}
                  className="w-full flex items-center gap-3 px-4 py-3 text-sm transition-colors cursor-pointer text-left"
                  style={{ color: '#94a3b8' }}
                  onMouseEnter={e => { e.currentTarget.style.backgroundColor = 'rgba(56, 189, 248, 0.08)'; e.currentTarget.style.color = 'white'; }}
                  onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#94a3b8'; }}
                >
                  <LogOut size={16} />
                  Sign out
                </button>
              </div>
            )}
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
