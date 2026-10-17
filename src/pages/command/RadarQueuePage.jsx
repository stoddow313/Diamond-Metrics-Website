import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { Field, TextInput, Select, PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import { cardStyle } from '../../components/admin/theme';

// Radar queue (Command M3): import every CSV row, classify pitch vs exit,
// confirm player matches, invalidate noise, or leave rows unmatched. A
// confirmed reading immediately becomes a draft radar-verified result and
// the per-player rollup preview updates live (TDR §5a). Radar results can
// publish without video.

const STATUS_COLORS = { unmatched: '#fbbf24', matched: '#4ade80', invalid: '#64748b' };

// Quick-pick reasons for invalidating a reading. Free text can replace or
// extend them; whichever is chosen is what the audit trail records.
const INVALID_REASONS = ['Radar noise', 'Wrong pitcher / player', 'Duplicate reading', 'Warm-up, not game', 'Unreadable', 'Test reading'];

// Our roster, then the paired job's (the other team's pitchers in the same CSV).
function RosterOptions({ data, label }) {
  if (!data.partner_roster?.length) return data.roster.map(p => <option key={p.id} value={p.id}>{label(p)}</option>);
  return (
    <>
      <optgroup label="This team">{data.roster.map(p => <option key={p.id} value={p.id}>{label(p)}</option>)}</optgroup>
      <optgroup label={`${data.partner.team_name} (job #${data.partner.job_id})`}>{data.partner_roster.map(p => <option key={p.id} value={p.id}>{label(p)}</option>)}</optgroup>
    </>
  );
}

function ReadingStatus({ value }) {
  return (
    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded whitespace-nowrap"
      style={{ backgroundColor: 'rgba(30, 41, 59, 0.9)', color: STATUS_COLORS[value] || '#94a3b8' }}>
      {value}
    </span>
  );
}

export default function RadarQueuePage() {
  const { jobId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('unmatched');
  // Sticky context (roadmap §4.1): last confirmed player + classification
  // carry forward until changed — most readings in a row belong to the
  // same pitcher.
  const [sticky, setSticky] = useState({ player_id: '', pitch_or_exit: 'pitch', pitch_type: 'unknown' });
  const [manual, setManual] = useState({ velocity: '', context: '', note: '' });
  const [busyId, setBusyId] = useState(null);        // row with an action in flight
  const [invalidating, setInvalidating] = useState(null);  // { id, reason, detail } — reason panel under the row
  const [notice, setNotice] = useState('');
  const [guest, setGuest] = useState(null);   // { first_name, last_name, jersey } — inline guest placeholder form
  const [selected, setSelected] = useState(() => new Set());   // reading ids for a bulk assignment
  const [anchor, setAnchor] = useState(null);                  // last clicked row, for shift-click ranges
  const [pauseS, setPauseS] = useState(90);                     // a gap this long starts a new group (half inning, pitching change)
  const [bulk, setBulk] = useState({ player_id: '', pitch_or_exit: 'pitch', pitch_type: '' });
  const [bulkBusy, setBulkBusy] = useState(false);
  const fileRef = useRef(null);

  const rosterLabel = p => `${p.jersey ? `#${p.jersey} ` : ''}${p.first_name} ${p.last_name}${p.is_guest ? ' · guest' : p.primary_position ? ` (${p.primary_position})` : ''}`;

  async function addGuest(e) {
    e?.preventDefault();
    setError(''); setNotice('');
    try {
      const { player } = await api.commandAddGuest(jobId, guest);
      setGuest(null);
      await load();
      setSticky(s => ({ ...s, player_id: String(player.id) }));
      setNotice(`${player.first_name} ${player.last_name} added as a guest placeholder — reassign to the identified player later; no public profile is created.`);
    } catch (err) {
      setError(`Could not add the guest: ${err.message}`);
    }
  }

  const load = () => api.commandRadarQueue(jobId).then(setData).catch(err => setError(err.message));

  // A reading that lands outside the active bucket is invisible, which reads
  // as "nothing happened" even though the save succeeded. Follow it.
  const revealBucket = (status) => setFilter(f => (f === 'all' || f === status ? f : status));
  useEffect(() => {
    api.commandRadarQueue(jobId).then(setData).catch(err => setError(err.message));
  }, [jobId]);

  const visible = useMemo(() => {
    if (!data) return [];
    if (filter === 'all') return data.readings;
    return data.readings.filter(r => r.status === filter);
  }, [data, filter]);

  // Readings in a row, split where the gun went quiet: a half inning or a
  // pitching change usually shows as a pause, so a group is one pitcher's run.
  const groups = useMemo(() => {
    const at = r => { const t = Date.parse(r.source_timestamp || ''); return Number.isFinite(t) ? t : null; };
    const out = [];
    let prev = null;
    for (const r of visible) {
      const t = at(r);
      if (!out.length || (t != null && prev != null && (t - prev) / 1000 > pauseS)) out.push({ start: r.id, ids: [], first: r.source_timestamp, last: r.source_timestamp });
      const g = out[out.length - 1];
      g.ids.push(r.id);
      if (r.source_timestamp) g.last = r.source_timestamp;
      if (t != null) prev = t;
    }
    return out.length > 1 ? out : [];
  }, [visible, pauseS]);
  const groupAt = useMemo(() => new Map(groups.map((g, i) => [g.start, { ...g, n: i + 1 }])), [groups]);

  const partnerIds = useMemo(() => new Set((data?.partner_roster || []).map(p => p.id)), [data]);
  const toggle = (id, shift) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (shift && anchor != null) {
        const ids = visible.map(r => r.id);
        const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y);
        if (a >= 0) for (const x of ids.slice(a, b + 1)) next.add(x);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAnchor(id);
  };
  const selectIds = ids => setSelected(prev => new Set([...prev, ...ids]));

  async function assignSelected(status) {
    setError(''); setNotice(''); setBulkBusy(true);
    try {
      const body = { reading_ids: [...selected], status };
      if (status === 'matched') Object.assign(body, { player_id: Number(bulk.player_id), pitch_or_exit: bulk.pitch_or_exit, ...(bulk.pitch_type ? { pitch_type: bulk.pitch_type } : {}) });
      const r = await api.commandAssignReadings(jobId, body);
      const who = status === 'matched' ? [...data.roster, ...(data.partner_roster || [])].find(p => p.id === Number(bulk.player_id)) : null;
      setSelected(new Set());
      await load();
      setNotice(status === 'matched'
        ? `${r.assigned} reading${r.assigned === 1 ? '' : 's'} confirmed to ${who ? `${who.first_name} ${who.last_name}` : 'the player'}${r.moved ? ` — moved to the ${data.partner?.team_name || 'other team'} job (#${r.job_id}) for review there` : ''}.`
        : `${r.assigned} reading${r.assigned === 1 ? '' : 's'} marked ${status}.`);
    } catch (err) {
      setError(`Could not update those readings: ${err.message}`);
    } finally {
      setBulkBusy(false);
    }
  }

  async function importCsv(file) {
    if (!file) return;
    setError('');
    try {
      const content = await file.text();
      const result = await api.commandRadarImport(jobId, file.name, content);
      if (result.duplicate) setError('This file was already imported — no duplicate readings created.');
      await load();
    } catch (err) {
      setError(`Import failed: ${err.message}`);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function confirmReading(reading, overrides = {}) {
    setError(''); setNotice(''); setBusyId(reading.id);
    try {
      const next = { status: 'matched', ...overrides };
      const fields = { player_id: sticky.player_id ? Number(sticky.player_id) : null, pitch_or_exit: sticky.pitch_or_exit, pitch_type: sticky.pitch_type, ...next };
      if (fields.status === 'matched' && partnerIds.has(Number(fields.player_id))) {
        await api.commandAssignReadings(jobId, { reading_ids: [reading.id], ...fields });
      } else {
        await api.commandClassifyReading(reading.id, fields);
      }
      await load();
      revealBucket(next.status);
      setNotice(next.status === 'matched'
        ? `${reading.velocity} mph confirmed${reading.status === 'invalid' ? ' — restored to its prior assignment; the same result and its rollups are back' : ' — result and rollup updated'}.`
        : `Reading restored to ${next.status}.`);
    } catch (err) {
      setError(`Could not update that reading: ${err.message}`);
    } finally {
      setBusyId(null);
    }
  }

  // Invalid takes a reason inline. A native prompt() returns null whenever the
  // browser or an extension suppresses it, which silently aborted the action
  // with neither success nor error — the reported "hang".
  const invalidReason = v => [v?.reason, v?.detail?.trim()].filter(Boolean).join(' — ');

  async function submitInvalid() {
    const { id } = invalidating;
    const note = invalidReason(invalidating);   // optional — who/when is always audited
    const reading = data.readings.find(r => r.id === id);
    setError(''); setNotice(''); setBusyId(id);
    try {
      await api.commandClassifyReading(id, { status: 'invalid', note });
      setInvalidating(null);
      await load();
      revealBucket('invalid');
      setNotice(`${reading?.velocity ?? ''} mph marked invalid — kept on the record, excluded from every rollup.`);
    } catch (err) {
      setError(`Could not mark that reading invalid: ${err.message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function addManual(e) {
    e.preventDefault();
    setError('');
    try {
      await api.commandManualReading(jobId, {
        player_id: sticky.player_id ? Number(sticky.player_id) : null,
        velocity: Number(manual.velocity),
        pitch_or_exit: sticky.pitch_or_exit,
        pitch_type: sticky.pitch_type,
        context: manual.context,
        note: manual.note,
      });
      const v = manual.velocity;
      setManual({ velocity: '', context: '', note: '' });
      await load();
      const landed = sticky.player_id ? 'matched' : 'unmatched';
      revealBucket(landed);
      setNotice(`${v} mph added${sticky.player_id ? ' and matched — rollup updated.' : ' as unmatched — confirm it to a player to include it in the rollup.'}`);
    } catch (err) {
      setError(`Could not add that reading: ${err.message}`);
    }
  }

  if (!data) return <p style={{ color: '#94a3b8' }}>{error || 'Loading radar queue…'}</p>;

  const counts = {
    all: data.readings.length,
    unmatched: data.readings.filter(r => r.status === 'unmatched').length,
    matched: data.readings.filter(r => r.status === 'matched').length,
    invalid: data.readings.filter(r => r.status === 'invalid').length,
  };

  return (
    <div>
      <Link to={`/command/jobs/${jobId}`} className="text-xs hover:underline" style={{ color: '#64748b' }}>← Job</Link>
      <div className="flex items-center justify-between gap-3 mt-1 mb-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Radar queue</h1>
          <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>
            Every reading stays on the record — confirm matches, flag noise as invalid, leave uncertain rows unmatched. Confirmed readings become draft radar-verified results instantly.
          </p>
        </div>
        <label className="px-4 py-2 rounded-lg text-sm font-bold cursor-pointer" style={{ backgroundColor: '#38bdf8', color: '#06122b' }}>
          + Import Pocket Radar CSV
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={e => importCsv(e.target.files?.[0])} />
        </label>
      </div>

      {data.imports?.length > 0 && (
        <p className="text-xs mb-4" style={{ color: '#64748b' }} data-testid="radar-imports">
          Imported files: {data.imports.map(i => `${i.filename} — ${i.row_count} rows${i.created_by_name ? `, ${i.created_by_name}` : ''}, ${i.created_at.slice(0, 16)} UTC`).join(' · ')}.
          Source rows are immutable; confirmations are recorded separately in the audit trail.
        </p>
      )}

      <ErrorNote>{error}</ErrorNote>
      {notice && (
        <p className="text-sm mb-4 px-4 py-2.5 rounded-xl border" style={{ borderColor: 'rgba(74, 222, 128, 0.35)', backgroundColor: 'rgba(74, 222, 128, 0.08)', color: '#4ade80' }}>
          {notice}
        </p>
      )}

      {/* sticky context + manual entry */}
      <section className="rounded-2xl border p-5 mb-5" style={cardStyle}>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 items-end">
          <Field label="Active player (carries forward)">
            <Select value={sticky.player_id} onChange={e => setSticky(s => ({ ...s, player_id: e.target.value }))}>
              <option value="">— none —</option>
              <RosterOptions data={data} label={rosterLabel} />
            </Select>
            <button type="button" onClick={() => setGuest(g => (g ? null : { first_name: '', last_name: '', jersey: '' }))}
              className="text-[11px] font-bold mt-1 cursor-pointer hover:underline" style={{ color: '#fbbf24' }} data-testid="add-guest-toggle">
              {guest ? 'cancel guest' : '+ guest / unknown player'}
            </button>
          </Field>
          <Field label="Reading type">
            <Select value={sticky.pitch_or_exit} onChange={e => setSticky(s => ({ ...s, pitch_or_exit: e.target.value }))}>
              <option value="pitch">Pitch velocity</option>
              <option value="exit">Exit velocity</option>
              <option value="unknown">Unknown</option>
            </Select>
          </Field>
          <Field label="Pitch type">
            <Select value={sticky.pitch_type} onChange={e => setSticky(s => ({ ...s, pitch_type: e.target.value }))}>
              {data.pitch_types.map(t => <option key={t} value={t}>{t}</option>)}
            </Select>
          </Field>
          <Field label="Manual velocity (mph)">
            <TextInput type="number" step="0.1" value={manual.velocity} onChange={e => setManual(m => ({ ...m, velocity: e.target.value }))} placeholder="71.4" />
          </Field>
          <Field label="Context">
            <TextInput value={manual.context} onChange={e => setManual(m => ({ ...m, context: e.target.value }))} placeholder="top 3rd, vs #12" />
          </Field>
          <PrimaryButton onClick={addManual} disabled={!manual.velocity}>+ Add manual reading</PrimaryButton>
        </div>
        {guest && (
          <form onSubmit={addGuest} className="flex items-end gap-2 flex-wrap mt-3 pt-3 border-t" style={{ borderColor: '#1e3a5f' }} data-testid="guest-form">
            <Field label="Jersey"><TextInput value={guest.jersey} onChange={e => setGuest(g => ({ ...g, jersey: e.target.value }))} placeholder="12" /></Field>
            <Field label="First name (optional)"><TextInput value={guest.first_name} onChange={e => setGuest(g => ({ ...g, first_name: e.target.value }))} placeholder="Unknown" /></Field>
            <Field label="Last name (optional)"><TextInput value={guest.last_name} onChange={e => setGuest(g => ({ ...g, last_name: e.target.value }))} placeholder="Guest" /></Field>
            <PrimaryButton type="submit" disabled={!guest.jersey && !guest.first_name && !guest.last_name}>Add guest placeholder</PrimaryButton>
            <span className="text-xs" style={{ color: '#64748b' }}>Not on any roster? Attribute to a placeholder now and reassign after the game.</span>
          </form>
        )}
      </section>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_260px] gap-5 items-start">
        <section className="rounded-2xl border overflow-hidden" style={cardStyle}>
          <div className="flex items-center gap-1 p-3 border-b" style={{ borderColor: '#1e3a5f' }}>
            {['unmatched', 'matched', 'invalid', 'all'].map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className="px-2.5 py-1 rounded-lg text-xs font-bold cursor-pointer"
                style={filter === f ? { backgroundColor: '#38bdf8', color: '#06122b' } : { backgroundColor: 'rgba(30, 41, 59, 0.9)', color: '#94a3b8' }}>
                {f.charAt(0).toUpperCase() + f.slice(1)} ({counts[f]})
              </button>
            ))}
          </div>
          {selected.size > 0 && (
            <div className="flex flex-wrap items-end gap-2 p-3 border-b" style={{ borderColor: '#1e3a5f', backgroundColor: 'rgba(56, 189, 248, 0.06)' }} data-testid="bulk-bar">
              <span className="text-sm font-bold text-white pb-2">{selected.size} selected</span>
              <Field label="Assign to">
                <Select value={bulk.player_id} onChange={e => setBulk(b => ({ ...b, player_id: e.target.value }))} data-testid="bulk-player">
                  <option value="">— pick —</option>
                  <RosterOptions data={data} label={rosterLabel} />
                </Select>
              </Field>
              <Field label="Type">
                <Select value={bulk.pitch_or_exit} onChange={e => setBulk(b => ({ ...b, pitch_or_exit: e.target.value }))}>
                  <option value="pitch">Pitch</option><option value="exit">Exit</option>
                </Select>
              </Field>
              <Field label="Pitch type">
                <Select value={bulk.pitch_type} onChange={e => setBulk(b => ({ ...b, pitch_type: e.target.value }))}>
                  <option value="">keep</option>{data.pitch_types.map(t => <option key={t} value={t}>{t}</option>)}
                </Select>
              </Field>
              <PrimaryButton disabled={bulkBusy || !bulk.player_id} onClick={() => assignSelected('matched')} data-testid="bulk-assign">Assign {selected.size}</PrimaryButton>
              <GhostButton disabled={bulkBusy} onClick={() => assignSelected('unmatched')}>Unmatch</GhostButton>
              <GhostButton disabled={bulkBusy} onClick={() => assignSelected('invalid')}>Invalid</GhostButton>
              <GhostButton onClick={() => setSelected(new Set())}>Clear</GhostButton>
            </div>
          )}
          {groups.length > 0 && (
            <p className="px-4 pt-3 text-xs flex items-center gap-2 flex-wrap" style={{ color: '#64748b' }}>
              {groups.length} groups, split where the gun paused for more than
              <select value={pauseS} onChange={e => setPauseS(Number(e.target.value))} aria-label="Pause that starts a new group" className="rounded px-1 py-0.5" style={{ backgroundColor: 'rgba(30, 41, 59, 0.95)', color: '#cfe8ff' }}>
                {[45, 60, 90, 120, 180, 300].map(n => <option key={n} value={n}>{n < 60 ? `${n} s` : `${n / 60} min`}</option>)}
              </select>
              — usually a half inning or a pitching change. Select a group, then assign it to its pitcher.
            </p>
          )}
          {visible.length === 0 ? (
            <p className="p-6 text-sm" style={{ color: '#94a3b8' }}>Nothing in this bucket.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider" style={{ color: '#64748b' }}>
                  <th className="pl-4 py-2.5 w-8">
                    <input type="checkbox" aria-label="Select all shown" checked={visible.length > 0 && visible.every(r => selected.has(r.id))}
                      onChange={e => setSelected(e.target.checked ? new Set(visible.map(r => r.id)) : new Set())} />
                  </th>
                  <th className="px-4 py-2.5">Velocity</th>
                  <th className="px-4 py-2.5">Source</th>
                  <th className="px-4 py-2.5">Player</th>
                  <th className="px-4 py-2.5">Type</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(r => (
                <Fragment key={r.id}>
                  {groupAt.has(r.id) && (
                    <tr className="border-t" style={{ borderColor: '#1e3a5f', backgroundColor: 'rgba(30, 41, 59, 0.45)' }} data-testid="reading-group">
                      <td colSpan={7} className="px-4 py-1.5 text-xs" style={{ color: '#94a3b8' }}>
                        <b style={{ color: '#cfe8ff' }}>Group {groupAt.get(r.id).n}</b> · {groupAt.get(r.id).ids.length} reading{groupAt.get(r.id).ids.length === 1 ? '' : 's'}
                        {groupAt.get(r.id).first ? ` · ${String(groupAt.get(r.id).first).slice(11, 16)}–${String(groupAt.get(r.id).last).slice(11, 16)}` : ''}
                        <button type="button" onClick={() => selectIds(groupAt.get(r.id).ids)} className="ml-2 font-bold cursor-pointer hover:underline" style={{ color: '#38bdf8' }}>Select</button>
                      </td>
                    </tr>
                  )}
                  <tr className="border-t" style={{ borderColor: '#1e3a5f', backgroundColor: selected.has(r.id) ? 'rgba(56, 189, 248, 0.07)' : undefined }}>
                    <td className="pl-4 py-2.5">
                      <input type="checkbox" checked={selected.has(r.id)} aria-label={`Select reading ${r.row_index ?? r.id}`}
                        onClick={e => { e.preventDefault(); toggle(r.id, e.shiftKey); }} onChange={() => {}} />
                    </td>
                    <td className="px-4 py-2.5 font-bold text-white whitespace-nowrap">
                      {r.velocity != null ? `${r.velocity.toFixed(1)} mph` : <span style={{ color: '#64748b' }}>unreadable</span>}
                    </td>
                    <td className="px-4 py-2.5 text-xs" style={{ color: '#64748b' }} title={r.raw_row || undefined} data-testid="reading-source">
                      {r.source === 'manual' ? (
                        <>manual entry{r.created_by_name ? ` by ${r.created_by_name}` : ''}{r.source_timestamp ? ` · ${r.source_timestamp}` : ''}</>
                      ) : (
                        <>
                          <span style={{ color: '#94a3b8' }}>{r.import_filename || 'CSV'}</span> · row {r.row_index}
                          {r.source_timestamp ? ` · ${r.source_timestamp}` : ''}
                          {r.raw_row ? <span className="font-mono" style={{ color: '#475569' }}> · raw “{r.raw_row.length > 36 ? `${r.raw_row.slice(0, 36)}…` : r.raw_row}”</span> : ''}
                        </>
                      )}
                      {r.confirmed_by_name && r.status !== 'unmatched' && (
                        <span className="block" style={{ color: r.status === 'invalid' ? '#94a3b8' : '#4ade80' }}>
                          {r.status === 'invalid' ? 'marked invalid' : 'confirmed'} by {r.confirmed_by_name}{r.confirmed_at ? ` · ${r.confirmed_at.slice(0, 16)} UTC` : ''}
                        </span>
                      )}
                      {r.note ? <span style={{ color: '#fbbf24' }}> · {r.note}</span> : ''}
                    </td>
                    <td className="px-4 py-2.5" style={{ color: '#cfe8ff' }}>
                      {r.player_id ? `${r.first_name} ${r.last_name}` : r.suggestion ? (
                        <span className="text-xs" data-testid="reading-suggestion">
                          <span style={{ color: '#94a3b8' }}>suggested </span>
                          <b style={{ color: '#fbbf24' }}>{r.suggestion.first_name} {r.suggestion.last_name}</b>
                          <span className="block" style={{ color: '#64748b' }}>{r.suggestion.reason}</span>
                        </span>
                      ) : <span style={{ color: '#475569' }}>—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-xs" style={{ color: '#94a3b8' }}>
                      {r.pitch_or_exit}{r.pitch_type !== 'unknown' ? ` · ${r.pitch_type}` : ''}
                    </td>
                    <td className="px-4 py-2.5"><ReadingStatus value={r.status} /></td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      {busyId === r.id ? (
                        <span className="text-xs font-bold" style={{ color: '#38bdf8' }}>saving…</span>
                      ) : invalidating?.id === r.id ? (
                        <span className="text-xs font-bold" style={{ color: '#fbbf24' }}>confirm below ↓</span>
                      ) : (
                        <>
                          {r.status === 'unmatched' && r.suggestion && r.velocity != null && (
                            <>
                              <PrimaryButton
                                onClick={() => confirmReading(r, { status: 'matched', player_id: r.suggestion.player_id, pitch_or_exit: r.suggestion.pitch_or_exit })}
                                title={`Confirm to ${r.suggestion.first_name} ${r.suggestion.last_name} — ${r.suggestion.reason}`}
                                data-testid="confirm-suggestion"
                              >
                                Confirm suggestion
                              </PrimaryButton>
                              <span className="inline-block w-1.5" />
                            </>
                          )}
                          {r.status !== 'invalid' && r.velocity != null && (
                            <GhostButton onClick={() => confirmReading(r)} disabled={!sticky.player_id}
                              title={sticky.player_id ? 'Confirm to the active player above' : 'Pick an active player above first'}>
                              {r.status === 'matched' ? 'Reassign' : r.suggestion ? 'Confirm to active' : 'Confirm'}
                            </GhostButton>
                          )}
                          <span className="inline-block w-1.5" />
                          {r.status !== 'invalid' && (
                            <GhostButton onClick={() => setInvalidating({ id: r.id, reason: '', detail: '' })}>Invalid</GhostButton>
                          )}
                          {r.status === 'invalid' && (
                            // A reading that still carries its player goes straight back to that
                            // assignment and revives its one result (published values return to
                            // the profile at once); one that never matched returns to unmatched.
                            <GhostButton
                              title={r.player_id ? `Restore to ${r.first_name} ${r.last_name} — revives the same result and rollups` : 'Restore to unmatched'}
                              onClick={() => confirmReading(r, r.player_id
                                // The invalid reason stays in the audit trail; the live row should not keep wearing it.
                                ? { status: 'matched', player_id: r.player_id, pitch_or_exit: r.pitch_or_exit, pitch_type: r.pitch_type, note: '' }
                                : { status: 'unmatched', player_id: null, note: '' })}
                            >
                              Restore
                            </GhostButton>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                  {invalidating?.id === r.id && busyId !== r.id && (
                    <tr key={`${r.id}-reason`} data-testid="invalid-reason-panel">
                      <td colSpan={7} className="px-4 pb-4 pt-1">
                        <div className="rounded-xl border p-4" style={{ borderColor: 'rgba(251, 191, 36, 0.35)', backgroundColor: 'rgba(251, 191, 36, 0.06)' }}>
                          <p className="text-sm font-bold text-white">
                            Mark this {r.velocity != null ? `${r.velocity.toFixed(1)} mph` : ''} reading invalid
                            <span className="font-normal text-xs ml-2" style={{ color: '#94a3b8' }}>reason optional</span>
                          </p>
                          <p className="text-xs mt-0.5 mb-3" style={{ color: '#94a3b8' }}>
                            The reading stays on the record. Its result and any published rollups are withdrawn immediately; Restore brings the same result back. Who marked it and when is always recorded; a reason is kept with it if you add one.
                            {r.note ? <span style={{ color: '#fbbf24' }}> Current note: “{r.note}”.</span> : ''}
                          </p>
                          <div className="flex flex-wrap gap-2 mb-3">
                            {INVALID_REASONS.map(reason => {
                              const active = invalidating.reason === reason;
                              return (
                                <button
                                  key={reason}
                                  type="button"
                                  onClick={() => setInvalidating(v => ({ ...v, reason: active ? '' : reason }))}
                                  className="text-xs font-bold px-3 py-1.5 rounded-full border cursor-pointer"
                                  style={active
                                    ? { borderColor: '#fbbf24', backgroundColor: 'rgba(251, 191, 36, 0.2)', color: '#fbbf24' }
                                    : { borderColor: '#334155', color: '#cfe8ff' }}
                                >
                                  {reason}
                                </button>
                              );
                            })}
                          </div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <TextInput
                              autoFocus
                              value={invalidating.detail}
                              onChange={e => setInvalidating(v => ({ ...v, detail: e.target.value }))}
                              onKeyDown={e => { if (e.key === 'Enter') submitInvalid(); if (e.key === 'Escape') setInvalidating(null); }}
                              placeholder={invalidating.reason ? 'Add detail — e.g. car on the road behind the mound' : 'Reason (optional)…'}
                              className="flex-1 min-w-64"
                            />
                            <PrimaryButton onClick={submitInvalid}>Mark invalid</PrimaryButton>
                            <GhostButton onClick={() => setInvalidating(null)}>Cancel</GhostButton>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="rounded-2xl border p-5" style={cardStyle}>
          <h2 className="text-sm font-bold uppercase tracking-widest mb-3" style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Draft rollups</h2>
          {data.summaries.length === 0 ? (
            <p className="text-sm" style={{ color: '#64748b' }}>Confirm readings to see per-player min / max / average build live.</p>
          ) : data.summaries.map(s => (
            <div key={`${s.player_id}:${s.metric_code}`} className="py-2.5 border-t" style={{ borderColor: '#1e3a5f' }}>
              <p className="text-sm font-bold text-white">{s.name}</p>
              <p className="text-xs" style={{ color: '#94a3b8' }}>
                {s.metric_code === 'exit_velocity_radar' ? 'Exit velocity' : 'Pitch velocity'} ·{' '}
                <b style={{ color: '#4ade80' }}>{s.max}</b> max · {s.average} avg · {s.min} min · {s.valid_readings} readings
              </p>
            </div>
          ))}
          <p className="text-[10px] mt-3" style={{ color: '#475569' }}>
            Live preview of the release rollup (DM_RELEASE_V1). Unavailable and invalid readings never enter these numbers.
          </p>
        </section>
      </div>
    </div>
  );
}
