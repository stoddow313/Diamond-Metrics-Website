// Team entries by division: enter a team, edit seed / pool / placement /
// record, move to another division (same entry, same event roster), the
// event roster, and withdraw / archive / delete with their undo.
import { useEffect, useState } from 'react';
import { Archive, ArrowRightLeft, Pencil, RotateCcw, Trash2, UserMinus, Users } from 'lucide-react';
import { api } from '../../../lib/api';
import { Field, TextInput, Select, PrimaryButton, GhostButton } from '../../../components/admin/ui';
import { InfoTip } from '../../../components/Tooltip';
import { numOrNull, fromNull, plural } from './options';
import { Chip, IconButton, Section, Toggle, Tray } from './shared';

export default function EntriesSection({ tournament, divisions, entries, teams, act, onAsk, onError }) {
  const [form, setForm] = useState({ division_id: '', team_id: '', seed: '' });
  const [open, setOpen] = useState(null);   // { id, mode: 'edit' | 'move' | 'roster' }
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = entries.filter(e => e.status === 'archived').length;
  const visible = entries.filter(e => showArchived || e.status !== 'archived');
  const toggle = (id, mode) => setOpen(open?.id === id && open.mode === mode ? null : { id, mode });

  async function add(e) {
    e.preventDefault();
    const ok = await act(() => api.createEntry(tournament.id, {
      division_id: Number(form.division_id), team_id: Number(form.team_id), seed: numOrNull(form.seed),
    }), 'Team entered');
    if (ok) setForm({ division_id: form.division_id, team_id: '', seed: '' });
  }

  return (
    <Section title="Teams" testId="entries"
      aside={archivedCount > 0 && <Toggle checked={showArchived} onChange={setShowArchived} testId="show-archived-entries">Show archived ({archivedCount})</Toggle>}>
      <form onSubmit={add} className="flex flex-wrap gap-3 items-end mb-4">
        <Field label="Division">
          <Select value={form.division_id} onChange={e => setForm({ ...form, division_id: e.target.value })} required>
            <option value="">—</option>
            {divisions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </Field>
        <Field label="Team">
          <Select value={form.team_id} onChange={e => setForm({ ...form, team_id: e.target.value })} required>
            <option value="">—</option>
            {teams.map(t => <option key={t.id} value={t.id}>{t.name}{t.age_group ? ` (${t.age_group})` : ''}</option>)}
          </Select>
        </Field>
        <Field label="Seed"><TextInput type="number" min="1" value={form.seed} onChange={e => setForm({ ...form, seed: e.target.value })} style={{ width: 80 }} /></Field>
        <PrimaryButton type="submit">Enter team</PrimaryButton>
      </form>

      {visible.length === 0 ? (
        <p className="text-sm" style={{ color: '#94a3b8' }}>No teams entered yet.</p>
      ) : divisions.map(d => {
        const rows = visible.filter(e => e.division_id === d.id);
        if (!rows.length) return null;
        return (
          <div key={d.id} className="mb-4">
            <p className="text-xs font-bold uppercase tracking-wider mb-1" style={{ color: '#64748b' }}>{d.name}</p>
            {rows.map(e => (
              <div key={e.id} className="border-t py-1.5" style={{ borderColor: '#1e3a5f', opacity: e.status === 'archived' ? 0.6 : 1 }} data-testid={`entry-${e.id}`}>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-bold text-white mr-1">{e.team_name}</span>
                  {e.seed != null && <Chip tone="muted">Seed {e.seed}</Chip>}
                  {e.pool && <Chip tone="muted">Pool {e.pool}</Chip>}
                  {(e.wins != null || e.losses != null) && <Chip tip="Entered record — used in the standings instead of final scores">{e.wins ?? 0}-{e.losses ?? 0}</Chip>}
                  {e.placement && <Chip tone="good">{e.placement}</Chip>}
                  {e.status === 'withdrawn' && <Chip tone="warn" testId="withdrawn">Withdrawn</Chip>}
                  {e.status === 'archived' && <Chip tone="muted">Archived</Chip>}
                  <span className="flex-1 text-xs" style={{ color: '#64748b' }}>
                    {plural(e.game_count, 'game')} · {e.event_roster_count > 0 ? `${e.event_roster_count} on event roster` : 'season roster'}
                  </span>
                  <IconButton icon={Pencil} label="Edit seed, pool, placement and record" active={open?.id === e.id && open.mode === 'edit'} onClick={() => toggle(e.id, 'edit')} />
                  <IconButton icon={ArrowRightLeft} label="Move to another division" disabled={divisions.length < 2} active={open?.id === e.id && open.mode === 'move'} onClick={() => toggle(e.id, 'move')} testId={`move-${e.id}`} />
                  <IconButton icon={Users} label="Event roster" active={open?.id === e.id && open.mode === 'roster'} onClick={() => toggle(e.id, 'roster')} />
                  {e.status === 'active' && <IconButton icon={UserMinus} label="Withdraw from the event" onClick={() => onAsk('entry', e.id, 'withdraw')} />}
                  {e.status === 'withdrawn' && <IconButton icon={RotateCcw} label="Reinstate" onClick={() => act(() => api.updateEntry(e.id, { status: 'active' }), `${e.team_name} reinstated`)} />}
                  {e.status !== 'archived'
                    ? <IconButton icon={Archive} label="Archive" onClick={() => onAsk('entry', e.id, 'archive')} />
                    : <IconButton icon={RotateCcw} label="Restore" onClick={() => act(() => api.restoreRecord('entry', e.id), `${e.team_name} restored`)} />}
                  <IconButton icon={Trash2} label="Delete entry" tone="danger" onClick={() => onAsk('entry', e.id, 'delete')} />
                </div>
                {open?.id === e.id && open.mode === 'edit' && <EditEntry entry={e} act={act} onDone={() => setOpen(null)} />}
                {open?.id === e.id && open.mode === 'move' && <MoveEntry entry={e} divisions={divisions} act={act} onDone={() => setOpen(null)} />}
                {open?.id === e.id && open.mode === 'roster' && <EventRosterEditor entryId={e.id} onError={onError} act={act} />}
              </div>
            ))}
          </div>
        );
      })}
    </Section>
  );
}

function EditEntry({ entry, act, onDone }) {
  const [form, setForm] = useState({
    seed: fromNull(entry.seed), pool: entry.pool || '', placement: entry.placement || '',
    wins: fromNull(entry.wins), losses: fromNull(entry.losses),
  });
  const set = k => e => setForm({ ...form, [k]: e.target.value });
  async function save(e) {
    e.preventDefault();
    const ok = await act(() => api.updateEntry(entry.id, {
      seed: numOrNull(form.seed), pool: form.pool, placement: form.placement,
      wins: numOrNull(form.wins), losses: numOrNull(form.losses),
    }), `${entry.team_name} saved`);
    if (ok) onDone();
  }
  return (
    <Tray onSubmit={save}>
      <Field label="Seed"><TextInput type="number" min="1" value={form.seed} onChange={set('seed')} style={{ width: 72 }} /></Field>
      <Field label="Pool"><TextInput value={form.pool} onChange={set('pool')} style={{ width: 72 }} placeholder="A" /></Field>
      <Field label="Placement"><TextInput value={form.placement} onChange={set('placement')} style={{ width: 150 }} placeholder="1st — Gold" /></Field>
      <Field label="W" hint="Leave W and L blank to count the record from final scores."><TextInput type="number" min="0" value={form.wins} onChange={set('wins')} style={{ width: 64 }} aria-label="Wins" /></Field>
      <Field label="L"><TextInput type="number" min="0" value={form.losses} onChange={set('losses')} style={{ width: 64 }} aria-label="Losses" /></Field>
      <PrimaryButton type="submit">Save</PrimaryButton>
      <GhostButton type="button" onClick={onDone}>Cancel</GhostButton>
    </Tray>
  );
}

function MoveEntry({ entry, divisions, act, onDone }) {
  const [to, setTo] = useState('');
  async function move(e) {
    e.preventDefault();
    const ok = await act(() => api.moveEntry(entry.id, Number(to)), r =>
      `Moved ${entry.team_name}${r.games_moved ? ` · ${plural(r.games_moved, 'game')} followed` : ''}${r.games_left ? ` · ${plural(r.games_left, 'game')} still in ${r.from_division}` : ''}`);
    if (ok) onDone();
  }
  return (
    <Tray onSubmit={move}>
      <Field label="Move to">
        <Select value={to} onChange={e => setTo(e.target.value)} required style={{ minWidth: 150 }} data-testid="move-to">
          <option value="">—</option>
          {divisions.filter(d => d.id !== entry.division_id).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
      </Field>
      <PrimaryButton type="submit" disabled={!to}>Move</PrimaryButton>
      <GhostButton type="button" onClick={onDone}>Cancel</GhostButton>
      <InfoTip label="About moving">Keeps this entry, its event roster and results. A game moves with it once both of its teams are in the new division.</InfoTip>
    </Tray>
  );
}

function EventRosterEditor({ entryId, onError, act }) {
  const [data, setData] = useState(null);
  const [players, setPlayers] = useState([]);
  const [form, setForm] = useState({ player_id: '', is_guest: false, jersey: '' });
  const [tick, setTick] = useState(0);
  const load = () => setTick(t => t + 1);

  useEffect(() => {
    Promise.all([api.getEntryRoster(entryId), api.listPlayers()])
      .then(([rosterData, playerList]) => { setData(rosterData); setPlayers(playerList.players); })
      .catch(err => onError(err.message));
  }, [entryId, tick, onError]);

  async function add(e) {
    e.preventDefault();
    const ok = await act(() => api.addEventRosterRow(entryId, { player_id: Number(form.player_id), is_guest: form.is_guest ? 1 : 0, jersey: form.jersey }), 'Player added');
    if (ok) { setForm({ player_id: '', is_guest: false, jersey: '' }); load(); }
  }

  if (!data) return <p className="px-3 py-2 text-sm" style={{ color: '#94a3b8' }}>Loading roster…</p>;
  return (
    <div className="px-3 py-3 mt-1 rounded-xl" style={{ backgroundColor: 'rgba(30, 41, 59, 0.5)' }}>
      <form onSubmit={add} className="flex flex-wrap gap-3 items-end mb-3">
        <Field label="Player">
          <Select value={form.player_id} onChange={e => setForm({ ...form, player_id: e.target.value })} required>
            <option value="">—</option>
            {players.map(p => <option key={p.id} value={p.id}>{p.first_name} {p.last_name}</option>)}
          </Select>
        </Field>
        <Field label="Jersey"><TextInput value={form.jersey} onChange={e => setForm({ ...form, jersey: e.target.value })} style={{ width: 72 }} /></Field>
        <label className="flex items-center gap-2 text-sm pb-2" style={{ color: '#cfe8ff' }}>
          <input type="checkbox" checked={form.is_guest} onChange={e => setForm({ ...form, is_guest: e.target.checked })} />
          Guest
        </label>
        <PrimaryButton type="submit">Add</PrimaryButton>
        <InfoTip label="About event rosters">
          {data.source === 'season'
            ? 'Showing the season roster as of the event date. Adding a player locks an explicit event roster.'
            : 'Explicit event roster: it overrides the season roster for this event only.'}
        </InfoTip>
      </form>
      {data.roster.length === 0 ? (
        <p className="text-sm" style={{ color: '#94a3b8' }}>Nobody on this roster yet.</p>
      ) : (
        <div className="flex flex-col gap-1 text-sm">
          {data.roster.map(r => (
            <div key={r.player_id} className="flex items-center gap-3">
              <span className="font-bold text-white">{r.player ? `${r.player.first_name} ${r.player.last_name}` : `#${r.player_id}`}</span>
              {r.jersey && <span style={{ color: '#94a3b8' }}>#{r.jersey}</span>}
              {r.isGuest && <Chip tone="gold">Guest</Chip>}
              {r.source === 'season' && <span className="text-xs" style={{ color: '#475569' }}>season roster</span>}
              {r.event_roster_id && (
                <button type="button" className="text-xs cursor-pointer hover:underline" style={{ color: '#64748b' }}
                  onClick={async () => { if (await act(() => api.removeEventRosterRow(r.event_roster_id), 'Player removed')) load(); }}>
                  remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
