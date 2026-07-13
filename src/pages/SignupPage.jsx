import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import BrandMark from '../components/BrandMark';

export default function SignupPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [teamName, setTeamName] = useState('');
  const [password, setPassword] = useState('');
  const { signup } = useAuth();
  const navigate = useNavigate();

  function handleSubmit(e) {
    e.preventDefault();
    signup(name, email, password, teamName);
    navigate('/app');
  }

  const inputStyle = { backgroundColor: 'rgba(30, 41, 59, 0.95)', borderColor: '#334155' };

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: 'linear-gradient(180deg, #06122b 0%, #081a3d 100%)' }}>
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-10">
          <BrandMark />
        </div>

        <div className="rounded-2xl border p-8" style={{ backgroundColor: 'rgba(15, 23, 42, 0.78)', borderColor: '#1e3a5f' }}>
          <h2 className="text-2xl font-bold text-white mb-1">Create your account</h2>
          <p className="text-sm mb-8" style={{ color: '#94a3b8' }}>Get started with Diamond Metrics</p>

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <label className="text-sm font-bold" style={{ color: '#cfe8ff' }}>Full Name</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Coach Smith"
                required
                className="w-full px-4 py-3 rounded-xl border text-white text-sm outline-none transition-all focus:shadow-[0_0_0_3px_rgba(56,189,248,0.12)]"
                style={inputStyle}
                onFocus={e => e.target.style.borderColor = '#38bdf8'}
                onBlur={e => e.target.style.borderColor = '#334155'}
              />
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-sm font-bold" style={{ color: '#cfe8ff' }}>Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="coach@school.edu"
                required
                className="w-full px-4 py-3 rounded-xl border text-white text-sm outline-none transition-all focus:shadow-[0_0_0_3px_rgba(56,189,248,0.12)]"
                style={inputStyle}
                onFocus={e => e.target.style.borderColor = '#38bdf8'}
                onBlur={e => e.target.style.borderColor = '#334155'}
              />
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-sm font-bold" style={{ color: '#cfe8ff' }}>Team Name</label>
              <input
                type="text"
                value={teamName}
                onChange={e => setTeamName(e.target.value)}
                placeholder="Westlake Thunder"
                className="w-full px-4 py-3 rounded-xl border text-white text-sm outline-none transition-all focus:shadow-[0_0_0_3px_rgba(56,189,248,0.12)]"
                style={inputStyle}
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
                placeholder="Create a password"
                required
                className="w-full px-4 py-3 rounded-xl border text-white text-sm outline-none transition-all focus:shadow-[0_0_0_3px_rgba(56,189,248,0.12)]"
                style={inputStyle}
                onFocus={e => e.target.style.borderColor = '#38bdf8'}
                onBlur={e => e.target.style.borderColor = '#334155'}
              />
            </div>

            <button
              type="submit"
              className="w-full py-3 rounded-xl font-bold text-sm transition-transform hover:-translate-y-0.5 cursor-pointer"
              style={{ backgroundColor: '#38bdf8', color: '#0f172a' }}
            >
              Create Account
            </button>
          </form>

          <p className="text-center text-sm mt-6" style={{ color: '#94a3b8' }}>
            Already have an account?{' '}
            <Link to="/login" className="font-semibold hover:underline" style={{ color: '#38bdf8' }}>Sign in</Link>
          </p>
        </div>

        <p className="text-center text-xs mt-6" style={{ color: '#475569' }}>
          <Link to="/" className="hover:underline" style={{ color: '#64748b' }}>Back to homepage</Link>
        </p>
      </div>
    </div>
  );
}
