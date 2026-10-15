import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ExternalLink, Pencil } from 'lucide-react';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/intake';
import { Field, TextInput, PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import { InfoTip } from '../../components/Tooltip';
import AccessPanel from '../../components/admin/AccessPanel';
import RecordActionDialog from '../../components/admin/RecordActionDialog';
import DivisionsSection from './tournament/DivisionsSection';
import EntriesSection from './tournament/EntriesSection';
import GamesSection from './tournament/GamesSection';
import { Chip, Section } from './tournament/shared';

// Tournament editor: details → divisions → team entries (event rosters,
// guests) → games. Everything can be corrected in place: entries move
// between divisions keeping their id and roster, games carry a bracket
// stage apart from their age division, and withdraw / archive / delete show
// what depends on a record first. Shared teams and players are never deleted.
export default function AdminTournamentEditorPage() {
  const { tournamentId } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState(null);
  const [teams, setTeams] = useState([]);
  const [trash, setTrash] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(false);
  const [ask, setAsk] = useState(null);   // { kind, id, action }
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    Promise.all([api.getTournament(tournamentId), api.listTeams(), api.eventTrash(tournamentId)])
      .then(([d, teamList, deleted]) => { setDetail(d); setTeams(teamList.teams); setTrash(deleted.items); })
      .catch(err => setError(err.message));
  }, [tournamentId, tick]);

  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  // Runs a change, reports it, reloads. Returns the result, or null after showing the error.
  const act = useCallback(async (fn, message) => {
    setError('');
    try {
      const r = await fn();
      setNotice(typeof message === 'function' ? message(r) : message);
      reload();
      return r ?? true;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }, [reload]);

  const onAsk = useCallback((kind, id, action) => setAsk({ kind, id, action }), []);

  async function confirmAsk() {
    const { kind, id, action } = ask;
    if (action === 'withdraw') await api.updateEntry(id, { status: 'withdrawn' });
    else if (action === 'archive') await api.archiveRecord(kind, id);
    else await api.deleteRecord(kind, id);
    if (kind === 'tournament' && action === 'delete') {
      navigate('/admin/tournaments');
      return;
    }
    setNotice(action === 'delete' ? 'Deleted — restore it from Recently deleted below.' : action === 'archive' ? 'Archived' : 'Withdrawn');
    reload();
  }

  if (error && !detail) return <ErrorNote>{error}</ErrorNote>;
  if (!detail) return <p style={{ color: '#94a3b8' }}>Loading…</p>;
  const { tournament, divisions, entries, games, aliases } = detail;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <Link to="/admin/tournaments" className="text-xs hover:underline" style={{ color: '#64748b' }}>← All tournaments</Link>
          <div className="flex items-center gap-2 mt-1">
            <h1 className="text-2xl font-bold text-white">{tournament.name}</h1>
            {tournament.archived ? <Chip tone="muted">Archived</Chip> : null}
          </div>
          <p className="text-sm flex flex-wrap items-center gap-x-2" style={{ color: '#94a3b8' }}>
            <span>{tournament.start_date} → {tournament.end_date}</span>
            {tournament.location && <span>· {tournament.location}</span>}
            <span>·</span>
            <a href={`/tournaments/${tournament.slug}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline" style={{ color: '#38bdf8' }}>
              /tournaments/{tournament.slug} <ExternalLink size={12} aria-hidden="true" />
            </a>
          </p>
        </div>
        <div className="flex gap-2">
          <GhostButton type="button" onClick={() => setEditing(v => !v)} aria-expanded={editing} data-testid="edit-details">
            <span className="inline-flex items-center gap-1.5"><Pencil size={14} aria-hidden="true" />Edit details</span>
          </GhostButton>
          <GhostButton
            type="button"
            onClick={() => act(() => api.updateTournament(tournament.id, { published: tournament.published ? 0 : 1 }), tournament.published ? 'Unpublished' : 'Published')}
            style={tournament.published ? { borderColor: '#166534', color: '#4ade80' } : {}}
          >
            {tournament.published ? 'Published ✓' : 'Publish'}
          </GhostButton>
        </div>
      </div>

      {tournament.archived ? (
        <div className="flex flex-wrap items-center gap-3 mb-4 px-4 py-3 rounded-xl text-sm" style={{ backgroundColor: 'rgba(71, 85, 105, 0.25)', color: '#cbd5e1' }}>
          Archived — hidden from the public dashboard and team pages.
          <GhostButton type="button" onClick={() => act(() => api.restoreRecord('tournament', tournament.id), 'Tournament restored')} style={{ padding: '3px 12px' }}>Restore</GhostButton>
        </div>
      ) : null}

      {notice && <p role="status" className="text-sm py-2 px-3 rounded-lg mb-4" style={{ backgroundColor: 'rgba(74, 222, 128, 0.12)', color: '#4ade80' }} data-testid="notice">{notice}</p>}
      <div className="mb-4"><ErrorNote>{error}</ErrorNote></div>

      {editing && <DetailsForm tournament={tournament} aliases={aliases} act={act} onDone={() => setEditing(false)} />}

      <AccessPanel
        kind="tournaments"
        id={tournamentId}
        title="Director access"
        subtitle="Directors see this tournament's divisions, teams, and games. Send the invite link so they can claim their account."
        onError={setError}
      />

      <DivisionsSection tournament={tournament} divisions={divisions} act={act} onAskDelete={(kind, id) => onAsk(kind, id, 'delete')} />
      <EntriesSection tournament={tournament} divisions={divisions} entries={entries} teams={teams} act={act} onAsk={onAsk} onError={setError} />
      <GamesSection tournament={tournament} divisions={divisions} entries={entries} games={games} act={act} onAsk={onAsk} />

      {trash.length > 0 && (
        <Section title="Recently deleted" testId="trash">
          <div className="flex flex-col">
            {trash.map(item => (
              <div key={item.id} className="flex flex-wrap items-center gap-3 border-t py-2 text-sm" style={{ borderColor: '#1e3a5f' }}>
                <Chip tone="muted">{item.kind}</Chip>
                <span className="font-bold text-white flex-1 min-w-[200px]">{item.label}</span>
                <span className="text-xs" style={{ color: '#64748b' }}>{fmtDateTime(item.deleted_at)}{item.deleted_by_name ? ` · ${item.deleted_by_name}` : ''}</span>
                <GhostButton type="button" style={{ padding: '3px 12px' }} onClick={() => act(() => api.restoreEventTrash(item.id), `Restored ${item.label}`)}>Restore</GhostButton>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="Archive or delete" testId="danger"
        aside={<InfoTip label="About archive and delete">Archiving hides the event and keeps everything. Deleting removes its divisions, entries and games (restorable from the tournament list); shared teams and player profiles are never deleted.</InfoTip>}>
        <div className="flex flex-wrap gap-2">
          {tournament.archived
            ? <GhostButton type="button" onClick={() => act(() => api.restoreRecord('tournament', tournament.id), 'Tournament restored')}>Restore tournament</GhostButton>
            : <GhostButton type="button" onClick={() => onAsk('tournament', tournament.id, 'archive')}>Archive tournament</GhostButton>}
          <GhostButton type="button" onClick={() => onAsk('tournament', tournament.id, 'delete')} style={{ borderColor: '#7f1d1d', color: '#f87171' }}>Delete tournament</GhostButton>
        </div>
      </Section>

      {ask && <RecordActionDialog {...ask} onConfirm={confirmAsk} onClose={() => setAsk(null)} />}
    </div>
  );
}

function DetailsForm({ tournament, aliases, act, onDone }) {
  const [form, setForm] = useState({
    name: tournament.name, start_date: tournament.start_date, end_date: tournament.end_date,
    location: tournament.location || '', organizer: tournament.organizer || '', slug: tournament.slug,
  });
  const set = k => e => setForm({ ...form, [k]: e.target.value });

  async function save(e) {
    e.preventDefault();
    // Only what changed, so an untouched URL is never rewritten.
    const changed = Object.fromEntries(Object.entries(form).filter(([k, v]) => v !== (tournament[k] ?? '')));
    if (!Object.keys(changed).length) { onDone(); return; }
    if (await act(() => api.updateTournament(tournament.id, changed), 'Details saved')) onDone();
  }

  const urlHint = `Renaming never changes the URL. If you change it, ${aliases.length ? 'the old links ' : 'the old link '}keep working and open the new one.`
    + (aliases.length ? ` Old links: ${aliases.map(a => `/tournaments/${a.slug}`).join(', ')}.` : '');

  return (
    <form onSubmit={save} className="rounded-2xl border p-5 mb-6 grid grid-cols-1 md:grid-cols-3 gap-4 items-end" style={{ backgroundColor: 'rgba(15, 23, 42, 0.78)', borderColor: '#1e3a5f' }} data-testid="details-form">
      <Field label="Name"><TextInput value={form.name} onChange={set('name')} required /></Field>
      <Field label="Start date"><TextInput type="date" value={form.start_date} onChange={set('start_date')} required /></Field>
      <Field label="End date"><TextInput type="date" value={form.end_date} onChange={set('end_date')} min={form.start_date} required /></Field>
      <Field label="Location"><TextInput value={form.location} onChange={set('location')} /></Field>
      <Field label="Organizer"><TextInput value={form.organizer} onChange={set('organizer')} /></Field>
      <Field label="Public URL" hint={urlHint}>
        <div className="flex items-center rounded-lg border overflow-hidden" style={{ borderColor: '#334155' }}>
          <span className="pl-3 text-sm whitespace-nowrap" style={{ color: '#64748b' }}>/tournaments/</span>
          <TextInput value={form.slug} onChange={e => setForm({ ...form, slug: e.target.value.toLowerCase() })} required aria-label="Public URL"
            style={{ border: 0, paddingLeft: 2 }} pattern="[a-z0-9]+(-[a-z0-9]+)*" title="Lowercase letters, numbers and single hyphens" />
        </div>
      </Field>
      <div className="md:col-span-3 flex gap-2">
        <PrimaryButton type="submit">Save details</PrimaryButton>
        <GhostButton type="button" onClick={onDone}>Cancel</GhostButton>
      </div>
    </form>
  );
}
