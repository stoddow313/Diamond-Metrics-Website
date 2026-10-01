// The steps of the guided intake (customer footage submission §3–§5, §7).
// Each step edits the local draft; the wizard saves it as the customer goes.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime } from '../../lib/intake';
import { Field, TextInput, Select, PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import { Card, Banner, CheckRow, TextArea, SectionTitle, IssueLine } from './ui';
import { ContactChoice } from './AuthForms';
import { blankAthlete, groupOf, LEVELS, RELATIONSHIP_FOR_ROLE, stepForReadiness } from './wizard';
import primaryBehindHome from '../../assets/blog/primary-behind-home-plate-setup.svg';
import filmingBehindHome from '../../assets/blog/filming-behind-home-plate.png';
import secondCamera from '../../assets/blog/optional-second-camera-setup.svg';

const GUIDE_IMAGES = {
  'primary-behind-home-plate-setup.svg': { src: primaryBehindHome, alt: 'Camera on a tripod behind home plate, raised and slightly off-centre' },
  'filming-behind-home-plate.png': { src: filmingBehindHome, alt: 'A phone filming the game from behind home plate' },
  'optional-second-camera-setup.svg': { src: secondCamera, alt: 'A second camera fixed on the first-base line' },
};
const GROUP_TITLES = { family: 'For my family', team: 'For a team', event: 'For an event' };
const muted = { color: '#94a3b8' };
const faint = { color: '#64748b' };

function Choice({ selected, onClick, children, testId }) {
  return (
    <button
      type="button" onClick={onClick} aria-pressed={selected} data-testid={testId}
      className="text-left rounded-xl border p-4 cursor-pointer transition-colors w-full"
      style={selected
        ? { borderColor: '#38bdf8', backgroundColor: 'rgba(56, 189, 248, 0.08)' }
        : { borderColor: '#1e3a5f', backgroundColor: 'rgba(15, 23, 42, 0.5)' }}
    >
      {children}
    </button>
  );
}

// ── About you ────────────────────────────────────────────────────────────
export function RoleStep({ form, update, config, me, profile, setProfile }) {
  const groups = ['family', 'team', 'event'].map(g => [g, config.roles.filter(r => r.group === g)]);
  const group = groupOf(config, form.role);
  const setP = (k, v) => setProfile(p => ({ ...p, [k]: v }));
  return (
    <div className="flex flex-col gap-6">
      <div>
        <SectionTitle>Who are you submitting as?</SectionTitle>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {groups.map(([g, roles]) => (
            <div key={g} className="flex flex-col gap-2">
              <p className="text-xs font-bold uppercase tracking-wider" style={faint}>{GROUP_TITLES[g]}</p>
              {roles.map(r => (
                <Choice key={r.key} selected={form.role === r.key} onClick={() => update(f => ({ ...f, role: r.key }))} testId={`role-${r.key}`}>
                  <span className="text-sm font-bold text-white">{r.label}</span>
                </Choice>
              ))}
            </div>
          ))}
        </div>
        {form.role === 'athlete' && <p className="text-xs mt-3" style={muted}>Under 18? A parent or legal guardian needs to submit for you.</p>}
        {group === 'team' && <p className="text-xs mt-3" style={muted}>Submitting for a team doesn’t give you ownership of any athlete’s account — families keep that.</p>}
      </div>
      <div>
        <SectionTitle>Your details</SectionTitle>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="First name (legal)"><TextInput value={profile.first_name} onChange={e => setP('first_name', e.target.value)} autoComplete="given-name" /></Field>
          <Field label="Last name (legal)"><TextInput value={profile.last_name} onChange={e => setP('last_name', e.target.value)} autoComplete="family-name" /></Field>
          <Field label="Email">
            <p className="text-sm py-2" style={{ color: '#cbd5e1' }}>
              {me.account.email} {me.account.email_verified ? <span style={{ color: '#4ade80' }}>· verified</span> : <span style={{ color: '#fbbf24' }}>· not verified yet</span>}
            </p>
          </Field>
          <Field label="Mobile phone (preferred)"><TextInput type="tel" value={profile.phone} onChange={e => setP('phone', e.target.value)} autoComplete="tel" /></Field>
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
        <SectionTitle>Choose your analysis path</SectionTitle>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {config.packages.map(p => (
            <Choice key={p.key} selected={s.package_key === p.key} onClick={() => setS('package_key', p.key)} testId={`package-${p.key}`}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-base font-bold text-white">{p.label}</span>
                {!p.self_serve && <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: '#c4b5fd' }}>Consultation</span>}
              </div>
              <p className="text-sm font-bold mt-1" style={{ color: '#7dd3fc' }}>{p.best_for}</p>
              <dl className="text-xs mt-3 flex flex-col gap-1.5" style={{ color: '#cbd5e1' }}>
                <div><dt className="inline font-bold" style={muted}>Upload: </dt><dd className="inline">{p.upload}</dd></div>
                <div><dt className="inline font-bold" style={muted}>Delivers: </dt><dd className="inline">{p.delivers}</dd></div>
                <div><dt className="inline font-bold" style={muted}>Footage: </dt><dd className="inline">{p.expectation}</dd></div>
              </dl>
              {p.note && <p className="text-xs mt-3" style={{ color: '#fbbf24' }}>{p.note}</p>}
            </Choice>
          ))}
        </div>
        {s.package_key === 'hall_of_fame' && (
          <Banner tone="info" className="mt-4" title="No upload needed">
            Hall of Fame uses an approved hardware and data-capture setup. Tell us about the athlete and the event, and our team will contact you to plan it.
          </Banner>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label={s.package_key === 'custom' ? 'What would you like measured?' : 'Anything specific you’d like us to look at? (optional)'}>
          <TextArea value={s.requested_metrics} onChange={e => setS('requested_metrics', e.target.value)} maxLength={1000}
            placeholder={s.package_key === 'custom' ? 'e.g. pitch velocity for our two starters, and home-to-first times' : ''} />
        </Field>
        <Field label="Receipt or order number (optional)">
          <TextInput value={s.order_reference} onChange={e => setS('order_reference', e.target.value)} maxLength={80} placeholder="From your purchase confirmation, if you have one" />
          <p className="text-xs mt-1.5" style={faint}>No payment is taken here. If you haven’t purchased yet, our team confirms your package and payment with you before analysis starts.</p>
        </Field>
      </div>
    </div>
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
      {inquiry && <p className="text-sm" style={muted}>Tell us what you have in mind — all optional. We’ll go through the details with you.</p>}
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
          This was a regular-season game, not part of an event or tournament
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
        <Field label="Opponent (optional)"><TextInput value={g.opponent_label} onChange={e => setG('opponent_label', e.target.value)} /></Field>
        <Field label="Field or location (optional)"><TextInput value={g.location} onChange={e => setG('location', e.target.value)} /></Field>
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
      <p className="text-sm" style={muted}>
        {group === 'family'
          ? 'Which athlete is this footage for? Add anyone else from your family who played in this game too.'
          : 'Which athletes are in this footage? Listing them helps us match the right players — or attach a roster file in the upload step instead.'}
        {' '}Nothing here is published: athlete profiles stay private until our team verifies who they are.
      </p>
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
          <Field label="Same age group for everyone without a birth year"><TextInput value={everyone} onChange={e => setEveryone(e.target.value)} list="dm-levels" placeholder="e.g. 12U" /></Field>
          <GhostButton type="button" onClick={() => update(f => ({ ...f, athletes: f.athletes.map(a => (a.birth_year ? a : { ...a, age_band: everyone })) }))} disabled={!everyone.trim()}>Apply</GhostButton>
        </div>
      )}
      {form.athletes.map((a, i) => (
        <Card key={i} className="p-4" data-testid={`athlete-${i}`}>
          <div className="flex items-center justify-between gap-3 mb-3">
            <p className="text-sm font-bold text-white">{a.player_id ? `${a.first_name} ${a.last_name}` : form.athletes.length > 1 ? `Athlete ${i + 1}` : 'Athlete'}</p>
            <button type="button" onClick={() => remove(i)} className="text-xs hover:underline cursor-pointer" style={faint}>Remove</button>
          </div>
          {a.player_id ? (
            <p className="text-xs mb-3" style={{ color: '#4ade80' }}>Linked to your account — already verified by our team.</p>
          ) : (
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
            <Field label="Your relationship">
              <Select value={a.relationship} onChange={e => setA(i, 'relationship', e.target.value)}>
                <option value="">Choose…</option>
                {config.relationships.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
              </Select>
            </Field>
            <Field label="Primary team (optional)"><TextInput value={a.team_label} onChange={e => setA(i, 'team_label', e.target.value)} /></Field>
            <Field label="Jersey number (optional)"><TextInput value={a.jersey} onChange={e => setA(i, 'jersey', e.target.value)} maxLength={6} /></Field>
          </div>
        </Card>
      ))}
      {form.athletes.length === 0 && group !== 'family' && !inquiry && (
        <p className="text-sm" style={faint}>No athletes listed — that’s fine if you’ll attach a roster file.</p>
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
            <p className="text-xs mt-1" style={muted}>One continuous recording, or a few files that cover the whole game.</p>
          </Choice>
          <Choice selected={ft.coverage === 'clips'} onClick={() => setF('coverage', 'clips')} testId="coverage-clips">
            <span className="text-sm font-bold text-white">Clips</span>
            <p className="text-xs mt-1" style={muted}>Selected at-bats or plays. Metrics outside the clips will be unavailable.</p>
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
        <Field label="Resolution, if you know it">
          <Select value={ft.known_resolution} onChange={e => setF('known_resolution', e.target.value)}>
            <option value="">Not sure</option>
            {['720p', '1080p', '1440p', '4K'].map(r => <option key={r} value={r}>{r}</option>)}
          </Select>
        </Field>
        <Field label="Frame rate, if you know it">
          <Select value={ft.known_fps} onChange={e => setF('known_fps', e.target.value)}>
            <option value="">Not sure</option>
            {['24', '30', '60', '120', '240'].map(r => <option key={r} value={r}>{r} fps</option>)}
          </Select>
        </Field>
      </div>
      {form.service.package_key === 'pro' && (
        <CheckRow checked={ft.side_angle} onChange={v => setF('side_angle', v)}>
          I also filmed a side angle (first- or third-base line) — recommended for Pro
        </CheckRow>
      )}
      <Field label="Anything we should know? (optional)">
        <TextArea value={ft.key_plays} onChange={e => setF('key_plays', e.target.value)} maxLength={2000} rows={4}
          placeholder="e.g. Rae bats 4th and pitches the 3rd inning; the camera stopped for a few minutes in the 5th." />
      </Field>
      <p className="text-xs" style={faint}>We check resolution, frame rate and length ourselves after you upload — you’ll choose each file’s camera angle there.</p>
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
        <SectionTitle aside={<span className="text-xs" style={faint}>Version {config.guide_version}</span>}>{guide.title}</SectionTitle>
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
        {guide.insufficient && <p className="text-xs mt-3" style={muted}>{guide.insufficient}</p>}
        <Link to="/blog/how-to-record-baseball-game-video-analysis" target="_blank" rel="noopener" className="inline-block text-xs font-bold mt-3 hover:underline" style={{ color: '#38bdf8' }}>
          Read the full filming guide ↗
        </Link>
      </Card>

      {accepted ? (
        <Banner tone="success" title="Terms accepted">
          You accepted the footage terms (version {sub.rights.version}) on {fmtDateTime(sub.rights.accepted_at)}. Continue to upload your footage.
        </Banner>
      ) : !terms ? (
        <Banner tone="warn" title="Choose your role first">Go back to “About you” — the terms depend on who is submitting.</Banner>
      ) : (
        <Card className="p-5" data-testid="footage-terms">
          <SectionTitle aside={<span className="text-xs" style={faint}>Version {terms.version}</span>}>Footage terms</SectionTitle>
          {roleChanged && <Banner tone="warn" className="mb-3" title="Your role changed">You accepted these terms as a different role. Please review and accept them again.</Banner>}
          {terms.pending_legal && (
            <p className="text-xs mb-3" style={{ color: '#fbbf24' }}>This wording is a draft awaiting legal approval. Your acceptance is recorded with its version.</p>
          )}
          <CheckRow checked={ack.guide} onChange={v => setAck(a => ({ ...a, guide: v }))} hint="Required" testId="ack-guide">{terms.guide}</CheckRow>
          <CheckRow checked={ack.attest} onChange={v => setAck(a => ({ ...a, attest: v }))} hint="Required" testId="ack-attest">{terms.attestation}</CheckRow>
          {terms.uses.map(u => (
            <CheckRow key={u.key} checked={ack.uses[u.key]} onChange={v => setAck(a => ({ ...a, uses: { ...a.uses, [u.key]: v } }))} hint={u.required ? 'Required' : 'Optional'} testId={`ack-use-${u.key}`}>
              {u.text}
            </CheckRow>
          ))}
          <CheckRow checked={ack.retention} onChange={v => setAck(a => ({ ...a, retention: v }))} hint="Required" testId="ack-retention">{terms.retention}</CheckRow>
          <CheckRow checked={ack.contact} onChange={v => setAck(a => ({ ...a, contact: v }))} hint="Optional">{terms.contact}</CheckRow>
          <div className="mt-3">
            <Field label="Anything we should not do with this footage? (optional)">
              <TextArea value={ack.restrictions} onChange={e => setAck(a => ({ ...a, restrictions: e.target.value }))} maxLength={1000} rows={2} />
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
  return (
    <div className="flex flex-col gap-5">
      {sub.readiness.length > 0 && (
        <Banner tone="warn" title="Before you can submit">
          <ul className="mt-1 flex flex-col gap-1" data-testid="readiness">
            {sub.readiness.map(m => {
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
          {pkg?.note && <p className="text-xs mt-1" style={{ color: '#fbbf24' }}>{pkg.note}</p>}
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
                  {f.issues.filter(i => i.severity !== 'tip').map(i => <IssueLine key={i.text} issue={i} />)}
                </li>
              ))}</ul>
            )}
          </Summary>
        )}
      </Card>
      <p className="text-xs" style={faint}>
        After you submit, our team checks the footage and the athlete and game details, and tells you here if anything is needed. Every result is reviewed by a person; if a measurement can’t be verified from your footage, you’ll see why — never a zero.
      </p>
    </div>
  );
}
