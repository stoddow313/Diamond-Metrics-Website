// Create-account and sign-in forms, used inline at the start of a submission
// (so the customer never loses where they came from) and on /signup.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../lib/api';
import { Field, TextInput, Select, PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';

const GROUP_LABELS = { family: 'Family', team: 'Team', event: 'Event' };
const CONTACT_LABELS = { email: 'Email', text: 'Text message', phone: 'Phone call' };
const PASSWORD_MIN = 10;
export const LEGAL_NAME_HINT = 'Your legal name — it helps us verify athletes and teams.';

export function RoleSelect({ roles, value, onChange, id, required = false }) {
  const groups = Object.keys(GROUP_LABELS).map(g => [g, roles.filter(r => r.group === g)]).filter(([, rs]) => rs.length);
  return (
    <Select id={id} value={value} onChange={e => onChange(e.target.value)} required={required}>
      <option value="">Choose…</option>
      {groups.map(([g, rs]) => (
        <optgroup key={g} label={GROUP_LABELS[g]}>
          {rs.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
        </optgroup>
      ))}
    </Select>
  );
}

RoleSelect.labelable = true;

export function ContactChoice({ value, onChange }) {
  return (
    <div className="flex gap-2 flex-wrap" role="radiogroup" aria-label="Preferred contact">
      {Object.entries(CONTACT_LABELS).map(([key, label]) => (
        <button
          key={key} type="button" role="radio" aria-checked={value === key} onClick={() => onChange(key)}
          className="px-3 py-1.5 rounded-lg border text-xs font-bold cursor-pointer"
          style={value === key
            ? { borderColor: '#38bdf8', color: '#38bdf8', backgroundColor: 'rgba(56, 189, 248, 0.1)' }
            : { borderColor: '#334155', color: '#94a3b8' }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function CreateAccountForm({ config, initialEmail = '', onDone, onSignInInstead }) {
  const { adoptSession } = useAuth();
  const [f, setF] = useState({
    first_name: '', last_name: '', email: initialEmail, phone: '', role: '', preferred_contact: 'email', organization: '', password: '',
  });
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));
  const group = config.roles.find(r => r.key === f.role)?.group;

  async function submit(e) {
    e.preventDefault();
    setError(''); setCode('');
    if (f.password.length < PASSWORD_MIN) { setError(`Choose a password of at least ${PASSWORD_MIN} characters.`); return; }
    setBusy(true);
    try {
      const r = await api.customerSignup({ ...f, organization: group === 'family' ? '' : f.organization });
      adoptSession(r.token, r.user);
      onDone?.(r.user);
    } catch (err) {
      setError(err.message);
      setCode(err.code || '');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-testid="create-account-form">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="First name" hint={LEGAL_NAME_HINT}><TextInput value={f.first_name} onChange={e => set('first_name', e.target.value)} autoComplete="given-name" required /></Field>
        <Field label="Last name"><TextInput value={f.last_name} onChange={e => set('last_name', e.target.value)} autoComplete="family-name" required /></Field>
      </div>
      <Field label="Email" hint="We’ll send a link to confirm it. You can start right away; it needs confirming before you submit.">
        <TextInput type="email" value={f.email} onChange={e => set('email', e.target.value)} autoComplete="email" required />
      </Field>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="I am a…" hint="Submitting for an athlete under 18? A parent or legal guardian holds the account.">
          <RoleSelect roles={config.roles} value={f.role} onChange={v => set('role', v)} required />
        </Field>
        <Field label="Mobile phone"><TextInput type="tel" value={f.phone} onChange={e => set('phone', e.target.value)} autoComplete="tel" placeholder="Optional" /></Field>
      </div>
      {group && group !== 'family' && (
        <Field label={group === 'event' ? 'Event or organization' : 'Team or organization'}>
          <TextInput value={f.organization} onChange={e => set('organization', e.target.value)} autoComplete="organization" />
        </Field>
      )}
      <Field label="Best way to reach you"><ContactChoice value={f.preferred_contact} onChange={v => set('preferred_contact', v)} /></Field>
      <Field label="Password">
        <TextInput type="password" value={f.password} onChange={e => set('password', e.target.value)} autoComplete="new-password" minLength={PASSWORD_MIN} placeholder={`At least ${PASSWORD_MIN} characters`} required />
      </Field>
      <ErrorNote>{error}</ErrorNote>
      {['account_exists', 'login_exists'].includes(code) && onSignInInstead && (
        <GhostButton type="button" onClick={() => onSignInInstead(f.email)}>Sign in instead</GhostButton>
      )}
      <PrimaryButton type="submit" disabled={busy} className="py-3">{busy ? 'Creating your account…' : 'Create account'}</PrimaryButton>
    </form>
  );
}

export function SignInForm({ initialEmail = '', onDone, next = '' }) {
  const { login } = useAuth();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      const user = await login(email, password);
      onDone?.(user);
    } catch (err) {
      setError(err.message || 'Invalid email or password.');
    } finally {
      setBusy(false);
    }
  }

  const forgot = `/forgot-password${email ? `?email=${encodeURIComponent(email)}` : ''}${next ? `${email ? '&' : '?'}next=${encodeURIComponent(next)}` : ''}`;
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-testid="sign-in-form">
      <Field label="Email"><TextInput type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" required /></Field>
      <Field label="Password"><TextInput type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required /></Field>
      <ErrorNote>{error}</ErrorNote>
      <PrimaryButton type="submit" disabled={busy} className="py-3">{busy ? 'Signing in…' : 'Sign in'}</PrimaryButton>
      <Link to={forgot} className="text-xs font-bold hover:underline self-start" style={{ color: '#38bdf8' }}>Forgot your password?</Link>
    </form>
  );
}

// Tabs: create an account (default for a new visitor) or sign in.
export function AuthPanel({ config, onDone, next = '', initialTab = 'create' }) {
  const [tab, setTab] = useState(initialTab);
  const [email, setEmail] = useState('');
  const tabStyle = active => (active
    ? { color: '#f8fafc', borderColor: '#38bdf8' }
    : { color: '#64748b', borderColor: 'transparent' });
  return (
    <div>
      <div className="flex gap-6 border-b mb-5" style={{ borderColor: '#1e3a5f' }} role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'create'} onClick={() => setTab('create')}
          className="pb-2 -mb-px border-b-2 text-sm font-bold cursor-pointer" style={tabStyle(tab === 'create')}>Create account</button>
        <button type="button" role="tab" aria-selected={tab === 'signin'} onClick={() => setTab('signin')}
          className="pb-2 -mb-px border-b-2 text-sm font-bold cursor-pointer" style={tabStyle(tab === 'signin')}>Sign in</button>
      </div>
      {tab === 'create'
        ? <CreateAccountForm config={config} initialEmail={email} onDone={onDone} onSignInInstead={e => { setEmail(e); setTab('signin'); }} />
        : <SignInForm key={email} initialEmail={email} onDone={onDone} next={next} />}
    </div>
  );
}
