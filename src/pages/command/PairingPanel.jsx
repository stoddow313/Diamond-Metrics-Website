// The other team's job for the same game. Paired, both jobs use one set of
// footage (no second upload or proxy build) and one scorebook, and each
// releases its own team's players (server/gamePairing.js).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { Select, PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import { InfoTip } from '../../components/Tooltip';
import { cardStyle } from '../../components/admin/theme';

const describe = c => `#${c.id} · ${c.team_name}${c.scorebook_events ? ' · scored' : ''}${c.feeds ? ` · ${c.feeds} video${c.feeds === 1 ? '' : 's'}` : ''}`;

export default function PairingPanel({ job, onChanged }) {
  const [data, setData] = useState(null);
  const [choice, setChoice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    api.commandPairing(job.id).then(d => { setData(d); setChoice(d.candidates?.[0] ? String(d.candidates[0].id) : ''); }).catch(err => setError(err.message));
  }, [job.id, tick]);

  async function act(fn) {
    setBusy(true); setError('');
    try { await fn(); setTick(t => t + 1); onChanged?.(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <section className="rounded-2xl border p-6" style={cardStyle} data-testid="pairing">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-lg font-bold text-white" style={{ fontSize: '1.125rem', marginBottom: 0 }}>Other team’s job</h2>
        <InfoTip label="About paired jobs">
          Pair the other team’s job for this game. Both jobs then use one set of footage — no second upload or proxy build — and one scorebook, and each releases its own team’s players. The other team’s lineup and radar readings come from its roster.
        </InfoTip>
      </div>
      <ErrorNote>{error}</ErrorNote>
      {!data ? <p className="text-sm" style={{ color: '#94a3b8' }}>Loading…</p> : data.partner ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Link to={`/command/jobs/${data.partner.id}`} className="font-bold hover:underline" style={{ color: '#38bdf8' }}>
            #{data.partner.id} · {data.partner.team_name}
          </Link>
          <span className="text-xs" style={{ color: '#94a3b8' }}>
            {data.role === 'host' ? 'Uses this job’s footage and scorebook' : 'This job uses its footage and scorebook'}
          </span>
          <GhostButton type="button" disabled={busy} style={{ padding: '3px 12px', fontSize: 12 }}
            onClick={() => window.confirm(`Stop sharing footage and the scorebook with job #${data.partner.id}?`) && act(() => api.commandUnpair(job.id))}>
            Unpair
          </GhostButton>
        </div>
      ) : data.candidates.length === 0 ? (
        <p className="text-sm" style={{ color: '#94a3b8' }}>No other team’s job on {job.game_date} yet. Create it with the same date, then pair it here.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={choice} onChange={e => setChoice(e.target.value)} aria-label="The other team's job" style={{ width: 'auto', minWidth: 220 }}>
            {data.candidates.map(c => <option key={c.id} value={c.id}>{describe(c)}</option>)}
          </Select>
          <PrimaryButton type="button" disabled={busy || !choice} onClick={() => act(() => api.commandPair(job.id, Number(choice)))}>Pair</PrimaryButton>
        </div>
      )}
    </section>
  );
}
