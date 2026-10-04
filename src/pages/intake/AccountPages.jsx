// Customer account pages (customer footage submission §4): create an account,
// verify the email, reset a password, and the account page itself.
import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../lib/api';
import { useIntakeConfig, safeNext, homeFor, fmtDate } from '../../lib/intake';
import { Field, TextInput, PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import SignupInfoPage from '../SignupInfoPage';
import { AuthFrame, Card, PageTitle, Banner, TextArea, SectionTitle } from './ui';
import { CreateAccountForm, RoleSelect, ContactChoice, LEGAL_NAME_HINT } from './AuthForms';
import { InfoTip } from '../../components/Tooltip';

const muted = { color: '#94a3b8' };

// /signup: self-serve accounts while intake is on; otherwise the existing
// invite-only explanation.
export function SignupRoute() {
  const config = useIntakeConfig();
  const { user, loading } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get('next'));
  if (config === null || loading) return null;
  if (!config.enabled) return <SignupInfoPage />;
  if (user) return <Navigate to={next || homeFor(user)} replace />;
  return (
    <AuthFrame footer={(
      <p className="text-center text-sm mt-6" style={muted}>
        Already have an account?{' '}
        <Link to={`/login${next ? `?next=${encodeURIComponent(next)}` : ''}`} className="font-bold hover:underline" style={{ color: '#38bdf8' }}>Sign in</Link>
      </p>
    )}>
      <Card className="p-8">
        <h1 className="text-2xl font-bold text-white mb-6">Create your account</h1>
        <CreateAccountForm config={config} onDone={() => navigate(next || '/submissions', { replace: true })} />
      </Card>
      <p className="text-xs text-center mt-4" style={{ color: '#64748b' }}>
        Have an invite from your program? Open that link instead.
      </p>
    </AuthFrame>
  );
}

export function ForgotPasswordPage() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get('email') || '');
  const [sent, setSent] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(''); setBusy(true);
    try { setSent(await api.customerForgotPassword(email)); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <AuthFrame footer={<p className="text-center text-sm mt-6"><Link to="/login" className="font-bold hover:underline" style={{ color: '#38bdf8' }}>Back to sign in</Link></p>}>
      <Card className="p-8">
        <h1 className="text-2xl font-bold text-white mb-1">Reset your password</h1>
        {sent ? (
          <div className="mt-4 flex flex-col gap-4">
            <Banner tone="success" title="Check your email">
              If an account exists for {email}, we sent a link to reset the password. It works once, for one hour.
            </Banner>
            {!sent.email_delivery && (
              <Banner tone="warn" title="Email isn’t switched on yet">
                We can’t send the link automatically right now. <Link to="/#contact" className="font-bold underline">Contact us</Link> and we’ll help you get back in.
              </Banner>
            )}
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4 mt-4">
            <p className="text-sm" style={muted}>Enter the email you signed up with and we’ll send you a reset link.</p>
            <Field label="Email"><TextInput type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" required /></Field>
            <ErrorNote>{error}</ErrorNote>
            <PrimaryButton type="submit" disabled={busy} className="py-3">{busy ? 'Sending…' : 'Send reset link'}</PrimaryButton>
            <p className="text-xs" style={{ color: '#64748b' }}>Coach-portal and player-profile logins: ask your Diamond Metrics contact to reset those.</p>
          </form>
        )}
      </Card>
    </AuthFrame>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const { user, logout } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (password !== confirm) { setError('The two passwords do not match.'); return; }
    setBusy(true);
    try {
      await api.customerResetPassword(token, password);
      // The reset signs every session out, this browser's included.
      if (user) await logout();
      setDone(true);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <AuthFrame>
      <Card className="p-8">
        <h1 className="text-2xl font-bold text-white mb-4">Choose a new password</h1>
        {!token ? (
          <Banner tone="error" title="This link is incomplete">Open the link from your email again, or <Link to="/forgot-password" className="font-bold underline">request a new one</Link>.</Banner>
        ) : done ? (
          <div className="flex flex-col gap-4">
            <Banner tone="success" title="Password updated">You’ve been signed out everywhere. Sign in with your new password.</Banner>
            <Link to="/login" className="text-center py-3 rounded-xl font-bold text-sm" style={{ backgroundColor: '#38bdf8', color: '#0f172a' }}>Sign in</Link>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field label="New password (at least 10 characters)"><TextInput type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" minLength={10} required /></Field>
            <Field label="Type it again"><TextInput type="password" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" required /></Field>
            <ErrorNote>{error}</ErrorNote>
            {/expired|already been used|not valid/.test(error) && <Link to="/forgot-password" className="text-sm font-bold hover:underline" style={{ color: '#38bdf8' }}>Request a new link</Link>}
            <PrimaryButton type="submit" disabled={busy} className="py-3">{busy ? 'Saving…' : 'Save new password'}</PrimaryButton>
          </form>
        )}
      </Card>
    </AuthFrame>
  );
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const { user, refresh } = useAuth();
  const [state, setState] = useState(token ? { status: 'working' } : { status: 'error', error: 'This verification link is incomplete.' });
  const sent = useRef(false);

  useEffect(() => {
    // A token is single-use: never send it twice (StrictMode runs effects twice).
    if (!token || sent.current) return;
    sent.current = true;
    api.customerVerify(token)
      .then(r => { setState({ status: 'ok', email: r.email }); refresh().catch(() => {}); })
      .catch(err => setState({ status: 'error', error: err.message }));
  }, [token, refresh]);

  return (
    <AuthFrame>
      <Card className="p-8">
        <h1 className="text-2xl font-bold text-white mb-4">Verify your email</h1>
        {state.status === 'working' && <p style={muted}>Checking your link…</p>}
        {state.status === 'ok' && (
          <div className="flex flex-col gap-4">
            <Banner tone="success" title="Email verified">{state.email} is confirmed. You can submit footage now.</Banner>
            <Link to={user ? '/submissions' : '/login?next=%2Fsubmissions'} className="text-center py-3 rounded-xl font-bold text-sm" style={{ backgroundColor: '#38bdf8', color: '#0f172a' }}>
              {user ? 'Go to my submissions' : 'Sign in to continue'}
            </Link>
          </div>
        )}
        {state.status === 'error' && (
          <div className="flex flex-col gap-4">
            <Banner tone="error" title="We couldn’t verify this link">{state.error}</Banner>
            <Link to={user ? '/account' : '/login?next=%2Faccount'} className="text-center py-3 rounded-xl font-bold text-sm border" style={{ borderColor: '#334155', color: '#cfe8ff' }}>
              {user ? 'Send a new link from your account' : 'Sign in to request a new link'}
            </Link>
          </div>
        )}
      </Card>
    </AuthFrame>
  );
}

// "Verify your email" with a resend button — on the submissions list, the
// account page and the review step. Without an email provider the customer
// is told our team will confirm the address for them.
export function EmailVerifyBanner({ me, onChecked }) {
  const [state, setState] = useState('');
  const [error, setError] = useState('');
  if (!me || me.account.email_verified) return null;
  async function resend() {
    setError(''); setState('sending');
    try {
      const r = await api.customerResendVerification();
      setState(r.email_delivery ? 'sent' : 'manual');
    } catch (err) { setError(err.message); setState(''); }
  }
  const manual = !me.email_delivery || state === 'manual';
  return (
    <Banner
      tone="warn" title="Verify your email to submit"
      actions={(
        <>
          {!manual && <GhostButton type="button" onClick={resend} disabled={state === 'sending'}>{state === 'sent' ? 'Sent — send again' : state === 'sending' ? 'Sending…' : 'Resend link'}</GhostButton>}
          {onChecked && <GhostButton type="button" onClick={onChecked}>Check again</GhostButton>}
        </>
      )}
    >
      <span className="inline-flex items-center gap-1.5 flex-wrap">
        {manual
          ? <>Our team will confirm <b className="text-white">{me.account.email}</b> for you.<InfoTip label="Why">Email isn’t switched on yet. Finish everything else now — submitting unlocks once the address is confirmed.</InfoTip></>
          : <>We sent a link to <b className="text-white">{me.account.email}</b>.<InfoTip label="What to do">Open it to confirm the address. Your draft stays saved here.</InfoTip></>}
      </span>
      {error && <span className="block mt-1" style={{ color: '#f87171' }}>{error}</span>}
    </Banner>
  );
}

export function AccountPage() {
  const config = useIntakeConfig();
  const [me, setMe] = useState(null);
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [deletion, setDeletion] = useState({ open: false, note: '', done: null, error: '' });

  const load = () => api.customerMe().then(r => {
    setMe(r);
    setForm({ first_name: r.account.first_name, last_name: r.account.last_name, phone: r.account.phone || '', role: r.account.role, preferred_contact: r.account.preferred_contact || 'email', organization: r.account.organization || '' });
  }).catch(err => setError(err.message));
  useEffect(() => { load(); }, []);

  async function save(e) {
    e.preventDefault();
    setError(''); setSaved(''); setBusy(true);
    try { await api.customerUpdateMe(form); setSaved('Saved.'); load(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function requestDeletion() {
    setDeletion(d => ({ ...d, error: '' }));
    try {
      const r = await api.intakeRequestAccountDeletion(deletion.note);
      setDeletion(d => ({ ...d, open: false, done: r.request }));
    } catch (err) { setDeletion(d => ({ ...d, error: err.message })); }
  }

  if (!me || !form) return <><ErrorNote>{error}</ErrorNote>{!error && <p style={muted}>Loading your account…</p>}</>;
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const group = config?.roles.find(r => r.key === form.role)?.group;
  return (
    <div className="flex flex-col gap-6">
      <PageTitle eyebrow="Account" title={`${me.account.first_name} ${me.account.last_name}`.trim() || me.account.email}>
        {me.account.email}{me.account.email_verified ? ' · verified' : ''}
      </PageTitle>
      <EmailVerifyBanner me={me} onChecked={load} />

      <Card className="p-6">
        <SectionTitle>Your details</SectionTitle>
        <form onSubmit={save} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="First name" hint={LEGAL_NAME_HINT}><TextInput value={form.first_name} onChange={e => set('first_name', e.target.value)} required /></Field>
            <Field label="Last name"><TextInput value={form.last_name} onChange={e => set('last_name', e.target.value)} required /></Field>
            <Field label="Mobile phone"><TextInput type="tel" value={form.phone} onChange={e => set('phone', e.target.value)} /></Field>
            <Field label="I am usually a…">{config && <RoleSelect roles={config.roles} value={form.role} onChange={v => set('role', v)} />}</Field>
          </div>
          {group && group !== 'family' && (
            <Field label="Team or organization"><TextInput value={form.organization} onChange={e => set('organization', e.target.value)} /></Field>
          )}
          <Field label="Best way to reach you"><ContactChoice value={form.preferred_contact} onChange={v => set('preferred_contact', v)} /></Field>
          <ErrorNote>{error}</ErrorNote>
          <div className="flex items-center gap-3">
            <PrimaryButton type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</PrimaryButton>
            {saved && <span className="text-sm" style={{ color: '#4ade80' }}>{saved}</span>}
          </div>
        </form>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="p-6">
          <SectionTitle>Your athletes</SectionTitle>
          {me.athletes.length === 0 ? (
            <p className="text-sm flex items-center gap-1.5" style={muted}>None yet <InfoTip>Athletes are linked to your account after our team verifies them from a submission.</InfoTip></p>
          ) : (
            <ul className="flex flex-col gap-2">
              {me.athletes.map(a => (
                <li key={a.player_id} className="text-sm flex justify-between gap-3">
                  <span className="text-white font-bold">{a.first_name} {a.last_name}</span>
                  <span style={muted}>{a.slug ? <Link to={`/p/${a.slug}`} className="hover:underline" style={{ color: '#38bdf8' }}>Profile</Link> : 'Private profile'}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="p-6">
          <SectionTitle>Your teams</SectionTitle>
          {me.teams.length === 0 ? (
            <p className="text-sm flex items-center gap-1.5" style={muted}>None yet <InfoTip>Teams are linked after our team confirms a team submission.</InfoTip></p>
          ) : (
            <ul className="flex flex-col gap-2">
              {me.teams.map(t => <li key={t.team_id} className="text-sm text-white font-bold">{t.name}{t.age_group ? <span className="font-normal" style={muted}> · {t.age_group}</span> : ''}</li>)}
            </ul>
          )}
        </Card>
      </div>

      <Card className="p-6">
        <SectionTitle>Sign-in and privacy</SectionTitle>
        <div className="flex flex-col gap-4 text-sm" style={{ color: '#cbd5e1' }}>
          {me.account.via === 'customer' ? (
            <p>To change your password, <Link to={`/forgot-password?email=${encodeURIComponent(me.account.email)}`} className="font-bold hover:underline" style={{ color: '#38bdf8' }}>send yourself a reset link</Link>.</p>
          ) : (
            <p>You sign in with your {me.account.via === 'staff' ? 'coach portal' : 'player profile'} login; your footage submissions live under the same email.</p>
          )}
          {deletion.done ? (
            <Banner tone="info" title="Deletion request received">Requested {fmtDate(deletion.done.created_at)}. Our team will confirm what is deleted and contact you.</Banner>
          ) : deletion.open ? (
            <div className="flex flex-col gap-3">
              <Banner tone="warn" title="Delete your account and footage?">
                <span className="inline-flex items-center gap-1.5">Our team deletes them and confirms with you.
                  <InfoTip>Results already published may stay on an athlete’s profile unless you ask us to withdraw them.</InfoTip></span>
              </Banner>
              <Field label="Anything we should know? (optional)"><TextArea value={deletion.note} onChange={e => setDeletion(d => ({ ...d, note: e.target.value }))} /></Field>
              <ErrorNote>{deletion.error}</ErrorNote>
              <div className="flex gap-2">
                <PrimaryButton type="button" onClick={requestDeletion} style={{ backgroundColor: '#f87171' }}>Request deletion</PrimaryButton>
                <GhostButton type="button" onClick={() => setDeletion(d => ({ ...d, open: false }))}>Cancel</GhostButton>
              </div>
            </div>
          ) : (
            <div>
              <GhostButton type="button" onClick={() => setDeletion(d => ({ ...d, open: true }))}>Ask us to delete my account and footage</GhostButton>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
