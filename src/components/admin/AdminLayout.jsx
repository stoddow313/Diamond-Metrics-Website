import { Link, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import BrandMark from '../BrandMark';

export default function AdminLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  return (
    <div className="min-h-screen" style={{ background: 'linear-gradient(180deg, #06122b 0%, #081a3d 100%)' }}>
      <header className="border-b" style={{ borderColor: '#1e3a5f', backgroundColor: 'rgba(6, 18, 43, 0.9)' }}>
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link to="/admin"><BrandMark /></Link>
            <span className="text-xs font-bold tracking-widest uppercase px-2 py-1 rounded" style={{ backgroundColor: 'rgba(56, 189, 248, 0.12)', color: '#38bdf8' }}>
              Admin
            </span>
            <nav className="hidden md:flex items-center gap-4 text-sm font-bold">
              <Link to="/admin" className="hover:underline" style={{ color: '#cfe8ff' }}>Players</Link>
              <Link to="/admin/teams" className="hover:underline" style={{ color: '#cfe8ff' }}>Teams</Link>
              <Link to="/admin/seasons" className="hover:underline" style={{ color: '#cfe8ff' }}>Seasons</Link>
              <Link to="/admin/tournaments" className="hover:underline" style={{ color: '#cfe8ff' }}>Tournaments</Link>
              <Link to="/admin/imports" className="hover:underline" style={{ color: '#cfe8ff' }}>Imports</Link>
              {['admin', 'analyst', 'reviewer'].includes(user?.role) && (
                <Link
                  to="/command"
                  className="hover:underline px-2 py-1 rounded"
                  style={{ color: '#fbbf24', backgroundColor: 'rgba(251, 191, 36, 0.12)' }}
                  data-testid="admin-command-link"
                >
                  Command →
                </Link>
              )}
            </nav>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm" style={{ color: '#94a3b8' }}>{user?.email}</span>
            <button
              onClick={handleLogout}
              className="text-sm font-bold px-4 py-2 rounded-xl border cursor-pointer transition-colors hover:bg-slate-800"
              style={{ borderColor: '#334155', color: '#cfe8ff' }}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
