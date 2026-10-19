// Reviewing a scored game against the film: jump back to any half inning,
// fix a play's batter or result in place, put back a missed at-bat, put a
// pitching change or fielder move where it happened, restore a deleted play,
// and correct a lineup after play. Every change is audited and the whole game
// replays from it (server/scorebook.js).
import { useState } from 'react';
import { api } from '../../lib/api';
import { Field, TextInput, Select, PrimaryButton, GhostButton } from '../../components/admin/ui';
import { InfoTip } from '../../components/Tooltip';
import { LABELS, POSITIONS, playerChoices, refName, battingIn, halfLabel } from './scorebookVocab';

const baseList = bases => [1, 2, 3].filter(b => bases?.[b]).map(b => `${b}B ${bases[b].label || ''}`.trim());
const chip = active => (active
  ? { backgroundColor: '#38bdf8', color: '#06122b' }
  : { backgroundColor: 'rgba(30, 41, 59, 0.9)', color: '#94a3b8' });

// Half-inning chips: any half opens for review, the one being scored too;
// "Live" goes back to scoring while the game is on.
export function InningNav({ data, selected, onSelect }) {
  const halves = data.log.filter(l => l.type === 'half_inning');
  if (!halves.length) return null;
  const live = !data.state.final;
  return (
    <div className="flex flex-wrap items-center gap-1.5 mb-3" data-testid="inning-nav">
      <span className="text-[11px] font-bold uppercase tracking-widest mr-1" style={{ color: '#64748b' }}>Innings</span>
      {halves.map(h => (
        <button key={h.id} type="button" onClick={() => onSelect(selected === h.id && live ? null : h.id)} aria-pressed={selected === h.id}
          className="px-2 py-0.5 rounded text-xs font-bold tabular-nums cursor-pointer" style={chip(selected === h.id)}
          title={`Review ${h.half} ${h.inning}`}>
          {halfLabel(h.half, h.inning)}
        </button>
      ))}
      {live && (
        <button type="button" onClick={() => onSelect(null)} aria-pressed={!selected}
          className="px-2 py-0.5 rounded text-xs font-bold cursor-pointer" style={chip(!selected)} title="Score the half in progress">
          Live
        </button>
      )}
    </div>
  );
}

// The batter of a recorded at-bat: follow the batting order, or name who batted.
export function BatterField({ data, entry, payload, onChange }) {
  const side = entry?.batting || 'us';
  const choices = playerChoices(data, side);
  const value = payload.batter_player_id ? `p:${payload.batter_player_id}` : payload.batter_label ? `l:${payload.batter_label}` : '';
  const due = entry?.batter && !entry.batter.explicit ? ` — ${entry.batter.label || refName(entry.batter)}${entry.batter.slot ? `, slot ${entry.batter.slot}` : ''}` : '';
  return (
    <Field label="Batter" hint="Name who batted when the film shows someone else; later at-bats follow the batting order from that batter's slot.">
      <Select value={value} onChange={e => {
        const { batter_player_id: _a, batter_label: _b, out_of_order_ok: _c, ...rest } = payload;
        const c = choices.find(x => x.key === e.target.value);
        onChange(c ? { ...rest, ...(c.player_id ? { batter_player_id: c.player_id } : {}), batter_label: c.label, out_of_order_ok: true } : rest);
      }} data-testid="correct-batter">
        <option value="">Batting order{due}</option>
        {choices.map(c => <option key={c.key} value={c.key}>{c.text}</option>)}
      </Select>
    </Field>
  );
}

// Correct a recorded at-bat or runner play in place (the original is kept in the history).
export function CorrectionEditor({ data, editing, setEditing, vocab, busy, onSave }) {
  const ev = editing.event;
  const entry = data.log.find(l => l.id === ev.id);
  const set = patch => setEditing(e => ({ ...e, payload: { ...e.payload, ...patch } }));
  return (
    <div className="mt-2 p-3 rounded-xl border flex flex-col gap-2" style={{ borderColor: 'rgba(251, 191, 36, 0.4)' }} data-testid="correction-editor">
      <p className="text-xs font-bold" style={{ color: '#fbbf24' }}>Correct this {ev.event_type.replace(/_/g, ' ')} — the original stays in the history with your reason.</p>
      {ev.event_type === 'plate_appearance' && (
        <div className="grid grid-cols-2 gap-2">
          <BatterField data={data} entry={entry} payload={editing.payload} onChange={payload => setEditing(e => ({ ...e, payload }))} />
          <Field label="Result">
            <Select value={editing.payload.result} onChange={e => set({ result: e.target.value })}>{vocab.pa_results.map(r => <option key={r} value={r}>{LABELS[r]} · {r.replace(/_/g, ' ')}</option>)}</Select>
          </Field>
          <Field label="RBI (blank = auto)"><TextInput type="number" min="0" max="4" value={editing.payload.rbi ?? ''} onChange={e => set({ rbi: e.target.value === '' ? undefined : Number(e.target.value) })} /></Field>
          {editing.payload.result === 'reach_on_error' && <Field label="Error by (label)"><TextInput value={editing.payload.error_label || ''} onChange={e => set({ error_label: e.target.value })} /></Field>}
        </div>
      )}
      {ev.event_type === 'runner' && (
        <div className="grid grid-cols-3 gap-2">
          <Field label="To"><Select value={editing.payload.to} onChange={e => set({ to: Number(e.target.value) })}>{[1, 2, 3, 4].map(b => <option key={b} value={b}>{b === 4 ? 'home' : `${b}B`}</option>)}</Select></Field>
          <Field label="How"><Select value={editing.payload.how} onChange={e => set({ how: e.target.value })}>{vocab.runner_hows.map(h => <option key={h} value={h}>{h.replace(/_/g, ' ')}</option>)}</Select></Field>
          <Field label="Out"><Select value={editing.payload.out ? '1' : '0'} onChange={e => set({ out: e.target.value === '1' })}><option value="0">safe</option><option value="1">out</option></Select></Field>
        </div>
      )}
      <Field label="Reason (audit)"><TextInput value={editing.note} onChange={e => setEditing(x => ({ ...x, note: e.target.value }))} placeholder="film: #7 batted, not #4" /></Field>
      <div className="flex gap-2">
        <PrimaryButton onClick={onSave} disabled={busy || !editing.note.trim()}>Save correction</PrimaryButton>
        <GhostButton onClick={() => setEditing(null)}>Cancel</GhostButton>
      </div>
    </div>
  );
}

// Put back an at-bat missed while scoring: before a given play, or at the end
// of a past half. Runners on base at that moment can be moved with it.
function InsertAtBat({ data, jobId, run, before, half, onDone }) {
  const side = before?.batting || battingIn(half.half, data.state.us_is_home);
  const choices = playerChoices(data, side);
  const runnersOn = before ? [1, 2, 3].filter(b => before.bases_before?.[b]) : [];
  const [f, setF] = useState({ batter: '', result: 'single', rbi: '', moves: Object.fromEntries(runnersOn.map(b => [b, 'stay'])) });
  async function save() {
    const c = choices.find(x => x.key === f.batter);
    const pa = { result: f.result, ...(f.rbi !== '' ? { rbi: Number(f.rbi) } : {}), ...(c ? { ...(c.player_id ? { batter_player_id: c.player_id } : {}), batter_label: c.label, out_of_order_ok: true } : {}) };
    const runners = runnersOn.filter(b => f.moves[b] !== 'stay').map(b => {
      const ref = before.bases_before[b];
      const who = ref.player_id ? { runner_player_id: ref.player_id } : { runner_label: ref.label };
      return f.moves[b] === 'out' ? { ...who, from: b, to: b, how: 'out', out: true } : { ...who, from: b, to: Number(f.moves[b]), how: 'advance' };
    });
    const body = before ? { before_event_id: before.id, pa, runners } : { half_event_id: half.id, pa, runners };
    const d = await run(() => api.commandScorebookInsert(jobId, body), 'At-bat put back — the batting order behind it moved down one');
    if (d) onDone();
  }
  return (
    <div className="mt-2 p-3 rounded-xl border flex flex-col gap-2" style={{ borderColor: 'rgba(56, 189, 248, 0.4)' }} data-testid="insert-at-bat">
      <p className="text-xs font-bold" style={{ color: '#38bdf8' }}>Missed at-bat {before ? 'before this play' : `at the end of ${half.half} ${half.inning}`}</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Field label="Batter">
          <Select value={f.batter} onChange={e => setF(x => ({ ...x, batter: e.target.value }))}>
            <option value="">Batting order{before?.batter ? ` — ${before.batter.label || refName(before.batter)}` : ''}</option>
            {choices.map(c => <option key={c.key} value={c.key}>{c.text}</option>)}
          </Select>
        </Field>
        <Field label="Result">
          <Select value={f.result} onChange={e => setF(x => ({ ...x, result: e.target.value }))}>{data.vocab.pa_results.map(r => <option key={r} value={r}>{LABELS[r]} · {r.replace(/_/g, ' ')}</option>)}</Select>
        </Field>
        <Field label="RBI (blank = auto)"><TextInput type="number" min="0" max="4" value={f.rbi} onChange={e => setF(x => ({ ...x, rbi: e.target.value }))} /></Field>
        {runnersOn.map(b => (
          <Field key={b} label={`Runner on ${b}B · ${before.bases_before[b].label || 'runner'}`}>
            <Select value={f.moves[b]} onChange={e => setF(x => ({ ...x, moves: { ...x.moves, [b]: e.target.value } }))}>
              <option value="stay">stays</option>
              {[2, 3, 4].filter(t => t > b).map(t => <option key={t} value={t}>{t === 4 ? 'scores' : `to ${t}B`}</option>)}
              <option value="out">out</option>
            </Select>
          </Field>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <PrimaryButton onClick={save}>Put back</PrimaryButton>
        <GhostButton onClick={onDone}>Cancel</GhostButton>
        <InfoTip label="About putting back an at-bat">At-bats that follow the batting order after this one move down to the next batter, as on the film. Plays with a named batter stay with that batter. Check the half's outs after — the next half is not moved.</InfoTip>
      </div>
    </div>
  );
}

const KIND_LABELS = { pitching_change: 'Pitching change', defensive: 'Defensive substitution', position_change: 'Position change', pinch_hitter: 'Pinch hitter', pinch_runner: 'Pinch runner', courtesy_runner: 'Courtesy runner', re_entry: 'Re-entry' };
const DEFENSIVE_KINDS = ['pitching_change', 'defensive', 'position_change'];

// A pitching change or fielder move put where it happened — new, or an
// existing substitution moved or corrected. Every play after it replays with
// that defense: pitching lines, putouts and assists, positions by inning.
function DefensiveChange({ data, jobId, run, half, plays, existing, onDone }) {
  const ev = existing ? data.events.find(e => e.id === existing.id) : null;
  const fielding = battingIn(half.half, data.state.us_is_home) === 'us' ? 'them' : 'us';
  const [p, setP] = useState(() => (ev ? { ...ev.payload } : { kind: 'pitching_change', side: fielding }));
  const [when, setWhen] = useState(ev ? '' : `start:${half.id}`);
  const [note, setNote] = useState('');
  const choices = playerChoices(data, p.side);
  const typed = p.side === 'them' && !(data.partner_roster || []).length;
  const slots = data.state.lineups[p.side]?.slots || [];
  const halves = data.log.filter(l => l.type === 'half_inning');
  const kinds = ev && !DEFENSIVE_KINDS.includes(ev.payload.kind) ? [ev.payload.kind] : DEFENSIVE_KINDS;
  const set = patch => setP(x => ({ ...x, ...patch }));
  const needsPlayer = p.kind !== 'position_change';
  const needsSlot = ['defensive', 'position_change', 'pinch_hitter', 're_entry'].includes(p.kind);
  const needsPosition = ['defensive', 'position_change'].includes(p.kind);
  const playerKey = p.player_in_id ? `p:${p.player_in_id}` : p.player_in_label ? `l:${p.player_in_label}` : '';
  const teamName = side => (side === 'us' ? 'Us' : (data.partner?.team_name || data.job.opponent_label || 'Them'));
  const ready = note.trim() && (!needsPlayer || p.player_in_id || p.player_in_label?.trim()) && (!needsSlot || p.slot) && (p.kind !== 'position_change' || p.position);
  // Who had the position in this half: taking it leaves them without one.
  const moving = slots.find(x => x.slot === Number(p.slot))?.current;
  const holder = needsPosition && p.position && p.side === half.defense?.side ? half.defense.positions.find(x => x.position === p.position) : null;
  const displaced = holder && !(moving && (holder.player_id ? holder.player_id === moving.player_id : holder.label === moving.label)) ? holder : null;
  async function save() {
    const { player_in_id, player_in_label, slot, position, ...rest } = p;
    const payload = { ...rest,
      ...(needsPlayer ? { ...(player_in_id ? { player_in_id } : {}), player_in_label: (player_in_label || '').trim() } : {}),
      ...(needsSlot || (p.kind === 'pitching_change' && slot) ? { slot: Number(slot) } : {}),
      ...(needsPosition && position ? { position } : {}) };
    const [k, id] = when.split(':');
    const body = { payload, note: note.trim(), ...(ev ? { event_id: ev.id } : {}), ...(k === 'start' ? { half_event_id: Number(id) } : k === 'before' ? { before_event_id: Number(id) } : {}) };
    const d = await run(() => api.commandScorebookDefensiveChange(jobId, body), `${KIND_LABELS[p.kind]} ${ev ? 'corrected' : 'placed'} — the game replayed from it`);
    if (d) onDone();
  }
  return (
    <div className="mt-2 p-3 rounded-xl border flex flex-col gap-2" style={{ borderColor: 'rgba(56, 189, 248, 0.4)' }} data-testid="defensive-change">
      <p className="text-xs font-bold" style={{ color: '#38bdf8' }}>{ev ? 'Correct or move this change' : 'Defensive change'} — the plays after it replay with this defense</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Field label="Change">
          <Select value={p.kind} onChange={e => set({ kind: e.target.value })} data-testid="defense-kind">{kinds.map(k => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}</Select>
        </Field>
        <Field label="Team">
          <Select value={p.side} onChange={e => setP(x => ({ kind: x.kind, side: e.target.value }))}>{['us', 'them'].map(sd => <option key={sd} value={sd}>{teamName(sd)}{sd === fielding ? ' · in the field' : ''}</option>)}</Select>
        </Field>
        {needsPlayer && (
          <Field label={p.kind === 'pitching_change' ? 'New pitcher' : 'Player in'}>
            {typed ? (
              <TextInput value={p.player_in_label || ''} onChange={e => set({ player_in_id: undefined, player_in_label: e.target.value })} placeholder="#12" list={`defense-labels-${p.side}`} />
            ) : (
              <Select value={playerKey} onChange={e => { const c = choices.find(x => x.key === e.target.value); set({ player_in_id: c?.player_id || undefined, player_in_label: c?.label || '' }); }} data-testid="defense-player">
                <option value="">—</option>
                {choices.map(c => <option key={c.key} value={c.key}>{c.text}</option>)}
              </Select>
            )}
            {typed && <datalist id={`defense-labels-${p.side}`}>{choices.map(c => <option key={c.key} value={c.label} />)}</datalist>}
          </Field>
        )}
        {needsSlot && (
          <Field label={p.kind === 'position_change' ? 'Who moves (slot)' : 'Replaces (slot)'}>
            <Select value={p.slot ?? ''} onChange={e => set({ slot: e.target.value ? Number(e.target.value) : undefined })} data-testid="defense-slot">
              <option value="">—</option>
              {slots.map(sl => <option key={sl.slot} value={sl.slot}>{sl.slot}. {refName(sl.current)}</option>)}
            </Select>
          </Field>
        )}
        {needsPosition && (
          <Field label="To position">
            <Select value={p.position || ''} onChange={e => set({ position: e.target.value })} data-testid="defense-position">
              <option value="">{p.kind === 'defensive' ? 'same' : '—'}</option>{POSITIONS.map(x => <option key={x} value={x}>{x}</option>)}
            </Select>
          </Field>
        )}
        <Field label="When">
          <Select value={when} onChange={e => setWhen(e.target.value)} data-testid="defense-when">
            {ev && <option value="">Where it is now</option>}
            <optgroup label="Start of a half inning">
              {halves.map(h => <option key={h.id} value={`start:${h.id}`}>Start of {halfLabel(h.half, h.inning)}</option>)}
            </optgroup>
            <optgroup label={`Before a play in ${halfLabel(half.half, half.inning)}`}>
              {plays.filter(l => l.id !== ev?.id).map(l => <option key={l.id} value={`before:${l.id}`}>Before {l.batter?.slot ? `${l.batter.slot}. ` : ''}{l.text}</option>)}
            </optgroup>
          </Select>
        </Field>
      </div>
      {displaced && <p className="text-xs" style={{ color: '#fbbf24' }} data-testid="defense-displaced">{displaced.label || 'The player'} plays {p.position} in this half — add a change for their new position too.</p>}
      <Field label="Reason (audit)"><TextInput value={note} onChange={e => setNote(e.target.value)} placeholder="GameChanger: new pitcher started the 7th" /></Field>
      <div className="flex items-center gap-2">
        <PrimaryButton onClick={save} disabled={!ready} data-testid="defense-save">{ev ? 'Save change' : 'Place change'}</PrimaryButton>
        <GhostButton onClick={onDone}>Cancel</GhostButton>
        <InfoTip label="About defensive changes">The change holds from where you place it until the next change: the pitcher of record for every pitch and out after it, and who is credited at each position. A change moved here no longer applies where it was.</InfoTip>
      </div>
    </div>
  );
}

const defenseLine = d => (d?.positions || []).map(x => `${x.position} ${x.label || (x.player_id ? `#${x.player_id}` : '?')}`).join(' · ');

// One half: its plays with the state before each, and their repairs.
export function InningReview({ data, jobId, halfId, run, busy, editing, setEditing, onClose }) {
  const half = data.log.find(l => l.id === halfId);
  const [inserting, setInserting] = useState(null);   // play id, or 'end'
  const [defense, setDefense] = useState(null);       // 'new', or the substitution's id
  if (!half) return null;
  const plays = data.log.filter(l => l.inning === half.inning && l.half === half.half && !l.child && l.type !== 'half_inning');
  const voided = (data.voided || []).filter(v => v.inning === half.inning && v.half === half.half);
  const isLast = data.log.filter(l => l.type === 'half_inning').at(-1)?.id === half.id;
  const pitchers = [...new Map(plays.filter(l => l.pitcher).map(l => [l.pitcher.player_id ?? l.pitcher.label, l.pitcher])).values()];
  return (
    <section className="rounded-2xl border p-4 mb-3" style={{ backgroundColor: 'rgba(15, 23, 42, 0.78)', borderColor: '#38bdf8' }} data-testid="inning-review">
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-sm font-bold text-white">{half.half === 'top' ? 'Top' : 'Bottom'} {half.inning} <span className="font-normal text-xs" style={{ color: '#94a3b8' }}>· {battingIn(half.half, data.state.us_is_home) === 'us' ? 'we batted' : 'they batted'}</span>
          {pitchers.length > 0 && <span className="font-normal text-xs" style={{ color: '#cfe8ff' }} data-testid="half-pitchers"> · pitching {pitchers.map(x => x.label || `#${x.player_id}`).join(' → ')}</span>}
          {half.defense && <InfoTip label="Defense this half">{defenseLine(half.defense)}</InfoTip>}
        </p>
        <GhostButton onClick={onClose} style={{ padding: '2px 10px', fontSize: 12 }}>{data.state.final ? 'Close' : `Back to ${isLast ? 'scoring' : 'the current inning'}`}</GhostButton>
      </div>
      {plays.length === 0 && <p className="text-xs" style={{ color: '#64748b' }}>No plays recorded in this half.</p>}
      {plays.map(l => {
        const ev = data.events.find(e => e.id === l.id);
        return (
          <div key={l.id} className="border-t py-1.5" style={{ borderColor: '#1e3a5f' }}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-[11px] tabular-nums w-24" style={{ color: '#64748b' }}>{l.outs_before} out{l.outs_before === 1 ? '' : 's'}{baseList(l.bases_before).length ? ` · ${baseList(l.bases_before).map(x => x.split(' ')[0]).join(',')}` : ''}</span>
              <span className="flex-1 min-w-[200px]" style={{ color: '#cfe8ff' }}>
                {l.batter?.slot ? <span className="text-xs mr-1" style={{ color: '#64748b' }}>{l.batter.slot}.</span> : null}{l.text}
              </span>
              {['plate_appearance', 'runner'].includes(l.type) && ev && <GhostButton style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => setEditing({ event: ev, payload: { ...ev.payload }, note: '' })}>Correct</GhostButton>}
              {['plate_appearance', 'runner'].includes(l.type) && <GhostButton style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => setInserting(inserting === l.id ? null : l.id)} data-testid={`insert-before-${l.id}`}>Insert before</GhostButton>}
              {l.type === 'substitution' && <GhostButton style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => setDefense(defense === l.id ? null : l.id)} data-testid={`edit-change-${l.id}`}>Correct / move</GhostButton>}
              <GhostButton style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => run(() => api.commandScorebookVoid(l.id, 'removed during review', jobId), 'Removed — it can be restored below')}>Void</GhostButton>
            </div>
            {editing?.event.id === l.id && (
              <CorrectionEditor data={data} editing={editing} setEditing={setEditing} vocab={data.vocab} busy={busy}
                onSave={async () => { const d = await run(() => api.commandScorebookCorrect(editing.event.id, editing.payload, editing.note, jobId), 'Corrected — the game replayed from it'); if (d) setEditing(null); }} />
            )}
            {inserting === l.id && <InsertAtBat data={data} jobId={jobId} run={run} before={l} half={half} onDone={() => setInserting(null)} />}
            {defense === l.id && <DefensiveChange data={data} jobId={jobId} run={run} half={half} plays={plays} existing={l} onDone={() => setDefense(null)} />}
          </div>
        );
      })}
      <div className="border-t pt-2 mt-1 flex flex-wrap gap-1.5" style={{ borderColor: '#1e3a5f' }}>
        {!isLast && inserting !== 'end' && <GhostButton style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => setInserting('end')}>+ Missed at-bat at the end of this half</GhostButton>}
        {defense !== 'new' && <GhostButton style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => setDefense('new')} data-testid="add-defensive-change">+ Defensive change</GhostButton>}
      </div>
      {inserting === 'end' && <InsertAtBat data={data} jobId={jobId} run={run} half={half} onDone={() => setInserting(null)} />}
      {defense === 'new' && <DefensiveChange data={data} jobId={jobId} run={run} half={half} plays={plays} onDone={() => setDefense(null)} />}
      <VoidedPlays data={{ ...data, voided }} jobId={jobId} run={run} title="Removed from this half" />
    </section>
  );
}

// Deleted (voided) plays, each restorable with the pitches and runner plays voided with it.
export function VoidedPlays({ data, jobId, run, title = 'Removed plays' }) {
  if (!data.voided?.length) return null;
  return (
    <div className="mt-3" data-testid="voided-plays">
      <p className="text-[11px] font-bold uppercase tracking-widest mb-1" style={{ color: '#94a3b8' }}>{title}</p>
      {data.voided.map(v => (
        <div key={v.id} className="flex flex-wrap items-center gap-2 text-sm py-1" style={{ color: '#64748b' }}>
          <span className="w-10 text-xs tabular-nums">{v.half ? halfLabel(v.half, v.inning) : ''}</span>
          <span className="flex-1 min-w-[200px]"><span className="line-through decoration-slate-500">{v.text}</span>{v.event_type === 'plate_appearance' && <span className="text-xs"> · {v.after ? `after ${v.after}` : 'leadoff'}</span>}</span>
          <span className="text-xs">{v.voided_by ? `${v.voided_by} · ` : ''}{String(v.voided_at || '').slice(0, 16)}</span>
          <GhostButton style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => run(() => api.commandScorebookRestore(v.id, '', jobId), 'Restored — the game replayed with it')} data-testid={`restore-${v.id}`}>Restore</GhostButton>
        </div>
      ))}
    </div>
  );
}

// Correct a lineup after play: who bats in each slot, positions, slots added
// or removed. The whole game replays from it, so at-bats that follow the
// order re-align to the corrected lineup.
export function LineupEditor({ data, jobId, side, run, onDone }) {
  const lineup = data.events.filter(e => e.event_type === 'lineup' && e.payload?.side === side).at(-1);
  const choices = playerChoices(data, side);
  const typed = side === 'them' && !(data.partner_roster || []).length;
  const [rows, setRows] = useState(() => (lineup?.payload.slots || []).map(s => ({ ...s, key: s.player_id ? `p:${s.player_id}` : `l:${s.label}`, was: s.slot })));
  const [note, setNote] = useState('');
  if (!lineup) return null;
  const move = (i, d) => setRows(r => { const n = [...r]; [n[i], n[i + d]] = [n[i + d], n[i]]; return n; });
  const moved = rows.map((r, i) => ({ ...r, now: i + 1 })).filter(r => r.was && r.was !== r.now).map(r => r.was);
  const subsOnMoved = data.events.filter(e => e.event_type === 'substitution' && e.payload.side === side && moved.includes(e.payload.slot)).length;
  async function save() {
    const slots = rows.filter(r => r.player_id || r.label?.trim()).map((r, i) => ({ slot: i + 1, ...(r.player_id ? { player_id: r.player_id } : {}), label: (r.label || '').trim(), position: r.position || '' }));
    const d = await run(() => api.commandScorebookCorrect(lineup.id, { ...lineup.payload, slots }, note.trim(), jobId), 'Lineup corrected — every at-bat re-aligned');
    if (d) onDone();
  }
  return (
    <div className="mt-2 p-3 rounded-xl border flex flex-col gap-1.5" style={{ borderColor: 'rgba(251, 191, 36, 0.4)' }} data-testid={`lineup-editor-${side}`}>
      <p className="text-xs font-bold mb-1" style={{ color: '#fbbf24' }}>Edit {side === 'us' ? 'our' : 'their'} lineup — the game replays from it; the original stays in the history.</p>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="w-5 text-xs tabular-nums" style={{ color: '#64748b' }}>{i + 1}</span>
          {typed ? (
            <TextInput value={r.label || ''} onChange={e => setRows(x => x.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} placeholder={`#${i + 1}`} aria-label={`Slot ${i + 1}`} />
          ) : (
            <Select value={r.key || ''} aria-label={`Slot ${i + 1}`} onChange={e => { const c = choices.find(x => x.key === e.target.value); setRows(x => x.map((y, j) => (j === i ? { ...y, key: e.target.value, player_id: c?.player_id || null, label: c?.label || '' } : y))); }}>
              <option value="">—</option>
              {choices.map(c => <option key={c.key} value={c.key}>{c.text}</option>)}
            </Select>
          )}
          <Select value={r.position || ''} onChange={e => setRows(x => x.map((y, j) => (j === i ? { ...y, position: e.target.value } : y)))} aria-label={`Slot ${i + 1} position`} style={{ width: 80 }}>
            <option value="">pos</option>{POSITIONS.map(p => <option key={p} value={p}>{p}</option>)}
          </Select>
          <GhostButton style={{ padding: '2px 8px' }} disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</GhostButton>
          <GhostButton style={{ padding: '2px 8px' }} disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</GhostButton>
          <GhostButton style={{ padding: '2px 8px' }} onClick={() => setRows(x => x.filter((_, j) => j !== i))} aria-label={`Remove slot ${i + 1}`}>×</GhostButton>
        </div>
      ))}
      <div><GhostButton style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => setRows(x => [...x, { key: '', player_id: null, label: '', position: '', was: null }])}>+ slot</GhostButton></div>
      {subsOnMoved > 0 && <p className="text-xs" style={{ color: '#fbbf24' }}>{subsOnMoved} substitution{subsOnMoved === 1 ? ' refers' : 's refer'} to a slot that moved — check {subsOnMoved === 1 ? 'it' : 'them'} in the play-by-play after saving.</p>}
      <Field label="Reason (audit)"><TextInput value={note} onChange={e => setNote(e.target.value)} placeholder="film: #22 batted 5th, missing from the lineup" /></Field>
      <div className="flex gap-2">
        <PrimaryButton onClick={save} disabled={!note.trim()}>Save lineup</PrimaryButton>
        <GhostButton onClick={onDone}>Cancel</GhostButton>
      </div>
    </div>
  );
}
