import { useEffect, useMemo, useRef, useState } from 'react';
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
  const fileRef = useRef(null);

  const load = () => api.commandRadarQueue(jobId).then(setData).catch(err => setError(err.message));
  useEffect(() => {
    api.commandRadarQueue(jobId).then(setData).catch(err => setError(err.message));
  }, [jobId]);

  const visible = useMemo(() => {
    if (!data) return [];
    if (filter === 'all') return data.readings;
    return data.readings.filter(r => r.status === filter);
  }, [data, filter]);

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
    setError('');
    try {
      await api.commandClassifyReading(reading.id, {
        player_id: sticky.player_id ? Number(sticky.player_id) : null,
        pitch_or_exit: sticky.pitch_or_exit,
        pitch_type: sticky.pitch_type,
        status: 'matched',
        ...overrides,
      });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function invalidate(reading) {
    const note = window.prompt('Invalid reason (e.g. car radar noise, warm-up):', reading.note || '');
    if (note === null) return;
    await api.commandClassifyReading(reading.id, { status: 'invalid', note }).catch(err => setError(err.message));
    await load();
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
      setManual({ velocity: '', context: '', note: '' });
      await load();
    } catch (err) {
      setError(err.message);
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

      <ErrorNote>{error}</ErrorNote>

      {/* sticky context + manual entry */}
      <section className="rounded-2xl border p-5 mb-5" style={cardStyle}>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 items-end">
          <Field label="Active player (carries forward)">
            <Select value={sticky.player_id} onChange={e => setSticky(s => ({ ...s, player_id: e.target.value }))}>
              <option value="">— none —</option>
              {data.roster.map(p => <option key={p.id} value={p.id}>{p.first_name} {p.last_name}{p.primary_position ? ` (${p.primary_position})` : ''}</option>)}
            </Select>
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
      </section>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_260px] gap-5 items-start">
        <section className="rounded-2xl border overflow-hidden" style={cardStyle}>
          <div className="flex items-center gap-1 p-3 border-b" style={{ borderColor: '#1e3a5f' }}>
            {['unmatched', 'matched', 'invalid', 'all'].map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className="px-2.5 py-1 rounded-lg text-xs font-bold cursor-pointer"
                style={filter === f ? { backgroundColor: '#38bdf8', color: '#06122b' } : { backgroundColor: 'rgba(30, 41, 59, 0.9)', color: '#94a3b8' }}>
                {f} ({counts[f]})
              </button>
            ))}
          </div>
          {visible.length === 0 ? (
            <p className="p-6 text-sm" style={{ color: '#94a3b8' }}>Nothing in this bucket.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider" style={{ color: '#64748b' }}>
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
                  <tr key={r.id} className="border-t" style={{ borderColor: '#1e3a5f' }}>
                    <td className="px-4 py-2.5 font-bold text-white whitespace-nowrap">
                      {r.velocity != null ? `${r.velocity.toFixed(1)} mph` : <span style={{ color: '#64748b' }}>unreadable</span>}
                    </td>
                    <td className="px-4 py-2.5 text-xs" style={{ color: '#64748b' }}>
                      {r.source === 'manual' ? 'manual' : `row ${r.row_index}`}{r.source_timestamp ? ` · ${r.source_timestamp}` : ''}
                      {r.note ? <span style={{ color: '#fbbf24' }}> · {r.note}</span> : ''}
                    </td>
                    <td className="px-4 py-2.5" style={{ color: '#cfe8ff' }}>
                      {r.player_id ? `${r.first_name} ${r.last_name}` : <span style={{ color: '#475569' }}>—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-xs" style={{ color: '#94a3b8' }}>
                      {r.pitch_or_exit}{r.pitch_type !== 'unknown' ? ` · ${r.pitch_type}` : ''}
                    </td>
                    <td className="px-4 py-2.5"><ReadingStatus value={r.status} /></td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      {r.status !== 'invalid' && r.velocity != null && (
                        <PrimaryButton onClick={() => confirmReading(r)} disabled={!sticky.player_id}>
                          {r.status === 'matched' ? 'Reassign' : 'Confirm'}
                        </PrimaryButton>
                      )}
                      <span className="inline-block w-1.5" />
                      {r.status !== 'invalid' && <GhostButton onClick={() => invalidate(r)}>Invalid</GhostButton>}
                      {r.status === 'invalid' && (
                        <GhostButton onClick={() => api.commandClassifyReading(r.id, { status: 'unmatched' }).then(load).catch(e => setError(e.message))}>
                          Restore
                        </GhostButton>
                      )}
                    </td>
                  </tr>
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
