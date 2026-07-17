import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import BrandMark from '../components/BrandMark';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const { login } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    try {
      const user = await login(email, password);
      navigate(user.role === 'player' ? '/me' : '/admin');
    } catch (err) {
      setError(err.message || 'Invalid email or password.');
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: 'linear-gradient(180deg, #06122b 0%, #081a3d 100%)' }}>
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-10">
          <BrandMark />
        </div>

        <div className="rounded-2xl border p-8" style={{ backgroundColor: 'rgba(15, 23, 42, 0.78)', borderColor: '#1e3a5f' }}>
          <h2 className="text-2xl font-bold text-white mb-1">Welcome back</h2>
          <p className="text-sm mb-8" style={{ color: '#94a3b8' }}>Sign in to your Diamond Metrics account</p>

          {error && (
            <p className="text-sm text-center py-3 rounded-xl mb-2" style={{ backgroundColor: 'rgba(239, 68, 68, 0.12)', color: '#f87171' }}>{error}</p>
          )}

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <label className="text-sm font-bold" style={{ color: '#cfe8ff' }}>Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@diamondmetrics.ai"
                required
                className="w-full px-4 py-3 rounded-xl border text-white text-sm outline-none transition-all focus:shadow-[0_0_0_3px_rgba(56,189,248,0.12)]"
                style={{ backgroundColor: 'rgba(30, 41, 59, 0.95)', borderColor: '#334155' }}
                onFocus={e => e.target.style.borderColor = '#38bdf8'}
                onBlur={e => e.target.style.borderColor = '#334155'}
              />
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-sm font-bold" style={{ color: '#cfe8ff' }}>Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Enter your password"
                required
                className="w-full px-4 py-3 rounded-xl border text-white text-sm outline-none transition-all focus:shadow-[0_0_0_3px_rgba(56,189,248,0.12)]"
                style={{ backgroundColor: 'rgba(30, 41, 59, 0.95)', borderColor: '#334155' }}
                onFocus={e => e.target.style.borderColor = '#38bdf8'}
                onBlur={e => e.target.style.borderColor = '#334155'}
              />
            </div>

            <button
              type="submit"
              className="w-full py-3 rounded-xl font-bold text-sm transition-transform hover:-translate-y-0.5 cursor-pointer"
              style={{ backgroundColor: '#38bdf8', color: '#0f172a' }}
            >
              Sign In
            </button>
          </form>

        </div>

        <p className="text-center text-sm mt-6" style={{ color: '#94a3b8' }}>
          New here?{' '}
          <Link to="/signup" className="font-bold hover:underline" style={{ color: '#38bdf8' }}>Get your player account</Link>
        </p>
        <p className="text-center text-xs mt-3" style={{ color: '#475569' }}>
          <Link to="/" className="hover:underline" style={{ color: '#64748b' }}>Back to homepage</Link>
        </p>
      </div>
    </div>
  );
}
