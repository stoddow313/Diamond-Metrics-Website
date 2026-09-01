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
  const [verify, setVerify] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [emailTest, setEmailTest] = useState(null);
  const [sendingTest, setSendingTest] = useState(false);

  async function verifyBackup() {
    setError('');
    setVerifying(true);
    try {
      const { verify: v } = await api.commandBackupVerify();
      setVerify(v);
    } catch (err) {
      setError(err.message);
    } finally {
      setVerifying(false);
    }
  }

  async function sendTest(e) {
    e?.preventDefault();
    setError('');
    setSendingTest(true);
    setEmailTest(null);
    try {
      const { result } = await api.commandEmailTest(testTo);
      setEmailTest(result);
    } catch (err) {
      // 400s carry the provider/config reason in the message.
      setEmailTest({ ok: false, error: err.message });
    } finally {
      setSendingTest(false);
    }
  }

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
          <HealthRow
            label="Operator alerts"
            value={ops.ops_alerts ? 'webhook connected (failed processing, failed backups, crashes)' : 'not configured — set DM_ALERT_WEBHOOK_URL'}
            ok={ops.ops_alerts}
          />
          <HealthRow
            label="Customer email"
            value={ops.email_configured ? `sending as ${ops.email_from}` : `not configured — set ${(ops.email_missing_config || []).join(' + ') || 'RESEND_API_KEY + DM_EMAIL_FROM'}`}
            ok={ops.email_configured}
          />
          {user?.role === 'admin' && (
            <form onSubmit={sendTest} className="flex items-center justify-between gap-2 py-2 border-t flex-wrap" style={{ borderColor: '#1e3a5f' }}>
              <span className="text-sm" style={{ color: '#94a3b8' }}>Email test send</span>
              <span className="flex items-center gap-1.5">
                <input
                  type="email"
                  value={testTo}
                  onChange={e => setTestTo(e.target.value)}
                  placeholder="you@diamondmetrics.ai"
                  className="px-2.5 py-1 rounded-lg border text-xs w-48"
                  style={{ borderColor: '#334155', backgroundColor: 'rgba(15,23,42,0.9)', color: '#f8fafc' }}
                  data-testid="email-test-to"
                />
                <button type="submit" disabled={sendingTest || !testTo}
                  className="text-xs font-bold px-3 py-1 rounded-lg border cursor-pointer hover:bg-slate-800 disabled:opacity-50"
                  style={{ borderColor: '#334155', color: '#cfe8ff' }}>
                  {sendingTest ? 'Sending…' : 'Send test'}
                </button>
              </span>
            </form>
          )}
          {emailTest && (
            <p className="text-xs py-1" style={{ color: emailTest.ok ? '#4ade80' : '#f87171' }} data-testid="email-test-result">
              {emailTest.ok
                ? `✓ accepted by provider (HTTP ${emailTest.status}) — check ${emailTest.to}`
                : `✗ ${emailTest.error || `provider HTTP ${emailTest.status}: ${emailTest.provider_response || 'no detail'}`}`}
            </p>
          )}
          <HealthRow label="Media queue" value={`${ops.media_queue.queued || 0} queued · ${ops.media_queue.running || 0} running · ${ops.media_queue.failed || 0} failed`} ok={!ops.media_queue.failed} />
          <HealthRow
            label="Feeds needing attention"
            value={`${ops.media_queue.stuck_feeds}${ops.media_queue.stalled ? ` — ${ops.media_queue.stalled} stalled (silent > ${Math.round((ops.media_queue.stall_threshold_s || 300) / 60)} min, will be reaped)` : ''}`}
            ok={ops.media_queue.stuck_feeds === 0}
          />
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
          {user?.role === 'admin' && (
            <div className="flex items-center justify-between py-2 border-t" style={{ borderColor: '#1e3a5f' }}>
              <span className="text-sm" style={{ color: '#94a3b8' }}>Restore drill</span>
              {verify ? (
                <span className="text-sm font-bold text-right" style={{ color: verify.ok ? '#4ade80' : '#f87171' }} data-testid="backup-verify-result">
                  {verify.ok
                    ? `✓ integrity ok · ${verify.counts.cmd_jobs} jobs · ${verify.counts.players} players · ${(verify.bytes / 1e6).toFixed(1)} MB in ${verify.ms}ms`
                    : `✗ ${verify.error || `integrity: ${verify.integrity}`}`}
                </span>
              ) : (
                <button onClick={verifyBackup} disabled={verifying}
                  className="text-xs font-bold px-3 py-1 rounded-lg border cursor-pointer hover:bg-slate-800"
                  style={{ borderColor: '#334155', color: '#cfe8ff' }}>
                  {verifying ? 'Verifying…' : 'Verify latest snapshot'}
                </button>
              )}
            </div>
          )}
          <p className="text-[10px] mt-3" style={{ color: '#475569' }}>
            Snapshots use SQLite&apos;s online backup API (safe on a live WAL database) and land in the media storage bucket. The restore drill pulls the newest one back, runs integrity_check, and counts its rows. Full restore runbook: docs/COMMAND_OPS.md §4.
          </p>
        </section>
      </div>
    </div>
  );
}
