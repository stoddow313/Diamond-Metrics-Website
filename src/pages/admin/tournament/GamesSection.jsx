// Games: add (with bracket stage), quick score entry, full edit (date, time,
// field, status, stage, division, teams, score), archive / restore, delete.
import { useState } from 'react';
import { Archive, Pencil, Plus, RotateCcw, Trash2, TriangleAlert } from 'lucide-react';
import { api } from '../../../lib/api';
import { Field, TextInput, Select, PrimaryButton, GhostButton } from '../../../components/admin/ui';
import { Tooltip } from '../../../components/Tooltip';
import { GAME_STAGES, GAME_STATUSES, numOrNull, fromNull, stageTone } from './options';
import { Chip, IconButton, Section, Toggle, Tray } from './shared';

const EMPTY = { division_id: '', stage: '', home_entry_id: '', away_entry_id: '', game_date: '', game_time: '', field: '' };

export default function GamesSection({ tournament, divisions, entries, games, act, onAsk }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ ...EMPTY, game_date: tournament.start_date });
  const [filter, setFilter] = useState({ division: '', stage: '', archived: false });
  const [editing, setEditing] = useState(null);

  const archivedCount = games.filter(g => g.archived_at).length;
  const visible = games.filter(g =>
    (filter.archived || !g.archived_at)
    && (!filter.division || g.division_id === Number(filter.division))
    && (!filter.stage || (filter.stage === 'none' ? !g.stage : g.stage === filter.stage)));
  const entriesIn = divisionId => (divisionId ? entries.filter(e => e.division_id === Number(divisionId)) : entries)
    .filter(e => e.status !== 'archived');

  async function add(e) {
    e.preventDefault();
    const ok = await act(() => api.createTournamentGame(tournament.id, {
      division_id: Number(form.division_id), home_entry_id: Number(form.home_entry_id), away_entry_id: Number(form.away_entry_id),
      game_date: form.game_date, game_time: form.game_time, field: form.field, stage: form.stage || null,
    }), 'Game added');
    if (ok) setForm({ ...EMPTY, division_id: form.division_id, stage: form.stage, game_date: form.game_date });
  }

  async function saveScore(game, home, away) {
    await act(() => api.updateTournamentGame(game.id, {
      home_score: numOrNull(home), away_score: numOrNull(away),
      status: home !== '' && away !== '' ? 'final' : game.status,
    }), 'Score saved');
  }

  return (
    <Section title="Games" testId="games"
      aside={(
        <div className="flex flex-wrap items-center gap-2">
          <Select value={filter.division} onChange={e => setFilter({ ...filter, division: e.target.value })} aria-label="Filter by division" style={{ width: 'auto', padding: '4px 8px' }}>
            <option value="">All divisions</option>
            {divisions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
          <Select value={filter.stage} onChange={e => setFilter({ ...filter, stage: e.target.value })} aria-label="Filter by stage" style={{ width: 'auto', padding: '4px 8px' }}>
            <option value="">All stages</option>
            {GAME_STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            <option value="none">No stage</option>
          </Select>
          {archivedCount > 0 && <Toggle checked={filter.archived} onChange={v => setFilter({ ...filter, archived: v })}>Archived ({archivedCount})</Toggle>}
          <GhostButton type="button" onClick={() => setAdding(v => !v)} style={{ padding: '4px 12px' }} aria-expanded={adding}>
            <span className="inline-flex items-center gap-1"><Plus size={14} aria-hidden="true" />Game</span>
          </GhostButton>
        </div>
      )}>
      {adding && (
        <form onSubmit={add} className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3 items-end mb-4 p-4 rounded-xl" style={{ backgroundColor: 'rgba(30, 41, 59, 0.5)' }}>
          <Field label="Division">
            <Select value={form.division_id} onChange={e => setForm({ ...form, division_id: e.target.value, home_entry_id: '', away_entry_id: '' })} required>
              <option value="">—</option>
              {divisions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </Field>
          <Field label="Stage">
            <Select value={form.stage} onChange={e => setForm({ ...form, stage: e.target.value })}>
              <option value="">—</option>
              {GAME_STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </Select>
          </Field>
          <Field label="Home">
            <Select value={form.home_entry_id} onChange={e => setForm({ ...form, home_entry_id: e.target.value })} required>
              <option value="">—</option>
              {entriesIn(form.division_id).map(en => <option key={en.id} value={en.id}>{en.team_name}</option>)}
            </Select>
          </Field>
          <Field label="Away">
            <Select value={form.away_entry_id} onChange={e => setForm({ ...form, away_entry_id: e.target.value })} required>
              <option value="">—</option>
              {entriesIn(form.division_id).filter(en => en.id !== Number(form.home_entry_id)).map(en => <option key={en.id} value={en.id}>{en.team_name}</option>)}
            </Select>
          </Field>
          <Field label="Date"><TextInput type="date" value={form.game_date} onChange={e => setForm({ ...form, game_date: e.target.value })} required /></Field>
          <Field label="Time"><TextInput type="time" value={form.game_time} onChange={e => setForm({ ...form, game_time: e.target.value })} /></Field>
          <Field label="Field"><TextInput value={form.field} onChange={e => setForm({ ...form, field: e.target.value })} /></Field>
          <PrimaryButton type="submit">Add game</PrimaryButton>
        </form>
      )}

      {visible.length === 0 ? (
        <p className="text-sm" style={{ color: '#94a3b8' }}>{games.length ? 'No games match these filters.' : 'No games scheduled.'}</p>
      ) : (
        <div className="flex flex-col">
          {visible.map(g => (
            <div key={g.id} className="border-t py-1.5" style={{ borderColor: '#1e3a5f', opacity: g.archived_at ? 0.6 : 1 }} data-testid={`game-${g.id}`}>
              <GameRow key={`${g.home_score}-${g.away_score}`} game={g} onSave={saveScore} act={act} onAsk={onAsk}
                editing={editing === g.id} onEdit={() => setEditing(editing === g.id ? null : g.id)} />
              {editing === g.id && (
                <EditGame game={g} divisions={divisions} entries={entries} act={act} onDone={() => setEditing(null)} />
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function GameRow({ game, onSave, act, onAsk, editing, onEdit }) {
  const [home, setHome] = useState(fromNull(game.home_score));
  const [away, setAway] = useState(fromNull(game.away_score));
  const label = `${game.home_team_name} vs ${game.away_team_name}`;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="w-36 whitespace-nowrap" style={{ color: '#94a3b8' }}>{game.game_date}{game.game_time ? ` ${game.game_time}` : ''}</span>
      <Chip tone="accent">{game.division_name}</Chip>
      {game.stage_label && <Chip tone={stageTone(game.stage)} testId="stage">{game.stage_label}</Chip>}
      {game.division_mismatch && (
        <Tooltip content="Not in its teams’ division — edit the game or move a team.">
          <TriangleAlert size={15} style={{ color: '#fb923c' }} aria-label="Division mismatch" />
        </Tooltip>
      )}
      <span className="font-bold text-white flex-1 min-w-[180px]">
        {label}{game.field ? <span className="font-normal" style={{ color: '#64748b' }}> · {game.field}</span> : null}
      </span>
      <span className="flex items-center gap-1.5">
        <TextInput type="number" min="0" value={home} onChange={e => setHome(e.target.value)} style={{ width: 52, padding: '3px 6px' }} aria-label={`${game.home_team_name} score`} />
        <span style={{ color: '#64748b' }}>–</span>
        <TextInput type="number" min="0" value={away} onChange={e => setAway(e.target.value)} style={{ width: 52, padding: '3px 6px' }} aria-label={`${game.away_team_name} score`} />
      </span>
      <GhostButton type="button" onClick={() => onSave(game, home, away)} style={{ padding: '3px 10px', fontSize: 12 }}>Save</GhostButton>
      <span className="w-20 text-xs font-bold uppercase text-center" style={{ color: game.status === 'final' ? '#4ade80' : game.status === 'canceled' ? '#f87171' : '#64748b' }}>
        {game.archived_at ? 'archived' : game.status}
      </span>
      <IconButton icon={Pencil} label="Edit game" active={editing} onClick={onEdit} testId={`edit-game-${game.id}`} />
      {game.archived_at
        ? <IconButton icon={RotateCcw} label="Restore" onClick={() => act(() => api.restoreRecord('game', game.id), 'Game restored')} />
        : <IconButton icon={Archive} label="Archive" onClick={() => onAsk('game', game.id, 'archive')} />}
      <IconButton icon={Trash2} label="Delete game" tone="danger" onClick={() => onAsk('game', game.id, 'delete')} />
    </div>
  );
}

function EditGame({ game, divisions, entries, act, onDone }) {
  const [form, setForm] = useState({
    game_date: game.game_date, game_time: game.game_time || '', field: game.field || '', status: game.status,
    stage: game.stage || '', division_id: String(game.division_id),
    home_entry_id: String(game.home_entry_id), away_entry_id: String(game.away_entry_id),
    home_score: fromNull(game.home_score), away_score: fromNull(game.away_score),
  });
  const set = k => e => setForm({ ...form, [k]: e.target.value });
  // Any entry of the event, current teams first in their division; archived entries only if already in the game.
  const choices = entries.filter(e => e.status !== 'archived' || [game.home_entry_id, game.away_entry_id].includes(e.id));

  async function save(e) {
    e.preventDefault();
    const ok = await act(() => api.updateTournamentGame(game.id, {
      game_date: form.game_date, game_time: form.game_time, field: form.field, status: form.status,
      stage: form.stage || null, division_id: Number(form.division_id),
      home_entry_id: Number(form.home_entry_id), away_entry_id: Number(form.away_entry_id),
      home_score: numOrNull(form.home_score), away_score: numOrNull(form.away_score),
    }), 'Game saved');
    if (ok) onDone();
  }

  const entryOptions = exclude => divisions.map(d => {
    const rows = choices.filter(en => en.division_id === d.id && en.id !== Number(exclude));
    return rows.length ? (
      <optgroup key={d.id} label={d.name}>
        {rows.map(en => <option key={en.id} value={en.id}>{en.team_name}{en.status === 'withdrawn' ? ' (withdrawn)' : ''}</option>)}
      </optgroup>
    ) : null;
  });

  return (
    <Tray onSubmit={save}>
      <Field label="Date"><TextInput type="date" value={form.game_date} onChange={set('game_date')} required /></Field>
      <Field label="Time"><TextInput type="time" value={form.game_time} onChange={set('game_time')} /></Field>
      <Field label="Field"><TextInput value={form.field} onChange={set('field')} style={{ width: 120 }} /></Field>
      <Field label="Status">
        <Select value={form.status} onChange={set('status')}>
          {GAME_STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
        </Select>
      </Field>
      <Field label="Stage">
        <Select value={form.stage} onChange={set('stage')} data-testid="edit-stage">
          <option value="">—</option>
          {GAME_STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
        </Select>
      </Field>
      <Field label="Division">
        <Select value={form.division_id} onChange={set('division_id')} data-testid="edit-division">
          {divisions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
      </Field>
      <Field label="Home"><Select value={form.home_entry_id} onChange={set('home_entry_id')}>{entryOptions(form.away_entry_id)}</Select></Field>
      <Field label="Away"><Select value={form.away_entry_id} onChange={set('away_entry_id')}>{entryOptions(form.home_entry_id)}</Select></Field>
      <Field label="Score">
        <span className="flex items-center gap-1.5">
          <TextInput type="number" min="0" value={form.home_score} onChange={set('home_score')} style={{ width: 56 }} aria-label="Home score" />
          <span style={{ color: '#64748b' }}>–</span>
          <TextInput type="number" min="0" value={form.away_score} onChange={set('away_score')} style={{ width: 56 }} aria-label="Away score" />
        </span>
      </Field>
      <PrimaryButton type="submit">Save</PrimaryButton>
      <GhostButton type="button" onClick={onDone}>Cancel</GhostButton>
    </Tray>
  );
}
