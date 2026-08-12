import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { Field, TextInput, Select, PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import { cardStyle } from '../../components/admin/theme';
import StatImport from '../../components/admin/StatImport';

const BIO_DEFAULTS = {
  first_name: '', last_name: '', school: '', city: '', state: '',
  grad_year: '', date_of_birth: '', primary_position: '', secondary_position: '',
  height: '', weight_lbs: '', bats: '', throws: '',
  committed_to: '', college_projection: '', photo_url: '', is_public: 1,
};

const SKILL_LABELS = {
  power: 'Power', contact: 'Contact', speed: 'Speed', arm: 'Arm',
  defense: 'Defense', athleticism: 'Athleticism',
  pitch_velocity: 'Pitch Velocity', command: 'Command', catching: 'Catching',
};

const POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'OF', 'IF', 'UTIL', 'RHP', 'LHP'];

// Secondary positions are stored as a comma-separated string (e.g. "2B, OF")
// so no schema change is needed; players often cover several spots.
function SecondaryPositionsPicker({ value, primary, onToggle }) {
  const selected = (value || '').split(',').map(s => s.trim()).filter(Boolean);

  return (
    <Field label={`Secondary positions${selected.length ? ` (${selected.join(', ')})` : ''}`}>
      <div className="flex flex-wrap gap-1.5 pt-0.5">
        {POSITIONS.map(p => {
          const isPrimary = p === primary;
          const isOn = selected.includes(p);
          return (
            <button
              key={p}
              type="button"
              disabled={isPrimary}
              onClick={() => onToggle(p)}
              title={isPrimary ? 'Already the primary position' : undefined}
              className="px-2.5 py-1.5 rounded-lg text-xs font-bold border cursor-pointer transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              style={isOn
                ? { backgroundColor: '#38bdf8', borderColor: '#38bdf8', color: '#0f172a' }
                : { backgroundColor: 'rgba(30, 41, 59, 0.95)', borderColor: '#334155', color: '#cfe8ff' }}
            >
              {p}
            </button>
          );
        })}
      </div>
    </Field>
  );
}

function SectionCard({ title, subtitle, children, actions }) {
  return (
    <section className="rounded-2xl border p-6 mb-6" style={cardStyle}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-bold text-white">{title}</h2>
          {subtitle && <p className="text-xs mt-0.5" style={{ color: '#94a3b8' }}>{subtitle}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function SaveBadge({ state }) {
  if (!state) return null;
  const map = {
    saving: { text: 'Saving…', color: '#94a3b8' },
    saved: { text: 'Saved ✓', color: '#4ade80' },
  };
  const m = map[state];
  return m ? <span className="text-xs font-bold" style={{ color: m.color }}>{m.text}</span> : null;
}

export default function AdminPlayerEditorPage() {
  const { playerId } = useParams();
  const navigate = useNavigate();

  const [catalog, setCatalog] = useState(null);
  const [player, setPlayer] = useState(null);
  const [bio, setBio] = useState(BIO_DEFAULTS);
  const [ratings, setRatings] = useState(null); // engine-calculated, read-only
  const [games, setGames] = useState([]);
  const [statsByGame, setStatsByGame] = useState({});
  const [error, setError] = useState('');
  const [bioSave, setBioSave] = useState(null);
  const [openGameId, setOpenGameId] = useState(null);

  useEffect(() => {
    Promise.all([api.catalog(), api.getPlayer(playerId)])
      .then(([cat, { player, games, stats, ratings }]) => {
        setCatalog(cat);
        setPlayer(player);
        setRatings(ratings);
        const bioNext = { ...BIO_DEFAULTS };
        for (const k of Object.keys(BIO_DEFAULTS)) bioNext[k] = player[k] ?? '';
        setBio(bioNext);
        setGames(games);
        const byGame = {};
        for (const s of stats) (byGame[s.game_id] ??= {})[s.metric_key] = s.value;
        setStatsByGame(byGame);
      })
      .catch(err => setError(err.message));
  }, [playerId]);

  // Re-pull games, stats, and recalculated ratings (after edits or imports).
  async function reloadGames() {
    const { games, stats, ratings } = await api.getPlayer(playerId);
    setGames(games);
    setRatings(ratings);
    const byGame = {};
    for (const s of stats) (byGame[s.game_id] ??= {})[s.metric_key] = s.value;
    setStatsByGame(byGame);
  }

  const metricsByCategory = useMemo(() => {
    if (!catalog) return [];
    return catalog.categories.map(c => ({
      ...c,
      metrics: catalog.metrics.filter(m => m.category === c.key),
    }));
  }, [catalog]);

  async function saveBio(e) {
    e?.preventDefault();
    setBioSave('saving');
    setError('');
    try {
      const { player: updated } = await api.updatePlayer(playerId, { ...bio });
      setPlayer(updated);
      // DOB or position changes can shift the benchmark group — recalculate.
      await reloadGames();
      setBioSave('saved');
      setTimeout(() => setBioSave(null), 2000);
    } catch (err) {
      setBioSave(null);
      setError(err.message);
    }
  }

  async function deletePlayer() {
    if (!confirm(`Delete ${player.first_name} ${player.last_name} and all logged stats? This cannot be undone.`)) return;
    try {
      await api.deletePlayer(playerId);
      navigate('/admin');
    } catch (err) {
      setError(err.message);
    }
  }

  if (error && !player) return <ErrorNote>{error}</ErrorNote>;
  if (!player || !catalog) return <p style={{ color: '#94a3b8' }}>Loading…</p>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <Link to="/admin" className="text-xs hover:underline" style={{ color: '#64748b' }}>← All players</Link>
          <h1 className="text-2xl font-bold text-white mt-1">{player.first_name} {player.last_name}</h1>
          <a href={`/p/${player.slug}`} target="_blank" rel="noreferrer" className="text-sm hover:underline" style={{ color: '#38bdf8' }}>
            Public profile: /p/{player.slug} ↗
          </a>
        </div>
        <GhostButton onClick={deletePlayer} style={{ borderColor: '#7f1d1d', color: '#f87171' }}>
          Delete player
        </GhostButton>
      </div>

      <ErrorNote>{error}</ErrorNote>

      {/* ── Bio ── */}
      <form onSubmit={saveBio}>
        <SectionCard
          title="Player Profile"
          subtitle="Header info shown on the public profile."
          actions={<div className="flex items-center gap-3"><SaveBadge state={bioSave} /><PrimaryButton type="submit">Save profile</PrimaryButton></div>}
        >
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Field label="First name"><TextInput value={bio.first_name} onChange={e => setBio({ ...bio, first_name: e.target.value })} required /></Field>
            <Field label="Last name"><TextInput value={bio.last_name} onChange={e => setBio({ ...bio, last_name: e.target.value })} required /></Field>
            <Field label="School"><TextInput value={bio.school} onChange={e => setBio({ ...bio, school: e.target.value })} /></Field>
            <Field label="Grad class"><TextInput type="number" placeholder="2027" value={bio.grad_year} onChange={e => setBio({ ...bio, grad_year: e.target.value })} /></Field>
            <Field label="City"><TextInput value={bio.city} onChange={e => setBio({ ...bio, city: e.target.value })} /></Field>
            <Field label="State"><TextInput value={bio.state} onChange={e => setBio({ ...bio, state: e.target.value })} /></Field>
            <Field label="Primary position">
              <Select value={bio.primary_position} onChange={e => setBio({ ...bio, primary_position: e.target.value })}>
                <option value="">—</option>
                {POSITIONS.map(p => <option key={p} value={p}>{p}</option>)}
              </Select>
            </Field>
            <div className="col-span-2">
              <SecondaryPositionsPicker
                value={bio.secondary_position}
                primary={bio.primary_position}
                onToggle={pos => setBio(prev => {
                  const sel = (prev.secondary_position || '').split(',').map(s => s.trim()).filter(Boolean);
                  const next = sel.includes(pos) ? sel.filter(p => p !== pos) : [...sel, pos];
                  return { ...prev, secondary_position: next.join(', ') };
                })}
              />
            </div>
            <Field label={'Height (e.g. 6\'2")'}><TextInput value={bio.height} onChange={e => setBio({ ...bio, height: e.target.value })} /></Field>
            <Field label="Weight (lbs)"><TextInput type="number" value={bio.weight_lbs} onChange={e => setBio({ ...bio, weight_lbs: e.target.value })} /></Field>
            <Field label="Bats">
              <Select value={bio.bats} onChange={e => setBio({ ...bio, bats: e.target.value })}>
                <option value="">—</option><option>R</option><option>L</option><option>S</option>
              </Select>
            </Field>
            <Field label="Throws">
              <Select value={bio.throws} onChange={e => setBio({ ...bio, throws: e.target.value })}>
                <option value="">—</option><option>R</option><option>L</option>
              </Select>
            </Field>
            <Field label="Date of birth (sets age-group benchmarks)">
              <TextInput type="date" value={bio.date_of_birth || ''} onChange={e => setBio({ ...bio, date_of_birth: e.target.value })} />
            </Field>
            <Field label="Committed to"><TextInput placeholder="BYU" value={bio.committed_to} onChange={e => setBio({ ...bio, committed_to: e.target.value })} /></Field>
            <Field label="College projection"><TextInput placeholder="4 Year Starter" value={bio.college_projection} onChange={e => setBio({ ...bio, college_projection: e.target.value })} /></Field>
            <Field label="Photo URL"><TextInput placeholder="https://…" value={bio.photo_url} onChange={e => setBio({ ...bio, photo_url: e.target.value })} /></Field>
          </div>

          <div className="mt-5 flex items-center gap-2">
            <input
              id="is_public"
              type="checkbox"
              checked={!!Number(bio.is_public)}
              onChange={e => setBio({ ...bio, is_public: e.target.checked ? 1 : 0 })}
            />
            <label htmlFor="is_public" className="text-sm" style={{ color: '#cfe8ff' }}>
              Public profile enabled (shareable at /p/{player.slug})
            </label>
          </div>
        </SectionCard>
      </form>

      {/* ── Calculated ratings (read-only, requirements §10) ── */}
      <RatingsPanel ratings={ratings} />

      {/* ── Player account invite ── */}
      <InvitePanel playerId={playerId} onError={setError} />

      {/* ── Games & stats ── */}
      <SectionCard
        title="Games & Stats"
        subtitle="Log an event, then enter the stats captured for it. Values roll up into the public profile."
        actions={
          <StatImport
            playerId={playerId}
            games={games}
            catalog={catalog}
            onComplete={reloadGames}
            onError={setError}
          />
        }
      >
        <NewGameForm
          gameTypes={catalog.gameTypes}
          onCreate={async (game) => {
            const { game: created } = await api.createGame(playerId, game);
            setGames(g => [created, ...g]);
            setOpenGameId(created.id);
          }}
          onError={setError}
        />

        {games.length === 0 ? (
          <p className="text-sm mt-4" style={{ color: '#94a3b8' }}>No games logged yet.</p>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            {games.map(g => (
              <GameRow
                key={g.id}
                game={g}
                open={openGameId === g.id}
                onToggle={() => setOpenGameId(openGameId === g.id ? null : g.id)}
                stats={statsByGame[g.id] || {}}
                metricsByCategory={metricsByCategory}
                onSaveStats={async (stats) => {
                  const { stats: saved, zero_treated_as_unmeasured: zeroed } = await api.saveGameStats(g.id, stats);
                  setStatsByGame(s => ({ ...s, [g.id]: saved }));
                  if (zeroed?.length) {
                    setError(`Note: ${zeroed.join(', ')} = 0 treated as not measured (a 0 mph/0 s/0 % mark isn't real data — leave blank to omit).`);
                  }
                  api.getPlayer(playerId).then(d => setRatings(d.ratings)).catch(() => {});
                }}
                onDelete={async () => {
                  if (!confirm('Delete this game and its stats?')) return;
                  await api.deleteGame(g.id);
                  setGames(gs => gs.filter(x => x.id !== g.id));
                  api.getPlayer(playerId).then(d => setRatings(d.ratings)).catch(() => {});
                }}
                onError={setError}
              />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// Engine-calculated ratings are read-only: admins enter raw measurements and
// the rating engine derives everything shown here (requirements V1 §10).
function RatingsPanel({ ratings }) {
  if (!ratings) {
    return (
      <SectionCard
        title="Calculated Ratings"
        subtitle="Ratings are generated automatically from Pro Day measurements — no manual entry."
      >
        <p className="text-sm" style={{ color: '#94a3b8' }}>
          No Pro Day event logged yet. Log one (or import its CSV) and Overall, skills,
          archetype, and tier will calculate from the raw measurements.
        </p>
      </SectionCard>
    );
  }

  const dash = <span style={{ color: '#475569' }}>—</span>;
  const skillEntries = Object.entries(SKILL_LABELS).filter(([k]) => k in ratings.skills);

  return (
    <SectionCard
      title="Calculated Ratings"
      subtitle={`${ratings.label} · read-only, derived from raw Pro Day measurements`}
    >
      <div className="flex flex-wrap items-center gap-6 mb-5">
        <div>
          <p className="text-4xl font-extrabold text-white">
            {ratings.overall ? ratings.overall.value : dash}
            <span className="text-sm ml-1" style={{ color: '#64748b' }}>/100</span>
          </p>
          <p className="text-xs font-bold uppercase tracking-wider" style={{ color: '#38bdf8' }}>
            Overall{ratings.overall?.provisional ? ' · provisional' : ''}
          </p>
        </div>
        {ratings.tier && (
          <div>
            <p className="text-lg font-bold" style={{ color: '#fbbf24' }}>{ratings.tier}</p>
            <p className="text-xs font-bold uppercase tracking-wider" style={{ color: '#64748b' }}>Tier</p>
          </div>
        )}
        {ratings.archetype && (
          <div>
            <p className="text-lg font-bold text-white">{ratings.archetype}</p>
            <p className="text-xs font-bold uppercase tracking-wider" style={{ color: '#64748b' }}>Archetype</p>
          </div>
        )}
        {ratings.isTwoWay && ratings.secondaryOverall && (
          <div>
            <p className="text-lg font-bold text-white">{ratings.secondaryOverall.value} <span className="text-xs" style={{ color: '#64748b' }}>({ratings.secondaryOverall.formulaLabel})</span></p>
            <p className="text-xs font-bold uppercase tracking-wider" style={{ color: '#64748b' }}>Two-way second overall</p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-9 gap-3 mb-4">
        {skillEntries.map(([key, label]) => (
          <div key={key} className="rounded-xl border px-2 py-2 text-center" style={{ borderColor: '#1e3a5f', backgroundColor: 'rgba(30,41,59,0.5)' }}>
            <p className="text-xl font-extrabold text-white">{ratings.skills[key] ? ratings.skills[key].rating : dash}</p>
            <p className="text-[9px] font-bold uppercase tracking-wider" style={{ color: '#64748b' }}>
              {label}{ratings.skills[key]?.partial ? '*' : ''}
            </p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs" style={{ color: '#94a3b8' }}>
        <span>Age group: <b className="text-white">{ratings.ageGroup ?? '—'}</b>{ratings.ageSource === 'grad_class' ? ' (from grad class — add DOB for accuracy)' : ''}</span>
        <span>Benchmarks: <b className="text-white">{ratings.benchmark.version ?? '—'}</b></span>
        {ratings.strengths.length > 0 && <span>Strengths: <b style={{ color: '#4ade80' }}>{ratings.strengths.map(s => SKILL_LABELS[s]).join(', ')}</b></span>}
        {ratings.developmentAreas.length > 0 && <span>Development: <b style={{ color: '#fbbf24' }}>{ratings.developmentAreas.map(s => SKILL_LABELS[s]).join(', ')}</b></span>}
        <span>Calculated {new Date(ratings.calculatedAt).toLocaleString()}</span>
      </div>
      <p className="text-[11px] mt-2" style={{ color: '#475569' }}>* partial input data — rating provisional. Em dash = insufficient measurements (missing data never counts as zero).</p>
    </SectionCard>
  );
}

// Invite panel: generate a claim link for the player/parent, or show who
// has already claimed the account.
function InvitePanel({ playerId, onError }) {
  const [state, setState] = useState(null); // { invite, account }
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getInvite(playerId).then(setState).catch(err => onError(err.message));
  }, [playerId, onError]);

  async function generate() {
    setBusy(true);
    try {
      const { invite } = await api.createInvite(playerId);
      setState(s => ({ ...s, invite }));
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(`${window.location.origin}/claim/${state.invite.token}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!state) return null;

  return (
    <SectionCard
      title="Player Account"
      subtitle="Send an invite link so the player or parent can claim their account and sign in to see their own profile."
    >
      {state.account ? (
        <p className="text-sm" style={{ color: '#4ade80' }}>
          ✓ Claimed by <b>{state.account.email}</b> — they can sign in at /login.
        </p>
      ) : state.invite ? (
        <div className="flex flex-wrap items-center gap-3">
          <code className="text-xs px-3 py-2 rounded-lg" style={{ backgroundColor: 'rgba(30,41,59,0.95)', color: '#7dd3fc' }}>
            {window.location.origin}/claim/{state.invite.token}
          </code>
          <PrimaryButton type="button" onClick={copy}>{copied ? 'Copied ✓' : 'Copy invite link'}</PrimaryButton>
          <GhostButton type="button" disabled={busy} onClick={generate}>Regenerate</GhostButton>
          <span className="text-xs" style={{ color: '#64748b' }}>Expires {state.invite.expires_at.slice(0, 10)}</span>
        </div>
      ) : (
        <PrimaryButton type="button" disabled={busy} onClick={generate}>
          {busy ? 'Generating…' : 'Generate invite link'}
        </PrimaryButton>
      )}
    </SectionCard>
  );
}

function NewGameForm({ gameTypes, onCreate, onError }) {
  const [form, setForm] = useState({ game_date: '', game_type: 'game', opponent: '', location: '', notes: '' });
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await onCreate(form);
      setForm({ game_date: '', game_type: 'game', opponent: '', location: '', notes: '' });
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid grid-cols-2 md:grid-cols-5 gap-3 items-end p-4 rounded-xl" style={{ backgroundColor: 'rgba(30, 41, 59, 0.5)' }}>
      <Field label="Date"><TextInput type="date" value={form.game_date} onChange={e => setForm({ ...form, game_date: e.target.value })} required /></Field>
      <Field label="Type">
        <Select value={form.game_type} onChange={e => setForm({ ...form, game_type: e.target.value })}>
          {gameTypes.map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
        </Select>
      </Field>
      <Field label="Opponent / event"><TextInput placeholder="vs Corner Canyon" value={form.opponent} onChange={e => setForm({ ...form, opponent: e.target.value })} /></Field>
      <Field label="Location"><TextInput value={form.location} onChange={e => setForm({ ...form, location: e.target.value })} /></Field>
      <PrimaryButton type="submit" disabled={busy}>{busy ? 'Adding…' : '+ Add game'}</PrimaryButton>
    </form>
  );
}

function GameRow({ game, open, onToggle, stats, metricsByCategory, onSaveStats, onDelete, onError }) {
  const statCount = Object.keys(stats).length;

  return (
    <div className="rounded-xl border" style={{ borderColor: '#1e3a5f' }}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 cursor-pointer text-left"
      >
        <div className="flex items-center gap-3">
          <span className="font-bold text-white text-sm">{game.game_date}</span>
          <span className="text-xs uppercase tracking-wider px-2 py-0.5 rounded" style={{ backgroundColor: 'rgba(56, 189, 248, 0.12)', color: '#38bdf8' }}>
            {game.game_type.replace('_', ' ')}
          </span>
          {game.opponent && <span className="text-sm" style={{ color: '#94a3b8' }}>{game.opponent}</span>}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs" style={{ color: '#64748b' }}>{statCount} stat{statCount === 1 ? '' : 's'}</span>
          <span style={{ color: '#64748b' }}>{open ? '▾' : '▸'}</span>
        </div>
      </button>

      {open && (
        <GameStatsEditor
          stats={stats}
          metricsByCategory={metricsByCategory}
          onSaveStats={onSaveStats}
          onDelete={onDelete}
          onError={onError}
        />
      )}
    </div>
  );
}

// Mounted only while a game row is expanded, so the draft picks up the
// latest saved stats on each open without any state-syncing effects.
function GameStatsEditor({ stats, metricsByCategory, onSaveStats, onDelete, onError }) {
  const [draft, setDraft] = useState(stats);
  const [saveState, setSaveState] = useState(null);

  async function save() {
    setSaveState('saving');
    try {
      // Send the full draft; blanks clear existing entries server-side.
      const payload = {};
      for (const cat of metricsByCategory) {
        for (const m of cat.metrics) {
          const v = draft[m.key];
          payload[m.key] = v === undefined || v === '' ? null : v;
        }
      }
      await onSaveStats(payload);
      setSaveState('saved');
      setTimeout(() => setSaveState(null), 2000);
    } catch (err) {
      setSaveState(null);
      onError(err.message);
    }
  }

  return (
    <div className="px-4 pb-4 border-t pt-4" style={{ borderColor: '#1e3a5f' }}>
      {metricsByCategory.map(cat => (
        <div key={cat.key} className="mb-4">
          <p className="text-xs font-bold uppercase tracking-wider mb-2" style={{ color: '#64748b' }}>{cat.label}</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {cat.metrics.map(m => (
              <Field key={m.key} label={`${m.label}${m.unit ? ` (${m.unit})` : ''}`}>
                <TextInput
                  type="number"
                  step="any"
                  value={draft[m.key] ?? ''}
                  onChange={e => setDraft(d => ({ ...d, [m.key]: e.target.value }))}
                />
              </Field>
            ))}
          </div>
        </div>
      ))}
      <div className="flex items-center justify-between mt-2">
        <GhostButton type="button" onClick={onDelete} style={{ borderColor: '#7f1d1d', color: '#f87171' }}>
          Delete game
        </GhostButton>
        <div className="flex items-center gap-3">
          <SaveBadge state={saveState} />
          <PrimaryButton type="button" onClick={save}>Save stats</PrimaryButton>
        </div>
      </div>
    </div>
  );
}
