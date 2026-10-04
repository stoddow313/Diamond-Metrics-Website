// The steps of the guided intake (customer footage submission §3–§5, §7).
// Each step edits the local draft; the wizard saves it as the customer goes.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime } from '../../lib/intake';
import { BadgeCheck } from 'lucide-react';
import { Field, TextInput, Select, PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import { InfoTip, Tooltip } from '../../components/Tooltip';
import { Card, Banner, CheckRow, TextArea, SectionTitle, Issues } from './ui';
import { ContactChoice, LEGAL_NAME_HINT } from './AuthForms';
import { blankAthlete, groupOf, LEVELS, RELATIONSHIP_FOR_ROLE, stepForReadiness } from './wizard';
import primaryBehindHome from '../../assets/blog/primary-behind-home-plate-setup.svg';
import filmingBehindHome from '../../assets/blog/filming-behind-home-plate.png';
import secondCamera from '../../assets/blog/optional-second-camera-setup.svg';

const GUIDE_IMAGES = {
  'primary-behind-home-plate-setup.svg': { src: primaryBehindHome, alt: 'Camera on a tripod behind home plate, raised and slightly off-centre' },
  'filming-behind-home-plate.png': { src: filmingBehindHome, alt: 'A phone filming the game from behind home plate' },
  'optional-second-camera-setup.svg': { src: secondCamera, alt: 'A second camera fixed on the first-base line' },
};
const muted = { color: '#94a3b8' };
const faint = { color: '#64748b' };

// A selectable card. `corner` (an ⓘ) sits over the top-right corner as a
// sibling of the button, never inside it.
function Choice({ selected, onClick, children, testId, corner }) {
  const button = (
    <button
      type="button" onClick={onClick} aria-pressed={selected} data-testid={testId}
      className={`text-left rounded-xl border p-4 cursor-pointer transition-colors w-full h-full flex flex-col justify-start items-stretch ${corner ? 'pr-10' : ''}`}
      style={selected
        ? { borderColor: '#38bdf8', backgroundColor: 'rgba(56, 189, 248, 0.08)' }
        : { borderColor: '#1e3a5f', backgroundColor: 'rgba(15, 23, 42, 0.5)' }}
    >
      {children}
    </button>
  );
  if (!corner) return button;
  return <div className="relative h-full">{button}<span className="absolute top-4 right-4 flex">{corner}</span></div>;
}

function Verified({ ok, tip }) {
  return (
    <Tooltip content={tip}>
      <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full"
        style={ok ? { backgroundColor: 'rgba(74, 222, 128, 0.12)', color: '#4ade80' } : { backgroundColor: 'rgba(251, 191, 36, 0.12)', color: '#fbbf24' }}>
        {ok && <BadgeCheck size={12} strokeWidth={2.4} aria-hidden="true" />}{ok ? 'Verified' : 'Not verified'}
      </span>
    </Tooltip>
  );
}

// ── About you ────────────────────────────────────────────────────────────
export function RoleStep({ form, update, config, me, profile, setProfile }) {
  const group = groupOf(config, form.role);
  const setP = (k, v) => setProfile(p => ({ ...p, [k]: v }));
  return (
    <div className="flex flex-col gap-6">
      <div>
        <SectionTitle hint="Athletes under 18 need a parent or legal guardian to submit. Coaches, team reps and organizers submit for a team or event — athlete accounts stay with families.">
          Who are you submitting as?
        </SectionTitle>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {config.roles.map(r => (
            <Choice key={r.key} selected={form.role === r.key} onClick={() => update(f => ({ ...f, role: r.key }))} testId={`role-${r.key}`}>
              <span className="text-sm font-bold text-white">{r.label}</span>
            </Choice>
          ))}
        </div>
      </div>
      <div>
        <SectionTitle>Your details</SectionTitle>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="First name" hint={LEGAL_NAME_HINT}><TextInput value={profile.first_name} onChange={e => setP('first_name', e.target.value)} autoComplete="given-name" /></Field>
          <Field label="Last name"><TextInput value={profile.last_name} onChange={e => setP('last_name', e.target.value)} autoComplete="family-name" /></Field>
          <Field label="Email">
            <p className="text-sm py-2 flex items-center gap-2 flex-wrap" style={{ color: '#cbd5e1' }}>
              {me.account.email}
              <Verified ok={me.account.email_verified} tip={me.account.email_verified ? 'Your email is confirmed.' : 'Confirm it from the email we sent — needed before you submit.'} />
            </p>
          </Field>
          <Field label="Mobile phone"><TextInput type="tel" value={profile.phone} onChange={e => setP('phone', e.target.value)} autoComplete="tel" placeholder="Optional" /></Field>
          {group && group !== 'family' && (
            <Field label={group === 'event' ? 'Event or organization' : 'Team or organization'}>
              <TextInput value={profile.organization} onChange={e => setP('organization', e.target.value)} autoComplete="organization" />
            </Field>
          )}
          <Field label="Best way to reach you"><ContactChoice value={profile.preferred_contact} onChange={v => setP('preferred_contact', v)} /></Field>
        </div>
      </div>
    </div>
  );
}

// ── Service (§13 copy, from the API so it matches what is stored) ────────
export function ServiceStep({ form, update, config }) {
  const s = form.service;
  const setS = (k, v) => update(f => ({ ...f, service: { ...f.service, [k]: v } }));
  return (
    <div className="flex flex-col gap-6">
      <div>
        <SectionTitle>Choose a package</SectionTitle>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {config.packages.map(p => (
            <Choice key={p.key} selected={s.package_key === p.key} onClick={() => setS('package_key', p.key)} testId={`package-${p.key}`}
              corner={<InfoTip label={`What ${p.label} includes`} maxWidth={320}><PackageDetails p={p} /></InfoTip>}>
              <span className="text-base font-bold text-white">{p.label}</span>
              <p className="text-sm mt-0.5" style={{ color: '#7dd3fc' }}>{p.best_for}</p>
              {(p.note || !p.self_serve) && (
                <p className="mt-2.5">
                  <span className="text-[11px] font-bold px-2 py-0.5 rounded-full" style={p.note ? { backgroundColor: 'rgba(251, 191, 36, 0.12)', color: '#fbbf24' } : { backgroundColor: 'rgba(196, 181, 253, 0.12)', color: '#c4b5fd' }}>
                    {p.note ? 'Analyzed as Rookie for now' : 'Consultation'}
                  </span>
                </p>
              )}
            </Choice>
          ))}
        </div>
        {s.package_key === 'hall_of_fame' && (
          <Banner tone="info" className="mt-4" title="No upload needed">Our team will contact you to plan the capture.</Banner>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label={s.package_key === 'custom' ? 'What would you like measured?' : 'Notes for our analysts'}>
          <TextArea value={s.requested_metrics} onChange={e => setS('requested_metrics', e.target.value)} maxLength={1000} rows={2}
            placeholder={s.package_key === 'custom' ? 'e.g. pitch velocity for our two starters, and home-to-first times' : 'Optional'} />
        </Field>
        <Field label="Order number" hint="From your purchase confirmation. No payment is taken here — if you haven’t purchased yet, our team confirms your package and payment with you before analysis starts.">
          <TextInput value={s.order_reference} onChange={e => setS('order_reference', e.target.value)} maxLength={80} placeholder="Optional" />
        </Field>
      </div>
    </div>
  );
}

function PackageDetails({ p }) {
  return (
    <span className="flex flex-col gap-1.5">
      <span><b className="text-white">Upload</b> · {p.upload}</span>
      <span><b className="text-white">Delivers</b> · {p.delivers}</span>
      <span><b className="text-white">Footage</b> · {p.expectation}</span>
      {p.note && <span style={{ color: '#fbbf24' }}>{p.note}</span>}
    </span>
  );
}

// ── Game or event ────────────────────────────────────────────────────────
export function GameStep({ form, update, me }) {
  const g = form.game;
  const inquiry = form.service.package_key === 'hall_of_fame';
  const setG = (k, v) => update(f => ({ ...f, game: { ...f.game, [k]: v } }));
  const today = new Date();
  const max = inquiry ? undefined : `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label={inquiry ? 'Date (if known)' : 'Game date'}>
          <TextInput type="date" value={g.date} max={max} onChange={e => setG('date', e.target.value)} data-testid="game-date" />
        </Field>
        <Field label="Age group or level">
          <TextInput value={g.level} onChange={e => setG('level', e.target.value)} list="dm-levels" placeholder="e.g. 12U" />
          <datalist id="dm-levels">{LEVELS.map(l => <option key={l} value={l} />)}</datalist>
        </Field>
      </div>
      <div>
        <Field label="Event or tournament">
          <TextInput value={g.event_label} onChange={e => setG('event_label', e.target.value)} disabled={g.no_event} placeholder={g.no_event ? 'Regular-season game' : 'e.g. Fall Classic'} />
        </Field>
        <CheckRow checked={g.no_event} onChange={v => update(f => ({ ...f, game: { ...f.game, no_event: v, event_label: v ? '' : f.game.event_label } }))}>
          Regular-season game (no event)
        </CheckRow>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Your team">
          <TextInput value={g.team_label} onChange={e => update(f => ({ ...f, game: { ...f.game, team_label: e.target.value, team_id: null } }))} placeholder="e.g. Canyon Athletics 12U" />
          {me.teams.length > 0 && (
            <div className="flex gap-2 flex-wrap mt-2">
              {me.teams.map(t => (
                <button key={t.team_id} type="button" onClick={() => update(f => ({ ...f, game: { ...f.game, team_id: t.team_id, team_label: t.name, level: f.game.level || t.age_group || '' } }))}
                  className="text-xs font-bold px-2.5 py-1 rounded-full border cursor-pointer"
                  style={g.team_id === t.team_id ? { borderColor: '#38bdf8', color: '#38bdf8' } : { borderColor: '#334155', color: '#94a3b8' }}>
                  {t.name}
                </button>
              ))}
            </div>
          )}
        </Field>
        <Field label="Opponent"><TextInput value={g.opponent_label} onChange={e => setG('opponent_label', e.target.value)} placeholder="Optional" /></Field>
        <Field label="Location"><TextInput value={g.location} onChange={e => setG('location', e.target.value)} placeholder="Optional" /></Field>
      </div>
    </div>
  );
}

// ── Athletes ─────────────────────────────────────────────────────────────
export function AthletesStep({ form, update, config, me }) {
  const group = groupOf(config, form.role);
  const inquiry = form.service.package_key === 'hall_of_fame';
  const [everyone, setEveryone] = useState('');
  const setA = (i, k, v) => update(f => ({ ...f, athletes: f.athletes.map((a, j) => (j === i ? { ...a, [k]: v } : a)) }));
  const remove = i => update(f => ({ ...f, athletes: f.athletes.filter((_, j) => j !== i) }));
  const add = () => update(f => ({ ...f, athletes: [...f.athletes, blankAthlete(f)] }));
  const mine = me.athletes.filter(a => !form.athletes.some(x => x.player_id === a.player_id));
  const addMine = a => update(f => ({
    ...f,
    athletes: [...f.athletes, {
      ...blankAthlete(f), player_id: a.player_id, first_name: a.first_name, last_name: a.last_name, birth_year: a.birth_year,
      relationship: a.relationship === 'invite_claim' ? RELATIONSHIP_FOR_ROLE[f.role] || '' : a.relationship,
    }],
  }));
  const thisYear = new Date().getFullYear();

  return (
    <div className="flex flex-col gap-5">
      <SectionTitle hint={`${group === 'family'
        ? 'Add each athlete from your family who played in this game.'
        : 'Listing athletes helps us match the right players — or attach a roster file on the Upload step.'} Nothing is published: profiles stay private until our team verifies who they are.`}>
        {group === 'family' ? 'Who is this footage for?' : 'Athletes in this game'}
      </SectionTitle>
      {mine.length > 0 && (
        <div>
          <p className="text-xs font-bold uppercase tracking-wider mb-2" style={faint}>Your athletes</p>
          <div className="flex gap-2 flex-wrap">
            {mine.map(a => (
              <button key={a.player_id} type="button" onClick={() => addMine(a)} className="text-sm font-bold px-3 py-1.5 rounded-full border cursor-pointer hover:bg-slate-800" style={{ borderColor: '#38bdf8', color: '#38bdf8' }}>
                + {a.first_name} {a.last_name}
              </button>
            ))}
          </div>
        </div>
      )}
      {group !== 'family' && form.athletes.length > 1 && (
        <div className="flex items-end gap-3 flex-wrap">
          <Field label="Age group for everyone" hint="Applies to every athlete without a birth year."><TextInput value={everyone} onChange={e => setEveryone(e.target.value)} list="dm-levels" placeholder="e.g. 12U" /></Field>
          <GhostButton type="button" onClick={() => update(f => ({ ...f, athletes: f.athletes.map(a => (a.birth_year ? a : { ...a, age_band: everyone })) }))} disabled={!everyone.trim()}>Apply</GhostButton>
        </div>
      )}
      {form.athletes.map((a, i) => (
        <Card key={i} className="p-4" data-testid={`athlete-${i}`}>
          <div className="flex items-center justify-between gap-3 mb-3">
            <p className="text-sm font-bold text-white flex items-center gap-2">
              {a.player_id ? `${a.first_name} ${a.last_name}` : form.athletes.length > 1 ? `Athlete ${i + 1}` : 'Athlete'}
              {a.player_id && <Verified ok tip="Linked to your account — already verified by our team." />}
            </p>
            <button type="button" onClick={() => remove(i)} className="text-xs hover:underline cursor-pointer" style={faint}>Remove</button>
          </div>
          {a.player_id ? null : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
              <Field label="First name"><TextInput value={a.first_name} onChange={e => setA(i, 'first_name', e.target.value)} /></Field>
              <Field label="Last name"><TextInput value={a.last_name} onChange={e => setA(i, 'last_name', e.target.value)} /></Field>
              <Field label="Birth year">
                <TextInput type="number" inputMode="numeric" min={1960} max={thisYear} value={a.birth_year ?? ''}
                  onChange={e => setA(i, 'birth_year', e.target.value ? Number(e.target.value) : null)} placeholder="e.g. 2014" />
              </Field>
              <Field label="…or age group"><TextInput value={a.age_band} onChange={e => setA(i, 'age_band', e.target.value)} list="dm-levels" placeholder="e.g. 12U" /></Field>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Relationship">
              <Select value={a.relationship} onChange={e => setA(i, 'relationship', e.target.value)}>
                <option value="">Choose…</option>
                {config.relationships.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
              </Select>
            </Field>
            <Field label="Team"><TextInput value={a.team_label} onChange={e => setA(i, 'team_label', e.target.value)} placeholder="Optional" /></Field>
            <Field label="Jersey #"><TextInput value={a.jersey} onChange={e => setA(i, 'jersey', e.target.value)} maxLength={6} placeholder="Optional" /></Field>
          </div>
        </Card>
      ))}
      {form.athletes.length === 0 && group !== 'family' && !inquiry && (
        <p className="text-sm" style={faint}>No athletes yet — a roster file works too.</p>
      )}
      <datalist id="dm-levels">{LEVELS.map(l => <option key={l} value={l} />)}</datalist>
      <div><GhostButton type="button" onClick={add} data-testid="add-athlete">{form.athletes.length ? 'Add another athlete' : 'Add an athlete'}</GhostButton></div>
    </div>
  );
}

// ── Footage context ──────────────────────────────────────────────────────
export function FootageStep({ form, update }) {
  const ft = form.footage;
  const setF = (k, v) => update(f => ({ ...f, footage: { ...f.footage, [k]: v } }));
  return (
    <div className="flex flex-col gap-6">
      <div>
        <SectionTitle>What did you record?</SectionTitle>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Choice selected={ft.coverage === 'full'} onClick={() => setF('coverage', 'full')} testId="coverage-full">
            <span className="text-sm font-bold text-white">The full game</span>
            <p className="text-xs mt-1" style={muted}>Every inning, in one or more files</p>
          </Choice>
          <Choice selected={ft.coverage === 'clips'} onClick={() => setF('coverage', 'clips')} testId="coverage-clips"
            corner={<InfoTip label="About clips">Metrics outside the clips will be unavailable.</InfoTip>}>
            <span className="text-sm font-bold text-white">Clips</span>
            <p className="text-xs mt-1" style={muted}>Selected at-bats or plays</p>
          </Choice>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Field label="Orientation">
          <Select value={ft.orientation} onChange={e => setF('orientation', e.target.value)}>
            <option value="">Not sure</option>
            <option value="landscape">Horizontal (landscape)</option>
            <option value="portrait">Vertical (portrait)</option>
          </Select>
        </Field>
        <Field label="Resolution" hint="Not sure? Leave it — we check every file after upload.">
          <Select value={ft.known_resolution} onChange={e => setF('known_resolution', e.target.value)}>
            <option value="">Not sure</option>
            {['720p', '1080p', '1440p', '4K'].map(r => <option key={r} value={r}>{r}</option>)}
          </Select>
        </Field>
        <Field label="Frame rate">
          <Select value={ft.known_fps} onChange={e => setF('known_fps', e.target.value)}>
            <option value="">Not sure</option>
            {['24', '30', '60', '120', '240'].map(r => <option key={r} value={r}>{r} fps</option>)}
          </Select>
        </Field>
      </div>
      {form.service.package_key === 'pro' && (
        <CheckRow checked={ft.side_angle} onChange={v => setF('side_angle', v)}>
          I also filmed a side angle (first- or third-base line)
        </CheckRow>
      )}
      <Field label="Notes">
        <TextArea value={ft.key_plays} onChange={e => setF('key_plays', e.target.value)} maxLength={2000} rows={3}
          placeholder="Optional — e.g. Rae bats 4th; the camera stopped for a few minutes in the 5th." />
      </Field>
    </div>
  );
}

// ── Filming guide and footage terms (§4 step 4, §7) ──────────────────────
export function TermsStep({ publicId, sub, form, config, onAccepted }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState({ guide: false, attest: false, retention: false, contact: true, uses: {}, restrictions: '' });
  const accepted = sub.rights?.action === 'grant' && sub.rights.role === form.role;
  const roleChanged = sub.rights?.action === 'grant' && sub.rights.role !== form.role;

  useEffect(() => {
    let live = true;
    api.intakeTerms(publicId).then(r => { if (live) setData(r); }).catch(err => live && setError(err.message));
    return () => { live = false; };
  }, [publicId, form.role, form.service.package_key]);

  if (!data) return <><ErrorNote>{error}</ErrorNote>{!error && <p style={muted}>Loading the guide and terms…</p>}</>;
  const { terms, guide } = data;
  const requiredOk = terms && ack.guide && ack.attest && ack.retention && terms.uses.every(u => !u.required || ack.uses[u.key]);

  async function accept() {
    setError(''); setBusy(true);
    try {
      const { submission } = await api.intakeAcceptRights(publicId, {
        attest: ack.attest, guide_ack: ack.guide, retention_ack: ack.retention, contact_permission: ack.contact,
        uses: Object.fromEntries(terms.uses.map(u => [u.key, !!ack.uses[u.key]])), restrictions: ack.restrictions,
      });
      onAccepted(submission);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="p-5" data-testid="filming-guide">
        <SectionTitle hint={`${guide.insufficient ? `${guide.insufficient} ` : ''}Guide version ${config.guide_version}.`}>{guide.title}</SectionTitle>
        <p className="text-sm font-bold text-white mb-3">{guide.summary}</p>
        {guide.images.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
            {guide.images.map(name => GUIDE_IMAGES[name] && (
              <img key={name} src={GUIDE_IMAGES[name].src} alt={GUIDE_IMAGES[name].alt} className="w-full rounded-lg border" style={{ borderColor: '#1e3a5f', backgroundColor: '#0b1730' }} />
            ))}
          </div>
        )}
        <ul className="flex flex-col gap-2 text-sm list-disc pl-5" style={{ color: '#cbd5e1' }}>
          {guide.points.map(p => <li key={p}>{p}</li>)}
        </ul>
        <Link to="/blog/how-to-record-baseball-game-video-analysis" target="_blank" rel="noopener" className="inline-block text-xs font-bold mt-3 hover:underline" style={{ color: '#38bdf8' }}>
          Read the full filming guide ↗
        </Link>
      </Card>

      {accepted ? (
        <Banner tone="success" title="Footage terms accepted">{fmtDateTime(sub.rights.accepted_at)} · version {sub.rights.version}</Banner>
      ) : !terms ? (
        <Banner tone="warn" title="Choose your role first">The terms depend on who is submitting — see “About you”.</Banner>
      ) : (
        <Card className="p-5" data-testid="footage-terms">
          <SectionTitle aside={terms.pending_legal ? (
            <Tooltip content={`This wording is a draft awaiting legal approval. Your acceptance is recorded with its version (${terms.version}).`}>
              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full" style={{ backgroundColor: 'rgba(251, 191, 36, 0.12)', color: '#fbbf24' }} data-testid="terms-draft">Draft wording</span>
            </Tooltip>
          ) : <span className="text-xs" style={faint}>Version {terms.version}</span>}>Footage terms</SectionTitle>
          {roleChanged && <Banner tone="warn" className="mb-3" title="Your role changed">Please accept the terms again.</Banner>}
          <CheckRow checked={ack.guide} onChange={v => setAck(a => ({ ...a, guide: v }))} testId="ack-guide">{terms.guide}</CheckRow>
          <CheckRow checked={ack.attest} onChange={v => setAck(a => ({ ...a, attest: v }))} testId="ack-attest">{terms.attestation}</CheckRow>
          {terms.uses.map(u => (
            <CheckRow key={u.key} checked={ack.uses[u.key]} onChange={v => setAck(a => ({ ...a, uses: { ...a.uses, [u.key]: v } }))} optional={!u.required} testId={`ack-use-${u.key}`}>
              {u.text}
            </CheckRow>
          ))}
          <CheckRow checked={ack.retention} onChange={v => setAck(a => ({ ...a, retention: v }))} testId="ack-retention">{terms.retention}</CheckRow>
          <CheckRow checked={ack.contact} onChange={v => setAck(a => ({ ...a, contact: v }))} optional>{terms.contact}</CheckRow>
          <div className="mt-3">
            <Field label="Anything we shouldn’t do with this footage?">
              <TextArea value={ack.restrictions} onChange={e => setAck(a => ({ ...a, restrictions: e.target.value }))} maxLength={1000} rows={2} placeholder="Optional" />
            </Field>
          </div>
          <ErrorNote>{error}</ErrorNote>
          <div className="mt-4">
            <PrimaryButton type="button" onClick={accept} disabled={!requiredOk || busy} data-testid="accept-terms">{busy ? 'Saving…' : 'Accept and continue'}</PrimaryButton>
          </div>
        </Card>
      )}
    </div>
  );
}

// ── Review and submit ────────────────────────────────────────────────────
function Summary({ title, step, onEdit, children }) {
  return (
    <div className="py-3 border-t first:border-t-0" style={{ borderColor: '#1e3a5f' }}>
      <div className="flex items-center justify-between gap-3 mb-1">
        <p className="text-xs font-bold uppercase tracking-wider" style={faint}>{title}</p>
        {step && <button type="button" onClick={() => onEdit(step)} className="text-xs font-bold hover:underline cursor-pointer" style={{ color: '#38bdf8' }}>Edit</button>}
      </div>
      <div className="text-sm" style={{ color: '#cbd5e1' }}>{children}</div>
    </div>
  );
}

export function ReviewStep({ form, sub, config, me, profile, steps, onEdit }) {
  const inquiry = form.service.package_key === 'hall_of_fame';
  const role = config.roles.find(r => r.key === form.role);
  const pkg = config.packages.find(p => p.key === form.service.package_key);
  const rel = Object.fromEntries(config.relationships.map(r => [r.key, r.label]));
  const views = Object.fromEntries(config.camera_views.map(v => [v.key, v.label]));
  const has = key => steps.some(s => s.key === key);
  const g = form.game;
  // The verify-your-email banner above already covers that one.
  const readiness = sub.readiness.filter(m => m.code !== 'email_unverified');
  return (
    <div className="flex flex-col gap-5">
      {readiness.length > 0 && (
        <Banner tone="warn" title="Before you can submit">
          <ul className="mt-1 flex flex-col gap-1" data-testid="readiness">
            {readiness.map(m => {
              const step = stepForReadiness(m.code);
              return (
                <li key={m.code}>
                  {m.text}
                  {step && has(step) && <button type="button" onClick={() => onEdit(step)} className="ml-2 text-xs font-bold hover:underline cursor-pointer" style={{ color: '#38bdf8' }}>Fix</button>}
                </li>
              );
            })}
          </ul>
        </Banner>
      )}
      <Card className="px-5 py-2">
        <Summary title="About you" step="role" onEdit={onEdit}>
          {profile.first_name} {profile.last_name} · {role?.label || 'role not chosen'}<br />
          <span style={muted}>{me.account.email}{profile.phone ? ` · ${profile.phone}` : ''}{profile.organization && groupOf(config, form.role) !== 'family' ? ` · ${profile.organization}` : ''}</span>
        </Summary>
        <Summary title="Service" step="service" onEdit={onEdit}>
          {pkg ? pkg.label : 'Not chosen'}{form.service.order_reference ? <span style={muted}> · order {form.service.order_reference}</span> : ''}
          {form.service.requested_metrics && <p className="mt-1" style={muted}>“{form.service.requested_metrics}”</p>}
        </Summary>
        <Summary title={inquiry ? 'Event' : 'Game'} step="game" onEdit={onEdit}>
          {g.date ? fmtDate(g.date) : <span style={faint}>No date</span>}
          {g.team_label ? ` · ${g.team_label}` : ''}{g.opponent_label ? ` vs ${g.opponent_label}` : ''}
          <br /><span style={muted}>{g.no_event ? 'Regular-season game' : g.event_label || 'No event given'}{g.level ? ` · ${g.level}` : ''}{g.location ? ` · ${g.location}` : ''}</span>
        </Summary>
        <Summary title="Athletes" step="athletes" onEdit={onEdit}>
          {form.athletes.length === 0 ? <span style={faint}>None listed{inquiry ? '' : ' — a roster file can stand in'}</span> : (
            <ul>{form.athletes.map((a, i) => (
              <li key={i}>{a.first_name} {a.last_name}<span style={muted}>{a.birth_year ? ` · born ${a.birth_year}` : a.age_band ? ` · ${a.age_band}` : ''}{a.relationship ? ` · ${rel[a.relationship]}` : ''}{a.jersey ? ` · #${a.jersey}` : ''}</span></li>
            ))}</ul>
          )}
        </Summary>
        {has('footage') && (
          <Summary title="Footage" step="footage" onEdit={onEdit}>
            {form.footage.coverage === 'full' ? 'Full game' : form.footage.coverage === 'clips' ? 'Clips' : <span style={faint}>Not said</span>}
            <span style={muted}>{[form.footage.orientation, form.footage.known_resolution, form.footage.known_fps && `${form.footage.known_fps} fps`].filter(Boolean).map(x => ` · ${x}`).join('')}</span>
            {form.footage.key_plays && <p className="mt-1" style={muted}>“{form.footage.key_plays}”</p>}
          </Summary>
        )}
        {has('terms') && (
          <Summary title="Footage terms" step="terms" onEdit={onEdit}>
            {sub.rights?.action === 'grant' ? `Accepted ${fmtDateTime(sub.rights.accepted_at)} (version ${sub.rights.version})` : <span style={{ color: '#fbbf24' }}>Not accepted yet</span>}
          </Summary>
        )}
        {has('upload') && (
          <Summary title="Files" step="upload" onEdit={onEdit}>
            {sub.files.length === 0 ? <span style={{ color: '#fbbf24' }}>No files yet</span> : (
              <ul>{sub.files.map(f => (
                <li key={f.id}>{f.kind === 'video' ? (views[f.camera_view] || 'Video') : config.file_kinds.find(k => k.key === f.kind)?.label}
                  <span style={muted}> · {f.original_name} · {f.status_label}</span>
                  <Issues issues={f.issues.filter(i => i.severity !== 'tip')} />
                </li>
              ))}</ul>
            )}
          </Summary>
        )}
      </Card>
    </div>
  );
}
