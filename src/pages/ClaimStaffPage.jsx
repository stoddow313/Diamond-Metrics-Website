import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, setToken } from '../lib/api';
import BrandMark from '../components/BrandMark';

// Coach/director account claim — the admin assigns an email to a team or
// tournament and sends this link; claiming sets name + password.
export default function ClaimStaffPage() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [lookupError, setLookupError] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.staffInviteInfo(token)
      .then(setInfo)
      .catch(() => setLookupError('This invite link is invalid. Ask Diamond Metrics for a new one.'));
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
      const { token: session } = await api.claimStaffInvite(token, name, password);
      setToken(session);
      window.location.href = '/staff';
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const inputClass = 'w-full px-4 py-3 rounded-xl border text-white text-sm outline-none focus:border-sky-400';
  const inputStyle = { backgroundColor: 'rgba(30, 41, 59, 0.95)', borderColor: '#334155' };
  const assignments = info ? [...(info.teams || []), ...(info.tournaments || [])] : [];

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
              <Link to="/login" className="font-bold hover:underline" style={{ color: '#38bdf8' }}>Sign in instead</Link>
            </div>
          ) : info.expired ? (
            <div className="text-center">
              <h2 className="text-xl font-bold text-white mb-2">Invite expired</h2>
              <p className="text-sm" style={{ color: '#94a3b8' }}>Ask Diamond Metrics to send a fresh invite link.</p>
            </div>
          ) : (
            <>
              <h2 className="text-2xl font-bold text-white mb-1">Set up your staff account</h2>
              <p className="text-sm mb-2" style={{ color: '#94a3b8' }}>
                For <b className="text-white">{info.email}</b>
              </p>
              {assignments.length > 0 && (
                <p className="text-xs mb-6" style={{ color: '#64748b' }}>
                  You'll have access to: {assignments.join(', ')}
                </p>
              )}

              {error && (
                <p className="text-sm text-center py-3 rounded-xl mb-4" style={{ backgroundColor: 'rgba(239, 68, 68, 0.12)', color: '#f87171' }}>{error}</p>
              )}

              <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-bold" style={{ color: '#cfe8ff' }}>Your name</label>
                  <input type="text" required value={name} onChange={e => setName(e.target.value)}
                    placeholder="Coach Johnson" className={inputClass} style={inputStyle} />
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-bold" style={{ color: '#cfe8ff' }}>Password</label>
                  <input type="password" required minLength={8} value={password} onChange={e => setPassword(e.target.value)}
                    placeholder="At least 8 characters" className={inputClass} style={inputStyle} />
                </div>
                <div className="flex flex-col gap-2">
                  <label className="text-sm font-bold" style={{ color: '#cfe8ff' }}>Confirm password</label>
                  <input type="password" required value={confirm} onChange={e => setConfirm(e.target.value)}
                    className={inputClass} style={inputStyle} />
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
