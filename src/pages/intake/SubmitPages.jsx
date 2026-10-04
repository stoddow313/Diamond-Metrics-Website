// Submit Footage (customer footage submission §3–§6): every CTA lands on
// /submit, which signs the customer in or up without losing where they came
// from, then opens a saved draft at /submit/:publicId — a short guided
// sequence that survives sign-out, refresh and an interrupted upload.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Check, LoaderCircle } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { InfoTip, Tooltip } from '../../components/Tooltip';
import { api } from '../../lib/api';
import { useIntakeConfig, SUBMITTER_ROLES, timeAgo, fmtDate } from '../../lib/intake';
import { PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import { Card, PageTitle, Banner, StatusPill } from './ui';
import { AuthPanel } from './AuthForms';
import { EmailVerifyBanner } from './AccountPages';
import UploadPanel from './UploadPanel';
import { stepsFor, stepProblems } from './wizard';
import { RoleStep, ServiceStep, GameStep, AthletesStep, FootageStep, TermsStep, ReviewStep } from './WizardSteps';

const muted = { color: '#94a3b8' };
const PATH = ['Choose a package', 'Tell us about the game', 'Upload your footage', 'Get verified results'];
const REVIEWED = 'Every result is reviewed by a person. Anything we can’t verify from your footage is shown with the reason — never as a zero.';

// What the link carried: source page, package, player, order (§3 step 1, §4).
function intakeParams(params) {
  const all = Object.fromEntries(params.entries());
  return {
    source_page: all.source || 'direct',
    source_params: all,
    package_key: all.package || '',
    order_reference: all.order || '',
    player_slug: all.player || '',
  };
}

export function InternalSubmitterNotice() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <Card className="p-8 max-w-xl mx-auto text-center">
      <h1 className="text-xl font-bold text-white mb-2">You’re signed in with a Diamond Metrics staff login</h1>
      <p className="text-sm mb-5" style={muted}>Customer submissions need a customer, coach or player login. Sign out and sign in as the customer to try the flow.</p>
      <div className="flex gap-2 justify-center">
        <PrimaryButton type="button" onClick={async () => { await logout(); navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`); }}>Sign out</PrimaryButton>
        <Link to="/command/intake" className="px-4 py-2 rounded-xl font-bold text-sm border hover:bg-slate-800" style={{ borderColor: '#334155', color: '#cfe8ff' }}>Intake queue</Link>
      </div>
    </Card>
  );
}

export function SubmitStartPage() {
  const config = useIntakeConfig();
  const { user, loading } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [drafts, setDrafts] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const creating = useRef(false);
  const submitter = user && SUBMITTER_ROLES.includes(user.role);
  const carried = useMemo(() => intakeParams(params), [params]);

  const begin = useCallback(async () => {
    if (creating.current) return;   // StrictMode runs effects twice; one draft only
    creating.current = true;
    setBusy(true); setError('');
    try {
      const { submission } = await api.intakeCreateDraft(carried);
      navigate(`/submit/${submission.public_id}`, { replace: true });
    } catch (err) {
      setError(err.message);
      creating.current = false;
    } finally {
      setBusy(false);
    }
  }, [carried, navigate]);

  // Signed in: continue a draft, or start one straight away if there is none.
  useEffect(() => {
    if (!submitter) return undefined;
    let live = true;
    api.intakeSubmissions()
      .then(({ submissions }) => {
        if (!live) return;
        const open = submissions.filter(s => s.status.key === 'draft');
        if (open.length === 0) begin();
        else setDrafts(open);
      })
      .catch(err => live && setError(err.message));
    return () => { live = false; };
  }, [submitter, begin]);

  if (loading || !config) return null;
  if (user && !submitter) return <InternalSubmitterNotice />;

  if (!user) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] gap-8 items-start">
        <div>
          <PageTitle eyebrow="Submit footage" title="Turn game footage into verified results" />
          <ol className="flex flex-col gap-3">
            {PATH.map((step, i) => (
              <li key={step} className="flex items-center gap-3 text-sm" style={{ color: '#cbd5e1' }}>
                <span className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0" style={{ backgroundColor: 'rgba(56, 189, 248, 0.12)', color: '#38bdf8' }}>{i + 1}</span>
                {step}
                {i === PATH.length - 1 && <InfoTip label="How results are verified">{REVIEWED}</InfoTip>}
              </li>
            ))}
          </ol>
        </div>
        <Card className="p-6">
          <AuthPanel config={config} next={`/submit?${params.toString()}`} onDone={() => { /* the effect above takes over once signed in */ }} />
        </Card>
      </div>
    );
  }

  if (drafts) {
    return (
      <div className="max-w-2xl">
        <PageTitle eyebrow="Submit footage" title="Pick up where you left off?" />
        <div className="flex flex-col gap-3">
          {drafts.map(d => (
            <Card key={d.public_id} className="p-4 flex items-center justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <p className="text-sm font-bold text-white flex items-center gap-2">{d.public_id} <StatusPill status={d.status} /></p>
                <p className="text-xs mt-1" style={muted}>
                  {[d.package_label, d.game_date && fmtDate(d.game_date), d.team, d.athletes.join(', ')].filter(Boolean).join(' · ') || 'Just started'} · updated {timeAgo(d.updated_at)}
                </p>
              </div>
              <Link to={`/submit/${d.public_id}`} className="px-4 py-2 rounded-xl font-bold text-sm" style={{ backgroundColor: '#38bdf8', color: '#0f172a' }}>Continue</Link>
            </Card>
          ))}
        </div>
        <ErrorNote>{error}</ErrorNote>
        <div className="mt-6"><GhostButton type="button" onClick={begin} disabled={busy}>{busy ? 'Starting…' : 'Start a new submission instead'}</GhostButton></div>
      </div>
    );
  }

  return error ? <ErrorNote>{error}</ErrorNote> : <p style={muted}>Starting your submission…</p>;
}

const pickProfile = a => ({ first_name: a.first_name || '', last_name: a.last_name || '', phone: a.phone || '', preferred_contact: a.preferred_contact || 'email', organization: a.organization || '' });

export function SubmitWizardPage() {
  const { publicId } = useParams();
  const navigate = useNavigate();
  const config = useIntakeConfig();
  const [sub, setSub] = useState(null);
  const [form, setForm] = useState(null);
  const [me, setMe] = useState(null);
  const [profile, setProfile] = useState(null);
  const [step, setStep] = useState(null);
  const [problems, setProblems] = useState([]);
  const [error, setError] = useState('');
  const [savedJson, setSavedJson] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef(null);
  const stepRef = useRef(null);
  const chain = useRef(Promise.resolve());
  const savedProfile = useRef('');

  useEffect(() => { formRef.current = form; }, [form]);
  useEffect(() => { stepRef.current = step; }, [step]);

  useEffect(() => {
    let live = true;
    Promise.all([api.intakeSubmission(publicId), api.customerMe()])
      .then(([{ submission }, meR]) => {
        if (!live) return;
        if (submission.status.key !== 'draft') { navigate(`/submissions/${publicId}`, { replace: true }); return; }
        setSub(submission);
        setForm(submission.form);
        setSavedJson(JSON.stringify(submission.form));
        setMe(meR);
        const prof = pickProfile(meR.account);
        setProfile(prof);
        savedProfile.current = JSON.stringify(prof);
        const keys = stepsFor(submission.form).map(s => s.key);
        setStep(keys.includes(submission.step) ? submission.step : keys[0]);
      })
      .catch(err => live && setError(err.status === 404 ? 'We couldn’t find that submission.' : err.message));
    return () => { live = false; };
  }, [publicId, navigate]);

  // Saves run one at a time, in order, always with the latest form.
  const persist = useCallback((stepKey) => {
    const run = async () => {
      const snapshot = formRef.current;
      if (!snapshot) return null;
      setSaving(true);
      try {
        const { submission } = await api.intakeSaveDraft(publicId, stepKey || stepRef.current, snapshot);
        setSub(submission);
        setSavedJson(JSON.stringify(snapshot));
        setError('');
        return submission;
      } catch (err) {
        if (err.status === 409) navigate(`/submissions/${publicId}`, { replace: true });
        setError(`Your latest changes aren’t saved yet: ${err.message}`);
        throw err;
      } finally {
        setSaving(false);
      }
    };
    const p = chain.current.then(run, run);
    chain.current = p.catch(() => {});
    return p;
  }, [publicId, navigate]);

  // Autosave a moment after the customer stops typing.
  useEffect(() => {
    if (!form || JSON.stringify(form) === savedJson) return undefined;
    const t = setTimeout(() => { persist().catch(() => {}); }, 1200);
    return () => clearTimeout(t);
  }, [form, savedJson, persist]);

  const refresh = useCallback(async () => {
    const { submission } = await api.intakeSubmission(publicId);
    setSub(submission);
    return submission;
  }, [publicId]);

  const update = useCallback(fn => setForm(prev => fn(prev)), []);
  const refreshMe = useCallback(() => api.customerMe().then(setMe).then(() => refresh()).catch(err => setError(err.message)), [refresh]);

  if (error && !sub) return <Banner tone="error" title="Something went wrong">{error} <Link to="/submissions" className="font-bold underline">Back to my submissions</Link></Banner>;
  if (!sub || !form || !config || !me || !step) return <p style={muted}>Loading your submission…</p>;

  const steps = stepsFor(form);
  const keys = steps.map(s => s.key);
  const index = Math.max(0, keys.indexOf(step));
  const rightsOk = sub.rights?.action === 'grant' && sub.rights.role === form.role;
  const ctx = { config, profile, rightsOk };
  const dirty = JSON.stringify(form) !== savedJson;
  const inquiry = form.service.package_key === 'hall_of_fame';
  // After a blocked "Next", the list tracks the form: fixed items drop off.
  const missing = problems.length ? stepProblems(step, form, ctx) : [];

  async function saveProfile() {
    const json = JSON.stringify(profile);
    if (json === savedProfile.current) return;
    const { account } = await api.customerUpdateMe(profile);
    savedProfile.current = json;
    setMe(m => ({ ...m, account: { ...m.account, ...account } }));
  }

  async function go(target) {
    const from = keys.indexOf(step);
    const to = keys.indexOf(target);
    if (to < 0 || target === step) return;
    // Moving forward checks every step on the way, so required fields are
    // known before the upload begins (§5).
    for (const k of keys.slice(from, Math.max(from, to))) {
      const p = to > from ? stepProblems(k, form, ctx) : [];
      if (p.length) { setProblems(p); if (k !== step) setStep(k); window.scrollTo(0, 0); return; }
    }
    setProblems([]);
    try {
      if (step === 'role') await saveProfile();
      if (target === 'athletes' && form.role === 'athlete' && form.athletes.length === 0) {
        // An adult athlete submitting their own footage: start with them.
        const self = { player_id: null, first_name: profile.first_name, last_name: profile.last_name, birth_year: null, age_band: form.game.level, team_label: form.game.team_label, jersey: '', relationship: 'self' };
        formRef.current = { ...form, athletes: [self] };
        setForm(formRef.current);
      }
      await persist(target);
      setStep(target);
      window.scrollTo(0, 0);
    } catch (err) {
      setError(err.message);
    }
  }

  async function finishLater() {
    try { await saveProfile(); await persist(); navigate('/submissions'); }
    catch (err) { setError(err.message); }
  }

  async function submit() {
    setSubmitting(true); setError('');
    try {
      await persist('review');
      await api.intakeSubmit(publicId);
      navigate(`/submissions/${publicId}?sent=1`, { replace: true });
    } catch (err) {
      setError(err.message);
      refresh().catch(() => {});
    } finally {
      setSubmitting(false);
    }
  }

  async function discard() {
    if (!window.confirm('Discard this draft? Anything you uploaded to it is deleted.')) return;
    try { await api.intakeDiscard(publicId); navigate('/submissions'); }
    catch (err) { setError(err.message); }
  }

  const stepProps = { form, update, config, me, sub, profile, setProfile };
  const canSubmit = sub.readiness.length === 0 && !uploadBusy && !submitting;
  const last = index === keys.length - 1;
  // Uploads keep running while the customer edits other steps.
  const uploadMounted = keys.includes('upload') && rightsOk;

  return (
    <div className="flex flex-col gap-6" data-testid="intake-wizard" data-step={step}>
      <PageTitle eyebrow={`Submission ${sub.public_id}`} title={inquiry ? 'Hall of Fame request' : 'Submit footage'}
        actions={<SaveState saving={saving} dirty={dirty} />}>
        {sub.test && <span className="text-[10px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(251, 191, 36, 0.15)', color: '#fbbf24' }}>Test</span>}
      </PageTitle>

      <nav aria-label="Steps">
        <ol className="hidden md:flex gap-1 flex-wrap">
          {steps.map((s, i) => (
            <li key={s.key}>
              <button type="button" onClick={() => go(s.key)} aria-current={s.key === step ? 'step' : undefined}
                className="px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer"
                style={s.key === step ? { backgroundColor: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8' } : { color: i < index ? '#cbd5e1' : '#64748b' }}>
                <span className="mr-1.5">{i + 1}</span>{s.label}
              </button>
            </li>
          ))}
        </ol>
        <div className="md:hidden">
          <p className="text-xs font-bold" style={{ color: '#38bdf8' }}>Step {index + 1} of {steps.length} · {steps[index].label}</p>
          <div className="w-full rounded-full h-1 mt-2" style={{ backgroundColor: 'rgba(30, 41, 59, 0.9)' }}>
            <div className="h-1 rounded-full" style={{ width: `${((index + 1) / steps.length) * 100}%`, backgroundColor: '#38bdf8' }} />
          </div>
        </div>
      </nav>

      {step === 'review' && <EmailVerifyBanner me={me} onChecked={refreshMe} />}
      {missing.length > 0 && (
        <Banner tone="warn" title="A few things to fill in first">
          <ul className="list-disc pl-5" data-testid="step-problems">{missing.map(p => <li key={p}>{p}</li>)}</ul>
        </Banner>
      )}
      {uploadBusy && step !== 'upload' && <Banner tone="info">Upload in progress — keep this page open until it finishes.</Banner>}

      <Card className="p-6">
        {step === 'role' && <RoleStep {...stepProps} />}
        {step === 'service' && <ServiceStep {...stepProps} />}
        {step === 'game' && <GameStep {...stepProps} />}
        {step === 'athletes' && <AthletesStep {...stepProps} />}
        {step === 'footage' && <FootageStep {...stepProps} />}
        {step === 'terms' && (
          <TermsStep publicId={publicId} sub={sub} form={form} config={config}
            onAccepted={s => { setSub(s); setProblems([]); persist('upload').then(() => { setStep('upload'); window.scrollTo(0, 0); }).catch(() => {}); }} />
        )}
        {uploadMounted && (
          <div hidden={step !== 'upload'}>
            <UploadPanel publicId={publicId} config={config} sub={sub} onRefresh={refresh} onBusyChange={setUploadBusy} />
          </div>
        )}
        {step === 'upload' && !uploadMounted && <Banner tone="warn" title="Accept the footage terms first">Uploads open once the terms on “Guide & terms” are accepted.</Banner>}
        {step === 'review' && <ReviewStep {...stepProps} steps={steps} onEdit={go} />}
      </Card>

      <ErrorNote>{error}</ErrorNote>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex gap-2">
          {index > 0 && <GhostButton type="button" onClick={() => go(keys[index - 1])}>Back</GhostButton>}
          <GhostButton type="button" onClick={finishLater}>Save and finish later</GhostButton>
        </div>
        <div className="flex gap-3 items-center">
          <button type="button" onClick={discard} className="text-xs hover:underline cursor-pointer" style={{ color: '#64748b' }}>Discard draft</button>
          {last ? (
            <PrimaryButton type="button" onClick={submit} disabled={!canSubmit} data-testid="submit">
              {submitting ? 'Sending…' : inquiry ? 'Send request' : 'Submit footage'}
            </PrimaryButton>
          ) : step === 'terms' && !rightsOk ? null : (
            <PrimaryButton type="button" onClick={() => go(keys[index + 1])} data-testid="next">Next: {steps[index + 1].label}</PrimaryButton>
          )}
        </div>
      </div>
    </div>
  );
}

// Autosave state: a quiet tick when everything is saved.
function SaveState({ saving, dirty }) {
  const [Icon, label, color] = saving ? [LoaderCircle, 'Saving…', '#94a3b8'] : dirty ? [null, 'Unsaved', '#fbbf24'] : [Check, 'Saved', '#4ade80'];
  return (
    <Tooltip content="Your progress saves as you go — close the tab and pick up where you left off.">
      <span className="inline-flex items-center gap-1 text-xs font-bold" style={{ color }} data-testid="save-state">
        {Icon ? <Icon size={14} strokeWidth={2.6} className={saving ? 'animate-spin' : ''} aria-hidden="true" /> : <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />}
        {label}
      </span>
    </Tooltip>
  );
}
