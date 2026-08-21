import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { PrimaryButton, Select, Field, ErrorNote } from '../../components/admin/ui';
import { cardStyle } from '../../components/admin/theme';

// Operations (Command M6): pipeline telemetry + service health. These are
// the numbers that turn the pilot estimate into a per-game cost model —
// where jobs actually spend time, how often evidence can't be measured,
// how often review sends work back.

const pct = v => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);
const hrs = v => (v == null ? '—' : v >= 24 ? `${(v / 24).toFixed(1)}d` : `${v.toFixed(1)}h`);

function Stat({ label, value, hint, tone = '#f8fafc' }) {
  return (
    <div className="rounded-2xl border p-4" style={cardStyle}>
      <p className="text-[10px] font-bold uppercase tracking-widest mb-1" style={{ color: '#94a3b8' }}>{label}</p>
      <p className="text-2xl font-black tabular-nums" style={{ color: tone }}>{value}</p>
      {hint && <p className="text-xs mt-0.5" style={{ color: '#64748b' }}>{hint}</p>}
    </div>
  );
}

function HealthRow({ label, value, ok }) {
  return (
    <div className="flex items-center justify-between py-2 border-t" style={{ borderColor: '#1e3a5f' }}>
      <span className="text-sm" style={{ color: '#94a3b8' }}>{label}</span>
      <span className="text-sm font-bold" style={{ color: ok === false ? '#fbbf24' : ok === true ? '#4ade80' : '#cfe8ff' }}>{value}</span>
    </div>
  );
}

export default function OpsPage() {
  const { user } = useAuth();
  const [days, setDays] = useState(30);
  const [telemetry, setTelemetry] = useState(null);
  const [ops, setOps] = useState(null);
  const [error, setError] = useState('');
  const [backingUp, setBackingUp] = useState(false);
  const [storageCheck, setStorageCheck] = useState(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(() => {
    Promise.all([api.commandTelemetry(days), api.commandOps()])
      .then(([t, o]) => { setTelemetry(t); setOps(o); })
      .catch(err => setError(err.message));
  }, [days]);
  useEffect(() => { load(); }, [load]);

  async function runBackup() {
    setError('');
    setBackingUp(true);
    try {
      await api.commandRunBackup();
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBackingUp(false);
    }
  }

  async function checkStorage() {
    setError('');
    setChecking(true);
    try {
      const { check } = await api.commandStorageCheck();
      setStorageCheck(check);
    } catch (err) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  }

  if (!telemetry || !ops) return <p style={{ color: '#94a3b8' }}>{error || 'Loading operations…'}</p>;

  const { jobs, stages, radar, results, review, media } = telemetry;
  const backup = ops.backups.last;
  const backupAge = backup ? (Date.now() - Date.parse(`${backup.created_at.replace(' ', 'T')}Z`)) / 3_600_000 : null;

  return (
    <div>
      <div className="flex items-end justify-between gap-3 mb-5 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-white">Operations</h1>
          <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>
            Pipeline timing and quality rates over the trailing window, plus service health. Empty stats mean no data yet — never a zero score.
          </p>
        </div>
        <Field label="Window">
          <Select value={days} onChange={e => setDays(Number(e.target.value))}>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </Select>
        </Field>
      </div>

      <ErrorNote>{error}</ErrorNote>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <Stat label="Jobs in window" value={jobs.total} hint={`${jobs.released} released · ${jobs.in_flight} in flight`} />
        <Stat label="Turnaround (p50)" value={hrs(jobs.p50_turnaround_hours)} hint={`p90 ${hrs(jobs.p90_turnaround_hours)} — created to released`} tone="#38bdf8" />
        <Stat label="Radar match rate" value={pct(radar.match_rate)}
          hint={`${radar.matched} matched · ${radar.unmatched} unmatched · ${radar.unparseable} unreadable`} tone="#4ade80" />
        <Stat label="Unavailable rate" value={pct(results.unavailable_rate)}
          hint={`${results.unavailable} of ${results.total} results`} tone={results.unavailable_rate > 0.2 ? '#fbbf24' : '#f8fafc'} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <section className="rounded-2xl border p-5" style={cardStyle}>
          <p className="text-[11px] font-bold uppercase tracking-widest mb-3" style={{ color: '#94a3b8' }}>Time in stage</p>
          {stages.length === 0 ? (
            <p className="text-sm" style={{ color: '#64748b' }}>No completed stages in this window yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider" style={{ color: '#64748b' }}>
                  <th className="py-1.5">Stage</th><th className="py-1.5 text-right">p50</th>
                  <th className="py-1.5 text-right">p90</th><th className="py-1.5 text-right">n</th>
                </tr>
              </thead>
              <tbody>
                {stages.map(s => (
                  <tr key={s.stage} className="border-t" style={{ borderColor: '#1e3a5f' }}>
                    <td className="py-2 text-white">{s.stage.replace(/_/g, ' ')}</td>
                    <td className="py-2 text-right tabular-nums" style={{ color: '#cfe8ff' }}>{hrs(s.p50_hours)}</td>
                    <td className="py-2 text-right tabular-nums" style={{ color: '#94a3b8' }}>{hrs(s.p90_hours)}</td>
                    <td className="py-2 text-right tabular-nums" style={{ color: '#64748b' }}>{s.samples}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-[10px] mt-3" style={{ color: '#475569' }}>
            Review returns: {review.returns} across {review.jobs_reviewed} reviewed jobs ({pct(review.return_rate)}).
          </p>
        </section>

        <section className="rounded-2xl border p-5" style={cardStyle}>
          <p className="text-[11px] font-bold uppercase tracking-widest mb-3" style={{ color: '#94a3b8' }}>Media pipeline</p>
          {media.length === 0 ? (
            <p className="text-sm" style={{ color: '#64748b' }}>No media jobs in this window.</p>
          ) : media.map(m => (
            <div key={m.kind} className="py-2 border-t" style={{ borderColor: '#1e3a5f' }}>
              <p className="text-sm font-bold text-white">{m.kind}</p>
              <p className="text-xs" style={{ color: '#94a3b8' }}>
                {m.total} jobs · p50 {m.p50_seconds != null ? `${m.p50_seconds}s` : '—'} · p90 {m.p90_seconds != null ? `${m.p90_seconds}s` : '—'}
                {m.failed > 0 && <span style={{ color: '#f87171' }}> · {m.failed} failed</span>}
                {m.retried > 0 && <span style={{ color: '#fbbf24' }}> · {m.retried} retried</span>}
              </p>
            </div>
          ))}
        </section>

        <section className="rounded-2xl border p-5" style={cardStyle}>
          <p className="text-[11px] font-bold uppercase tracking-widest mb-1" style={{ color: '#94a3b8' }}>Service health</p>
          <HealthRow label="Environment" value={ops.environment} />
          <HealthRow
            label="Media storage"
            value={!ops.storage_ready ? `misconfigured — missing ${ops.storage_missing_config.join(', ')}` : ops.storage_mode === 'r2' ? 'Cloudflare R2' : 'local disk (dev)'}
            ok={ops.storage_ready && ops.storage_mode === 'r2'}
          />
          {user?.role === 'admin' && (
            <div className="flex items-center justify-between py-2 border-t" style={{ borderColor: '#1e3a5f' }}>
              <span className="text-sm" style={{ color: '#94a3b8' }}>Storage round-trip</span>
              {storageCheck ? (
                <span className="text-sm font-bold" style={{ color: storageCheck.ok ? '#4ade80' : '#f87171' }}>
                  {storageCheck.ok ? `✓ write→read→delete in ${storageCheck.ms}ms` : `failed at ${storageCheck.steps.length ? `“${storageCheck.steps.at(-1)}”` : 'start'}`}
                </span>
              ) : (
                <button onClick={checkStorage} disabled={checking}
                  className="text-xs font-bold px-3 py-1 rounded-lg border cursor-pointer hover:bg-slate-800"
                  style={{ borderColor: '#334155', color: '#cfe8ff' }}>
                  {checking ? 'Testing…' : 'Test now'}
                </button>
              )}
            </div>
          )}
          {storageCheck && !storageCheck.ok && (
            <p className="text-xs py-1" style={{ color: '#f87171' }}>{storageCheck.error}</p>
          )}
          <HealthRow label="Media worker" value={ops.worker_mode} />
          <HealthRow
            label="Video processing"
            value={ops.video?.ok ? ops.video.ffmpeg.version : `unavailable — ${ops.video?.ffmpeg?.error || 'ffmpeg not found'}`}
            ok={!!ops.video?.ok}
          />
          <HealthRow label="Error tracking" value={ops.error_tracking ? 'Sentry connected' : 'logs only'} ok={ops.error_tracking} />
          <HealthRow label="Customer email" value={ops.email_configured ? 'sending' : 'recorded in-app only'} ok={ops.email_configured} />
          <HealthRow label="Media queue" value={`${ops.media_queue.queued || 0} queued · ${ops.media_queue.failed || 0} failed`} ok={!ops.media_queue.failed} />
          <HealthRow label="Feeds needing attention" value={ops.media_queue.stuck_feeds} ok={ops.media_queue.stuck_feeds === 0} />
        </section>

        <section className="rounded-2xl border p-5" style={cardStyle}>
          <div className="flex items-center justify-between mb-1">
            <p className="text-[11px] font-bold uppercase tracking-widest" style={{ color: '#94a3b8' }}>Backups</p>
            {user?.role === 'admin' && (
              <PrimaryButton onClick={runBackup} disabled={backingUp}>{backingUp ? 'Running…' : 'Back up now'}</PrimaryButton>
            )}
          </div>
          <HealthRow label="Scheduler" value={ops.backups.enabled ? 'nightly' : 'disabled'} ok={ops.backups.enabled} />
          <HealthRow label="Retention" value={`${ops.backups.retention_days} days`} />
          {backup ? (
            <>
              <HealthRow
                label="Last snapshot"
                value={`${backup.created_at} UTC${backupAge != null ? ` (${hrs(backupAge)} ago)` : ''}`}
                ok={backup.status === 'ok' && backupAge < 36}
              />
              <HealthRow label="Size" value={backup.bytes ? `${(backup.bytes / 1e6).toFixed(1)} MB` : '—'} />
              {backup.status !== 'ok' && <HealthRow label="Error" value={backup.error} ok={false} />}
            </>
          ) : (
            <HealthRow label="Last snapshot" value="none yet" ok={false} />
          )}
          <p className="text-[10px] mt-3" style={{ color: '#475569' }}>
            Snapshots use SQLite&apos;s online backup API (safe on a live WAL database) and land in the media storage bucket. Restore runbook: docs/COMMAND_OPS.md.
          </p>
        </section>
      </div>
    </div>
  );
}
