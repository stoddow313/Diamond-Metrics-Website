// Divisions: add, rename / change age group, merge one into another (its
// games take a bracket stage), delete when empty.
import { useState } from 'react';
import { GitMerge, Pencil, Trash2 } from 'lucide-react';
import { api } from '../../../lib/api';
import { Field, TextInput, Select, PrimaryButton, GhostButton } from '../../../components/admin/ui';
import { InfoTip } from '../../../components/Tooltip';
import { GAME_STAGES, plural } from './options';
import { IconButton, Section, Tray } from './shared';

export default function DivisionsSection({ tournament, divisions, act, onAskDelete }) {
  const [form, setForm] = useState({ name: '', age_group: '' });
  const [open, setOpen] = useState(null);   // { id, mode: 'edit' | 'merge' }

  async function add(e) {
    e.preventDefault();
    if (await act(() => api.createDivision(tournament.id, form), `Added ${form.name}`)) setForm({ name: '', age_group: '' });
  }

  return (
    <Section title="Divisions" testId="divisions"
      aside={<InfoTip label="About divisions">Divisions are age groups (10U, 14U…). Gold, Silver and pool play are stages on each game, not divisions.</InfoTip>}>
      <form onSubmit={add} className="flex flex-wrap gap-3 items-end mb-4">
        <Field label="Name"><TextInput value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required placeholder="14U" /></Field>
        <Field label="Age group"><TextInput value={form.age_group} onChange={e => setForm({ ...form, age_group: e.target.value })} placeholder="14U" style={{ width: 110 }} /></Field>
        <PrimaryButton type="submit">Add division</PrimaryButton>
      </form>

      {divisions.length === 0 ? (
        <p className="text-sm" style={{ color: '#94a3b8' }}>No divisions yet.</p>
      ) : (
        <div className="flex flex-col">
          {divisions.map(d => (
            <div key={d.id} className="border-t py-2" style={{ borderColor: '#1e3a5f' }} data-testid={`division-${d.id}`}>
              <div className="flex items-center gap-3 text-sm">
                <span className="font-bold text-white min-w-[120px]">{d.name}</span>
                <span className="w-16" style={{ color: '#94a3b8' }}>{d.age_group || '—'}</span>
                <span className="flex-1 text-xs" style={{ color: '#64748b' }}>{plural(d.entry_count, 'team')} · {plural(d.game_count, 'game')}</span>
                <IconButton icon={Pencil} label={`Edit ${d.name}`} active={open?.id === d.id && open.mode === 'edit'}
                  onClick={() => setOpen(open?.id === d.id && open.mode === 'edit' ? null : { id: d.id, mode: 'edit' })} />
                <IconButton icon={GitMerge} label={`Merge ${d.name} into another division`} disabled={divisions.length < 2}
                  active={open?.id === d.id && open.mode === 'merge'}
                  onClick={() => setOpen(open?.id === d.id && open.mode === 'merge' ? null : { id: d.id, mode: 'merge' })} />
                <IconButton icon={Trash2} label={`Delete ${d.name}`} tone="danger" onClick={() => onAskDelete('division', d.id)} />
              </div>
              {open?.id === d.id && open.mode === 'edit' && (
                <EditDivision division={d} act={act} onDone={() => setOpen(null)} />
              )}
              {open?.id === d.id && open.mode === 'merge' && (
                <MergeDivision division={d} divisions={divisions} act={act} onDone={() => setOpen(null)} />
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function EditDivision({ division, act, onDone }) {
  const [form, setForm] = useState({ name: division.name, age_group: division.age_group || '' });
  async function save(e) {
    e.preventDefault();
    if (await act(() => api.updateDivision(division.id, form), 'Division saved')) onDone();
  }
  return (
    <Tray onSubmit={save}>
      <Field label="Name"><TextInput value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /></Field>
      <Field label="Age group"><TextInput value={form.age_group} onChange={e => setForm({ ...form, age_group: e.target.value })} style={{ width: 110 }} /></Field>
      <PrimaryButton type="submit">Save</PrimaryButton>
      <GhostButton type="button" onClick={onDone}>Cancel</GhostButton>
    </Tray>
  );
}

function MergeDivision({ division, divisions, act, onDone }) {
  const others = divisions.filter(d => d.id !== division.id);
  // 14U Gold → Gold, 14U Silver → Silver: the stage its games most likely had.
  const guess = GAME_STAGES.find(s => s.key !== 'pool' && division.name.toLowerCase().includes(s.label.toLowerCase().split(' ')[0]))?.key || '';
  const [into, setInto] = useState(others.find(d => d.age_group && d.age_group === division.age_group)?.id || '');
  const [stage, setStage] = useState(guess);
  async function merge(e) {
    e.preventDefault();
    const target = others.find(d => d.id === Number(into));
    const ok = await act(() => api.mergeDivision(division.id, { into_division_id: Number(into), stage: stage || null }),
      r => `Merged ${division.name} into ${target?.name}: ${plural(r.entries_moved, 'team')}, ${plural(r.games_moved, 'game')}`);
    if (ok) onDone();
  }
  return (
    <Tray onSubmit={merge}>
      <Field label="Into">
        <Select value={into} onChange={e => setInto(e.target.value)} required style={{ minWidth: 150 }}>
          <option value="">—</option>
          {others.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
      </Field>
      <Field label="Mark its games" hint="Sets this stage on the merged games that have none, so Gold and Silver games stay told apart.">
        <Select value={stage} onChange={e => setStage(e.target.value)} style={{ minWidth: 150 }}>
          <option value="">Leave as is</option>
          {GAME_STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
        </Select>
      </Field>
      <PrimaryButton type="submit" disabled={!into}>Merge</PrimaryButton>
      <GhostButton type="button" onClick={onDone}>Cancel</GhostButton>
      <InfoTip label="About merging">Moves every team and game into the chosen division, keeping entry IDs and event rosters, then removes {division.name}.</InfoTip>
    </Tray>
  );
}
