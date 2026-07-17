import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, setToken } from '../lib/api';
import BrandMark from '../components/BrandMark';

// Invite-claim: the operator sends a per-player link; the player/parent sets
// an email + password here and lands in their portal.
export default function ClaimPage() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [lookupError, setLookupError] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.inviteInfo(token)
      .then(setInfo)
      .catch(() => setLookupError('This invite link is invalid. Ask your program for a new one.'));
  }, [token]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const { token: session } = await api.claimInvite(token, email, password);
      setToken(session);
      window.location.href = '/me'; // full reload so AuthContext picks up the session
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const inputClass = 'w-full px-4 py-3 rounded-xl border text-white text-sm outline-none focus:border-sky-400';
  const inputStyle = { backgroundColor: 'rgba(30, 41, 59, 0.95)', borderColor: '#334155' };

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: 'linear-gradient(180deg, #06122b 0%, #081a3d 100%)' }}>
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-10"><BrandMark /></div>

        <div className="rounded-2xl border p-8" style={{ backgroundColor: 'rgba(15, 23, 42, 0.78)', borderColor: '#1e3a5f' }}>
          {lookupError ? (
            <p className="text-sm text-center py-3" style={{ color: '#f87171' }}>{lookupError}</p>
          ) : !info ? (
            <p className="text-sm text-center" style={{ color: '#94a3b8' }}>Checking your invite…</p>
          ) : info.claimed ? (
            <div className="text-center">
              <h2 className="text-xl font-bold text-white mb-2">Already claimed</h2>
              <p className="text-sm mb-6" style={{ color: '#94a3b8' }}>
                This invite for {info.player.first_name} {info.player.last_name} has already been used.
              </p>
              <Link to="/login" className="font-bold hover:underline" style={{ color: '#38bdf8' }}>Sign in instead</Link>
            </div>
          ) : info.expired ? (
            <div className="text-center">
              <h2 className="text-xl font-bold text-white mb-2">Invite expired</h2>
              <p className="text-sm" style={{ color: '#94a3b8' }}>Ask your program to send a fresh invite link.</p>
            </div>
          ) : (
            <>
              <h2 className="text-2xl font-bold text-white mb-1">Claim your account</h2>
              <p className="text-sm mb-8" style={{ color: '#94a3b8' }}>
                Set up login details for <b className="text-white">{info.player.first_name} {info.player.last_name}</b>'s Diamond Metrics profile.
              </p>

              {error && (
                <p className="text-sm text-center py-3 rounded-xl mb-4" style={{ backgroundColor: 'rgba(239, 68, 68, 0.12)', color: '#f87171' }}>{error}</p>
              )}

              <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-bold" style={{ color: '#cfe8ff' }}>Email</label>
                  <input type="email" required value={email} onChange={e => setEmail(e.target.value)}
                    placeholder="you@example.com" className={inputClass} style={inputStyle} />
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-bold" style={{ color: '#cfe8ff' }}>Password</label>
                  <input type="password" required minLength={8} value={password} onChange={e => setPassword(e.target.value)}
                    placeholder="At least 8 characters" className={inputClass} style={inputStyle} />
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-bold" style={{ color: '#cfe8ff' }}>Confirm password</label>
                  <input type="password" required value={confirm} onChange={e => setConfirm(e.target.value)}
                    placeholder="Repeat your password" className={inputClass} style={inputStyle} />
                </div>
                <button type="submit" disabled={busy}
                  className="w-full py-3 rounded-xl font-bold text-sm cursor-pointer transition-transform hover:-translate-y-0.5 disabled:opacity-60"
                  style={{ backgroundColor: '#38bdf8', color: '#0f172a' }}>
                  {busy ? 'Creating account…' : 'Create account'}
                </button>
              </form>
            </>
          )}
        </div>

        <p className="text-center text-xs mt-6">
          <Link to="/" className="hover:underline" style={{ color: '#64748b' }}>Back to homepage</Link>
        </p>
      </div>
    </div>
  );
}
