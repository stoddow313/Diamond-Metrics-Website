// Customer-side building blocks for footage intake, in the site's dark
// product theme (the same tokens as Sign in, the staff portal and Command).
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import BrandMark from '../../components/BrandMark';
import { InfoTip, Tooltip } from '../../components/Tooltip';
import { cardStyle, inputStyle } from '../../components/admin/theme';
import { useIntakeConfig, SUBMITTER_ROLES, STATUS_TONE } from '../../lib/intake';

const PAGE_BG = { background: 'linear-gradient(180deg, #06122b 0%, #081a3d 100%)' };
const HEADER = { borderColor: '#1e3a5f', backgroundColor: 'rgba(6, 18, 43, 0.9)' };

const navStyle = ({ isActive }) => ({ color: isActive ? '#38bdf8' : '#cfe8ff' });

// Chrome for every signed-in customer page. While the feature flag is off the
// pages say so instead of rendering a flow the API would refuse.
export function IntakeShell() {
  const { user, logout } = useAuth();
  const config = useIntakeConfig();
  const navigate = useNavigate();
  const submitter = user && SUBMITTER_ROLES.includes(user.role);

  return (
    <div className="min-h-screen" style={PAGE_BG}>
      <header className="border-b" style={HEADER}>
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-x-4 gap-y-2 flex-wrap">
          <div className="flex items-center gap-x-5 gap-y-2 flex-wrap min-w-0">
            <Link to="/" aria-label="Diamond Metrics home"><BrandMark /></Link>
            {submitter && config?.enabled && (
              <nav className="flex items-center gap-4 text-sm font-bold" aria-label="Your footage">
                <NavLink to="/submissions" end style={navStyle} className="hover:underline">My submissions</NavLink>
                <NavLink to="/submit" style={navStyle} className="hover:underline">Submit footage</NavLink>
                <NavLink to="/account" end style={navStyle} className="hover:underline">Account</NavLink>
              </nav>
            )}
          </div>
          <div className="flex items-center gap-3">
            {user ? (
              <>
                {user.role === 'staff' && <Link to="/staff" className="text-sm font-bold hover:underline" style={{ color: '#94a3b8' }}>Staff portal</Link>}
                {user.role === 'player' && <Link to="/me" className="text-sm font-bold hover:underline" style={{ color: '#94a3b8' }}>My profile</Link>}
                <span className="text-sm hidden sm:inline" style={{ color: '#94a3b8' }}>{user.name || user.email}</span>
                <button
                  type="button"
                  onClick={async () => { await logout(); navigate('/login'); }}
                  className="text-sm font-bold px-4 py-2 rounded-xl border cursor-pointer hover:bg-slate-800"
                  style={{ borderColor: '#334155', color: '#cfe8ff' }}
                >
                  Sign out
                </button>
              </>
            ) : (
              <Link to="/login" className="text-sm font-bold px-4 py-2 rounded-xl border hover:bg-slate-800" style={{ borderColor: '#334155', color: '#cfe8ff' }}>Sign in</Link>
            )}
          </div>
        </div>
      </header>
      {/* display:block overrides the marketing site's flex <main> (as Command does). */}
      <main className="max-w-5xl mx-auto px-4 py-8" style={{ display: 'block' }}>
        {config === null ? (
          <p style={{ color: '#94a3b8' }}>Loading…</p>
        ) : !config.enabled ? (
          <Card className="p-8 text-center max-w-xl mx-auto">
            <h1 className="text-xl font-bold text-white mb-2">Footage submission isn’t open yet</h1>
            <p className="text-sm mb-5" style={{ color: '#94a3b8' }}>
              {config.unavailable
                ? 'We could not reach Diamond Metrics just now. Please try again in a few minutes.'
                : 'We are getting online footage submission ready. In the meantime, our team is happy to help directly.'}
            </p>
            <Link to="/#contact" className="inline-block px-4 py-2 rounded-xl font-bold text-sm" style={{ backgroundColor: '#38bdf8', color: '#0f172a' }}>Contact us</Link>
          </Card>
        ) : (
          <Outlet />
        )}
      </main>
    </div>
  );
}

// A centred single-card page (sign-up, password reset, verification).
export function AuthFrame({ children, footer }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10" style={PAGE_BG}>
      <div className="w-full max-w-lg">
        <div className="flex justify-center mb-8"><Link to="/" aria-label="Diamond Metrics home"><BrandMark /></Link></div>
        {children}
        {footer}
      </div>
    </div>
  );
}

// A div, not a <section>: the marketing stylesheet sizes every `section h2`.
export function Card({ children, className = '', style, ...rest }) {
  return <div {...rest} className={`rounded-2xl border ${className}`} style={{ ...cardStyle, ...style }}>{children}</div>;
}

export function PageTitle({ eyebrow, title, children, actions, hint }) {
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap mb-6">
      <div className="min-w-0">
        {eyebrow && <p className="text-xs font-bold uppercase tracking-widest mb-1" style={{ color: '#38bdf8' }}>{eyebrow}</p>}
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold text-white">{title}</h1>
          {hint && <InfoTip label="About this page" size={16}>{hint}</InfoTip>}
        </div>
        {children && <div className="text-sm mt-1" style={{ color: '#94a3b8' }}>{children}</div>}
      </div>
      {actions && <div className="flex gap-2 flex-wrap items-center">{actions}</div>}
    </div>
  );
}

// The customer status; its one-line explanation is the tooltip.
export function StatusPill({ status, focusable = true }) {
  if (!status) return null;
  const tone = STATUS_TONE[status.key] || '#94a3b8';
  const pill = (
    <span className="inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full whitespace-nowrap"
      style={{ backgroundColor: 'rgba(30, 41, 59, 0.9)', color: tone }} data-status={status.key}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: tone }} aria-hidden="true" />
      {status.label}
    </span>
  );
  return status.detail ? <Tooltip content={status.detail} focusable={focusable} className="rounded-full">{pill}</Tooltip> : pill;
}

const TONES = {
  info: { bg: 'rgba(56, 189, 248, 0.08)', border: 'rgba(56, 189, 248, 0.35)', title: '#7dd3fc' },
  warn: { bg: 'rgba(251, 191, 36, 0.08)', border: 'rgba(251, 191, 36, 0.4)', title: '#fbbf24' },
  error: { bg: 'rgba(239, 68, 68, 0.1)', border: 'rgba(248, 113, 113, 0.45)', title: '#f87171' },
  success: { bg: 'rgba(74, 222, 128, 0.08)', border: 'rgba(74, 222, 128, 0.4)', title: '#4ade80' },
};

export function Banner({ tone = 'info', title, children, actions, className = '' }) {
  const t = TONES[tone];
  return (
    <div className={`rounded-xl border px-4 py-3 ${className}`} style={{ backgroundColor: t.bg, borderColor: t.border }} role={tone === 'error' ? 'alert' : 'status'}>
      {title && <p className="text-sm font-bold" style={{ color: t.title }}>{title}</p>}
      {children && <div className="text-sm mt-0.5" style={{ color: '#cbd5e1' }}>{children}</div>}
      {actions && <div className="flex gap-2 flex-wrap mt-3">{actions}</div>}
    </div>
  );
}

export function CheckRow({ checked, onChange, children, optional = false, disabled = false, testId }) {
  return (
    <label className={`flex items-start gap-3 py-1.5 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <input
        type="checkbox" checked={!!checked} disabled={disabled} data-testid={testId}
        onChange={e => onChange(e.target.checked)}
        className="mt-0.5 w-4 h-4 shrink-0 accent-sky-400 cursor-pointer"
      />
      <span className="text-sm" style={{ color: '#cbd5e1' }}>
        {children}
        {optional && <span className="ml-1.5 text-xs" style={{ color: '#64748b' }}>(optional)</span>}
      </span>
    </label>
  );
}

export function TextArea(props) {
  return (
    <textarea
      rows={3}
      {...props}
      className={`w-full px-3 py-2 rounded-lg border text-white text-sm outline-none focus:border-sky-400 ${props.className || ''}`}
      style={{ ...inputStyle, ...props.style }}
    />
  );
}

TextArea.labelable = true;

export function ProgressBar({ pct, tone = '#38bdf8' }) {
  const width = Math.max(0, Math.min(100, Math.round((pct || 0) * 100)));
  return (
    <div className="w-full rounded-full h-1.5 overflow-hidden" style={{ backgroundColor: 'rgba(30, 41, 59, 0.9)' }}
      role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={width}>
      <div className="h-1.5 rounded-full transition-all" style={{ width: `${width}%`, backgroundColor: tone }} />
    </div>
  );
}

// Capture findings (server captureIssues / submissionCaptureNotes): 'action'
// needs the customer and is spelled out; a 'warning' (may limit metrics) or
// 'tip' is a short chip whose full sentence is the tooltip.
const SEVERITY = {
  warning: { Icon: TriangleAlert, fg: '#fbbf24', bg: 'rgba(251, 191, 36, 0.12)' },
  tip: { Icon: Info, fg: '#94a3b8', bg: 'rgba(148, 163, 184, 0.12)' },
  action: { Icon: CircleAlert, fg: '#f87171', bg: 'rgba(248, 113, 113, 0.12)' },
};
const ISSUE_LABEL = {
  portrait: () => 'Vertical video',
  resolution_below_minimum: t => { const m = /(\d{3,4})p/.exec(t); return m ? `${m[1]}p video` : 'Below 1080p'; },
  frame_rate_below_minimum: t => { const m = /is ([\d.]+) frames/.exec(t); return m ? `${m[1]} fps video` : 'Low frame rate'; },
  frame_rate_below_preferred: () => '60 fps is better',
  side_frame_rate_below_preferred: () => 'Side angle under 120 fps',
  short_for_full_game: () => 'Short for a full game',
  pro_without_side_angle: () => 'No side angle',
  no_primary_view: () => 'No behind-home view',
};

export function IssueChip({ issue, prefix = '' }) {
  const tone = SEVERITY[issue.severity] || SEVERITY.tip;
  const label = ISSUE_LABEL[issue.code]?.(issue.text) || (issue.severity === 'tip' ? 'Tip' : 'Note');
  return (
    <Tooltip content={`${prefix}${issue.text}`} className="rounded-full">
      <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap"
        style={{ backgroundColor: tone.bg, color: tone.fg }} data-issue={issue.code}>
        <tone.Icon size={12} strokeWidth={2.4} aria-hidden="true" />{label}
      </span>
    </Tooltip>
  );
}

export function Issues({ issues = [], prefix = '', className = 'mt-1.5' }) {
  if (!issues.length) return null;
  const actions = issues.filter(i => i.severity === 'action');
  const rest = issues.filter(i => i.severity !== 'action');
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      {actions.map(i => <p key={i.code} className="text-xs" style={{ color: '#f87171' }} data-issue={i.code}>{i.text}</p>)}
      {rest.length > 0 && <div className="flex gap-1.5 flex-wrap">{rest.map(i => <IssueChip key={i.code} issue={i} prefix={prefix} />)}</div>}
    </div>
  );
}

export function SectionTitle({ children, aside, hint }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3">
      <div className="flex items-center gap-1.5 min-w-0">
        <h2 className="font-bold uppercase tracking-wider" style={{ color: '#cfe8ff', fontSize: '0.875rem', lineHeight: '1.25rem', margin: 0 }}>{children}</h2>
        {hint && <InfoTip label={typeof children === 'string' ? `Help: ${children}` : 'Help'}>{hint}</InfoTip>}
      </div>
      {aside}
    </div>
  );
}
