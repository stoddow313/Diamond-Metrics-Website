import { Link } from 'react-router-dom';
import BrandMark from '../components/BrandMark';

// Accounts are invite-based: operators create the athlete profile, then send
// an invite link. This page explains that to anyone who lands on "Sign up".
export default function SignupInfoPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: 'linear-gradient(180deg, #06122b 0%, #081a3d 100%)' }}>
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-10"><BrandMark /></div>

        <div className="rounded-2xl border p-8 text-center" style={{ backgroundColor: 'rgba(15, 23, 42, 0.78)', borderColor: '#1e3a5f' }}>
          <h2 className="text-2xl font-bold text-white mb-3">Get your player account</h2>
          <p className="text-sm mb-4" style={{ color: '#94a3b8' }}>
            Diamond Metrics accounts are created by your program. After your athlete's data is captured
            at a game, showcase, or Pro Day, you'll receive a personal <b className="text-white">invite link</b> —
            open it to set your email and password, then sign in anytime to see your player's profile and stats.
          </p>
          <p className="text-sm mb-8" style={{ color: '#94a3b8' }}>
            Haven't received a link? Reach out to your coach or the Diamond Metrics team.
          </p>
          <div className="flex flex-col gap-3">
            <Link to="/login" className="w-full py-3 rounded-xl font-bold text-sm transition-transform hover:-translate-y-0.5"
              style={{ backgroundColor: '#38bdf8', color: '#0f172a' }}>
              Already claimed? Sign in
            </Link>
            <Link to="/#contact" className="w-full py-3 rounded-xl font-bold text-sm border hover:bg-slate-800"
              style={{ borderColor: '#334155', color: '#cfe8ff' }}>
              Contact us
            </Link>
          </div>
        </div>

        <p className="text-center text-xs mt-6">
          <Link to="/" className="hover:underline" style={{ color: '#64748b' }}>Back to homepage</Link>
        </p>
      </div>
    </div>
  );
}
