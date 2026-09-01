import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { Field, TextInput, Select, PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import { cardStyle } from '../../components/admin/theme';

// Bulk tournament job creation (Command M6). A weekend tournament is 20–40
// jobs; creating them one at a time is the difference between Command being
// usable at event scale and not. Preview first, then create in one
// transaction — re-running skips games that already have jobs.

export default function BulkJobsPage() {
  const navigate = useNavigate();
  const [boot, setBoot] = useState(null);
  const [form, setForm] = useState({
    tournament_id: '', package_key: 'rookie', assigned_to: '', due_date: '',
    contact_email: '', sharing_scope: 'customer', media_consent: true, synthetic: false,
  });
  const [teamIds, setTeamIds] = useState([]);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.commandBootstrap().then(setBoot).catch(err => setError(err.message)); }, []);

  // Teams that actually appear in the selected tournament's schedule.
  const tournamentTeams = useMemo(() => {
    if (!boot || !form.tournament_id) return [];
    const games = boot.tournament_games.filter(g => String(g.tournament_id) === String(form.tournament_id));
    const seen = new Map();
    for (const g of games) {
      if (g.home_team_id) seen.set(g.home_team_id, g.home_team_name);
      if (g.away_team_id) seen.set(g.away_team_id, g.away_team_name);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [boot, form.tournament_id]);

  const body = () => ({
    tournament_id: Number(form.tournament_id),
    package_key: form.package_key,
    team_ids: teamIds,
    assigned_to: form.assigned_to ? Number(form.assigned_to) : null,
    due_date: form.due_date || null,
    contact_email: form.contact_email,
    sharing_scope: form.sharing_scope,
    media_consent: form.media_consent,
    synthetic: form.synthetic,
  });

  async function runPreview() {
    setError('');
    setBusy(true);
    try {
      setPreview(await api.commandBulkJobs({ ...body(), dry_run: true }));
    } catch (err) {
      setError(err.message);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    setError('');
    setBusy(true);
    try {
      const result = await api.commandBulkJobs(body());
      navigate('/command', { state: { created: result.created.length } });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!boot) return <p style={{ color: '#94a3b8' }}>{error || 'Loading…'}</p>;

  const toCreate = preview?.planned.filter(p => !p.skipped) || [];
  const skipped = preview?.planned.filter(p => p.skipped) || [];

  return (
    <div>
      <Link to="/command" className="text-xs hover:underline" style={{ color: '#64748b' }}>← Production queue</Link>
      <h1 className="text-2xl font-bold text-white mt-1">Bulk tournament jobs</h1>
      <p className="text-sm mt-1 mb-5" style={{ color: '#94a3b8' }}>
        One job per team per scheduled game, each with its own order and release track. Preview before creating; games that already have jobs are skipped.
      </p>

      <ErrorNote>{error}</ErrorNote>

      <section className="rounded-2xl border p-5 mb-4" style={cardStyle}>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          <Field label="Tournament">
            <Select value={form.tournament_id} onChange={e => { setForm(f => ({ ...f, tournament_id: e.target.value })); setTeamIds([]); setPreview(null); }}>
              <option value="">— select —</option>
              {boot.tournaments.map(t => <option key={t.id} value={t.id}>{t.name} ({t.start_date})</option>)}
            </Select>
          </Field>
          <Field label="Package">
            <Select value={form.package_key} onChange={e => { setForm(f => ({ ...f, package_key: e.target.value })); setPreview(null); }}>
              {boot.packages.filter(p => p.orderable).map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
            </Select>
          </Field>
          <Field label="Assign to">
            <Select value={form.assigned_to} onChange={e => setForm(f => ({ ...f, assigned_to: e.target.value }))}>
              <option value="">— unassigned —</option>
              {boot.analysts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.role})</option>)}
            </Select>
          </Field>
          <Field label="Due date">
            <TextInput type="date" value={form.due_date} onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))} />
          </Field>
          <Field label="Customer contact email">
            <TextInput type="email" value={form.contact_email} onChange={e => setForm(f => ({ ...f, contact_email: e.target.value }))} placeholder="coach@club.org" />
          </Field>
          <Field label="Sharing scope">
            <Select value={form.sharing_scope} onChange={e => setForm(f => ({ ...f, sharing_scope: e.target.value }))}>
              {(boot.sharing_scopes || ['internal', 'customer']).map(sc => (
                <option key={sc} value={sc}>{sc === 'internal' ? 'Internal only' : sc === 'customer' ? 'Customer' : sc}</option>
              ))}
            </Select>
          </Field>
        </div>

        <label className="flex items-center gap-2 mt-4 text-sm cursor-pointer" style={{ color: '#cfe8ff' }}>
          <input type="checkbox" checked={form.media_consent} onChange={e => setForm(f => ({ ...f, media_consent: e.target.checked }))} />
          Media consent recorded for every job in this batch
        </label>
        <label className="flex items-center gap-2 mt-2 text-sm cursor-pointer" style={{ color: '#fbbf24' }}>
          <input type="checkbox" checked={form.synthetic} onChange={e => setForm(f => ({ ...f, synthetic: e.target.checked }))} className="accent-amber-400" data-testid="bulk-synthetic-toggle" />
          Synthetic / test batch — labelled, no customer notifications, no profile publication, excluded from analytics
        </label>

        {tournamentTeams.length > 0 && (
          <div className="mt-4">
            <p className="text-[11px] font-bold uppercase tracking-widest mb-2" style={{ color: '#94a3b8' }}>
              Teams ({teamIds.length ? `${teamIds.length} selected` : 'all teams'})
            </p>
            <div className="flex flex-wrap gap-2">
              {tournamentTeams.map(t => {
                const on = teamIds.includes(t.id);
                return (
                  <button key={t.id}
                    onClick={() => { setTeamIds(ids => on ? ids.filter(i => i !== t.id) : [...ids, t.id]); setPreview(null); }}
                    className="px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer"
                    style={on ? { backgroundColor: '#38bdf8', color: '#06122b' } : { backgroundColor: 'rgba(30, 41, 59, 0.9)', color: '#94a3b8' }}>
                    {t.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex gap-2 mt-5">
          <GhostButton onClick={runPreview} disabled={!form.tournament_id || busy}>Preview</GhostButton>
          <PrimaryButton onClick={create} disabled={!preview || toCreate.length === 0 || busy}>
            {busy ? 'Working…' : `Create ${toCreate.length || ''} job${toCreate.length === 1 ? '' : 's'}`}
          </PrimaryButton>
        </div>
      </section>

      {preview && (
        <section className="rounded-2xl border overflow-hidden" style={cardStyle}>
          <div className="px-5 py-3 border-b" style={{ borderColor: '#1e3a5f' }}>
            <p className="text-sm font-bold text-white">
              {toCreate.length} job{toCreate.length === 1 ? '' : 's'} to create
              {skipped.length > 0 && <span style={{ color: '#fbbf24' }}> · {skipped.length} skipped (already exist)</span>}
            </p>
          </div>
          {preview.planned.length === 0 ? (
            <p className="px-5 py-6 text-sm" style={{ color: '#94a3b8' }}>
              No scheduled games found for this tournament{teamIds.length ? ' and team selection' : ''}.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider" style={{ color: '#64748b' }}>
                  <th className="px-5 py-2">Date</th><th className="px-5 py-2">Team</th>
                  <th className="px-5 py-2">Opponent</th><th className="px-5 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {preview.planned.map((p, i) => (
                  <tr key={`${p.tournament_game_id}-${p.team_id}-${i}`} className="border-t" style={{ borderColor: '#1e3a5f' }}>
                    <td className="px-5 py-2" style={{ color: '#94a3b8' }}>{p.game_date}</td>
                    <td className="px-5 py-2 font-bold text-white">{p.team_name}</td>
                    <td className="px-5 py-2" style={{ color: '#94a3b8' }}>{p.opponent_label}</td>
                    <td className="px-5 py-2 text-xs font-bold" style={{ color: p.skipped ? '#fbbf24' : '#4ade80' }}>
                      {p.skipped || 'will create'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
