// Files for one submission (customer footage submission §5 supporting data,
// §6 upload): a labelled game video per camera angle plus optional radar,
// scorecard and roster files. Uploads go straight to storage in resumable
// parts; per-file progress, elapsed time, the failing stage, retry, and
// resume-by-choosing-the-same-file are all visible. Nothing says "ready"
// before the server has actually checked the file.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { uploadIntakeFile } from '../../lib/mediaUpload';
import { fmtBytes, fmtElapsed } from '../../lib/intake';
import { Select, TextInput, GhostButton, PrimaryButton } from '../../components/admin/ui';
import { InfoTip, Tooltip } from '../../components/Tooltip';
import { Card, Banner, ProgressBar, Issues, SectionTitle } from './ui';

const SUPPORTING = [
  { kind: 'radar_csv', help: 'Radar readings are matched to the pitches in your video.' },
  { kind: 'scorecard', help: 'A scorebook or GameChanger export helps us check the game record.' },
  { kind: 'roster', help: 'Coaches: a roster can stand in for listing every athlete.' },
];
const VIDEO_HINT = 'Upload the original file from the camera or phone, one file per camera angle. Big files go up in parts — if your connection drops, choose the same file again and it picks up where it stopped.';
const CHECKING = ['uploaded', 'processing'];
const UNFINISHED = ['uploading', 'paused'];
const TONE = {
  ready: '#4ade80', needs_customer_action: '#f87171', rejected: '#f87171',
  uploaded: '#38bdf8', processing: '#38bdf8', uploading: '#38bdf8', paused: '#fbbf24',
};

let seq = 0;

function defaultView(files, packageKey) {
  const videos = files.filter(f => f.kind === 'video');
  if (!videos.some(f => f.camera_view === 'behind_home')) return 'behind_home';
  if (packageKey === 'pro' && !videos.some(f => String(f.camera_view).startsWith('side_'))) return 'side_first_base';
  return 'other';
}

export default function UploadPanel({ publicId, config, sub, onRefresh, onBusyChange }) {
  const [transfers, setTransfers] = useState({});   // local key → transfer state
  const [notice, setNotice] = useState(null);
  const [view, setView] = useState(() => defaultView(sub.files, sub.package?.key));
  const [label, setLabel] = useState('');
  const [now, setNow] = useState(() => Date.now());   // drives the elapsed-time readout
  const filesRef = useRef({});                     // local key → File, so Retry needs no re-pick
  const specs = useMemo(() => Object.fromEntries(config.file_kinds.map(k => [k.key, k])), [config]);
  const viewLabel = useMemo(() => Object.fromEntries(config.camera_views.map(v => [v.key, v.label])), [config]);

  const active = Object.values(transfers).filter(t => ['checking', 'uploading'].includes(t.phase));
  const busy = active.length > 0;
  const checking = sub.files.some(f => CHECKING.includes(f.status));

  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  // Leaving mid-transfer is safe (it resumes) but worth a warning.
  useEffect(() => {
    if (!busy) return undefined;
    const warn = e => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => { window.removeEventListener('beforeunload', warn); clearInterval(t); };
  }, [busy]);

  // The server checks each video after it lands; show the result when it does.
  useEffect(() => {
    if (!checking) return undefined;
    const t = setInterval(() => onRefresh(), 4000);
    return () => clearInterval(t);
  }, [checking, onRefresh]);

  const patch = (key, fields) => setTransfers(all => (all[key] ? { ...all, [key]: { ...all[key], ...fields } } : all));
  const drop = key => setTransfers(all => { const next = { ...all }; delete next[key]; return next; });

  async function start(file, { kind, cameraView = '', fileLabel = '', key = `t${++seq}` }) {
    filesRef.current[key] = file;
    setNotice(null);
    setTransfers(all => ({
      ...all,
      [key]: { key, name: file.name, size: file.size, kind, view: cameraView, label: fileLabel, phase: 'checking', pct: 0, startedAt: Date.now(), error: null, fileId: all[key]?.fileId ?? null },
    }));
    try {
      const r = await uploadIntakeFile(publicId, file, {
        kind, cameraView, label: fileLabel, spec: specs[kind],
        onRegistered: (row, { resumed }) => { patch(key, { fileId: row.id, phase: 'uploading', resumed }); onRefresh(); },
        onProgress: p => patch(key, { pct: p.pct, part: p.part, totalParts: p.totalParts }),
      });
      drop(key);
      delete filesRef.current[key];
      if (r.duplicate) setNotice({ text: r.message, elsewhere: r.elsewhere });
      await onRefresh();
    } catch (err) {
      patch(key, { phase: 'failed', error: err.message, hint: err.hint || '', resumable: err.resumable !== false, fileId: err.fileId ?? null });
      onRefresh();
    }
  }

  // Real (hidden) inputs rather than detached ones, so assistive tech and
  // browser automation can drive them too.
  const videoInput = useRef(null);
  const supportInputs = useRef({});
  const resumeInput = useRef(null);
  const [resumeTarget, setResumeTarget] = useState(null);
  const taken = e => { const list = [...(e.target.files || [])]; e.target.value = ''; return list; };

  const onVideos = e => {
    const list = taken(e);
    if (!list.length) return;
    for (const f of list) start(f, { kind: 'video', cameraView: view, fileLabel: label.trim() });
    setLabel('');
    setView(defaultView([...sub.files, { kind: 'video', camera_view: view }], sub.package?.key));
  };
  const onSupporting = kind => e => { const [f] = taken(e); if (f) start(f, { kind }); };

  // Resume a transfer this browser no longer holds: the server recognises the
  // same file by its fingerprint and skips the parts it already has.
  const resume = f => { setResumeTarget(f); resumeInput.current?.click(); };
  const onResumeFile = e => {
    const [file] = taken(e);
    const f = resumeTarget;
    if (!file || !f) return;
    if (file.size !== f.size_bytes) {
      setNotice({ text: `That isn’t the same file — choose “${f.original_name}” (${fmtBytes(f.size_bytes)}) to resume, or remove the unfinished upload.` });
      return;
    }
    start(file, { kind: f.kind, cameraView: f.camera_view, fileLabel: f.label });
  };
  const acceptFor = kind => (kind === 'video' ? `${specs.video.extensions.join(',')},video/*` : specs[kind].extensions.join(','));

  async function remove(f) {
    if (!window.confirm(`Remove “${f.original_name}” from this submission? The uploaded copy is deleted.`)) return;
    try { await api.intakeRemoveFile(f.id); await onRefresh(); }
    catch (err) { setNotice({ text: err.message, tone: 'error' }); }
  }

  const byFile = Object.fromEntries(Object.values(transfers).filter(t => t.fileId).map(t => [t.fileId, t]));
  const pending = Object.values(transfers).filter(t => !t.fileId || !sub.files.some(f => f.id === t.fileId));
  const videos = sub.files.filter(f => f.kind === 'video');
  const supporting = sub.files.filter(f => f.kind !== 'video');

  const row = f => (
    <FileRow
      key={`f${f.id}`} file={f} transfer={byFile[f.id]} viewLabel={viewLabel} kindLabel={specs[f.kind]?.label} now={now}
      onRetry={t => start(filesRef.current[t.key], { kind: t.kind, cameraView: t.view, fileLabel: t.label, key: t.key })}
      canRetry={t => !!filesRef.current[t.key]}
      onResume={() => resume(f)} onRemove={() => remove(f)}
    />
  );

  return (
    <div className="flex flex-col gap-5">
      {notice && (
        <Banner tone={notice.tone || 'info'}>
          {notice.text}
          {notice.elsewhere && <> <Link to={`/submissions/${notice.elsewhere}`} className="font-bold underline">Open {notice.elsewhere}</Link></>}
        </Banner>
      )}
      <Issues issues={sub.capture_notes || []} className="" />

      <input ref={resumeInput} type="file" hidden accept={resumeTarget ? acceptFor(resumeTarget.kind) : ''} onChange={onResumeFile} data-testid="resume-input" />
      <Card className="p-5">
        <SectionTitle hint={VIDEO_HINT}>Game video</SectionTitle>
        <div className="flex flex-col gap-1">
          {videos.map(row)}
          {pending.filter(t => t.kind === 'video').map(t => <PendingRow key={t.key} t={t} now={now} kindLabel={viewLabel[t.view]} onDismiss={() => drop(t.key)}
            onRetry={() => start(filesRef.current[t.key], { kind: t.kind, cameraView: t.view, fileLabel: t.label, key: t.key })} canRetry={!!filesRef.current[t.key]} />)}
          {videos.length === 0 && !pending.some(t => t.kind === 'video') && (
            <p className="text-sm py-2" style={{ color: '#64748b' }}>No video yet.</p>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-3 items-end mt-4 pt-4 border-t" style={{ borderColor: '#1e3a5f' }}>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-bold" style={{ color: '#cfe8ff' }}>Camera angle</span>
            <Select value={view} onChange={e => setView(e.target.value)} data-testid="camera-view">
              {config.camera_views.map(v => <option key={v.key} value={v.key}>{v.label}</option>)}
            </Select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-bold" style={{ color: '#cfe8ff' }}>Label</span>
            <TextInput value={label} onChange={e => setLabel(e.target.value)} placeholder="Optional — e.g. Innings 1–4" maxLength={80} />
          </label>
          <PrimaryButton type="button" onClick={() => videoInput.current?.click()}>Choose video…</PrimaryButton>
          <input ref={videoInput} type="file" hidden multiple accept={acceptFor('video')} onChange={onVideos} data-testid="video-input" />
        </div>
      </Card>

      <Card className="p-5">
        <SectionTitle hint="Optional — each one helps us check or enrich the analysis.">Supporting files</SectionTitle>
        <div className="flex flex-col gap-3">
          {SUPPORTING.map(s => (
            <div key={s.kind}>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-sm font-bold text-white flex items-center gap-1.5 min-w-0">
                  {specs[s.kind].label}
                  <InfoTip label={`About ${specs[s.kind].label}`}>{s.help} Accepts {specs[s.kind].extensions.join(', ')}.</InfoTip>
                </p>
                <GhostButton type="button" onClick={() => supportInputs.current[s.kind]?.click()}>Add file…</GhostButton>
                <input ref={el => { supportInputs.current[s.kind] = el; }} type="file" hidden accept={acceptFor(s.kind)} onChange={onSupporting(s.kind)} data-testid={`input-${s.kind}`} />
              </div>
              {supporting.filter(f => f.kind === s.kind).map(row)}
              {pending.filter(t => t.kind === s.kind).map(t => <PendingRow key={t.key} t={t} now={now} kindLabel={specs[t.kind].label} onDismiss={() => drop(t.key)}
                onRetry={() => start(filesRef.current[t.key], { kind: t.kind, key: t.key })} canRetry={!!filesRef.current[t.key]} />)}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function TransferLine({ t, now }) {
  const elapsed = fmtElapsed(now - t.startedAt);
  if (t.phase === 'checking') return <p className="text-xs" style={{ color: '#94a3b8' }}>Reading the file… {elapsed}</p>;
  if (t.phase === 'uploading') {
    return (
      <div className="mt-1.5 flex flex-col gap-1">
        <ProgressBar pct={t.pct} />
        <p className="text-xs flex items-center gap-2 flex-wrap" style={{ color: '#94a3b8' }}>
          <span>{Math.round((t.pct || 0) * 100)}%{t.totalParts > 1 ? ` · part ${t.part} of ${t.totalParts}` : ''} · {elapsed}</span>
          {t.resumed && (
            <Tooltip content="Picking up where it stopped — finished parts are skipped.">
              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full" style={{ backgroundColor: 'rgba(56, 189, 248, 0.12)', color: '#38bdf8' }} data-testid="resumed">Resumed</span>
            </Tooltip>
          )}
        </p>
      </div>
    );
  }
  return null;
}

function FailureLine({ t, onRetry, canRetry }) {
  const why = [t.hint, t.resumable && 'Finished parts are kept.'].filter(Boolean).join(' ');
  return (
    <div className="mt-1.5 flex items-start gap-2 flex-wrap">
      <p className="text-xs flex items-center gap-1.5" style={{ color: '#f87171' }} data-testid="upload-error">
        {t.error}
        {why && <InfoTip label="Why this happens">{why}</InfoTip>}
      </p>
      {t.resumable && canRetry && <button type="button" onClick={onRetry} className="text-xs font-bold hover:underline cursor-pointer" style={{ color: '#38bdf8' }}>Retry</button>}
      {t.resumable && !canRetry && <span className="text-xs" style={{ color: '#94a3b8' }}>Choose the same file again to continue.</span>}
    </div>
  );
}

function FileRow({ file: f, transfer: t, viewLabel, kindLabel, now, onRetry, canRetry, onResume, onRemove }) {
  const inFlight = t && ['checking', 'uploading'].includes(t.phase);
  const failed = t?.phase === 'failed';
  const interrupted = !inFlight && UNFINISHED.includes(f.status);
  const status = inFlight ? 'Uploading' : interrupted ? 'Paused' : f.status_label;
  const tone = inFlight ? '#38bdf8' : TONE[f.status] || '#94a3b8';
  const title = f.kind === 'video' ? (f.label || viewLabel[f.camera_view] || 'Game video') : kindLabel;
  return (
    <div className="py-3 border-t first:border-t-0" style={{ borderColor: '#1e3a5f' }} data-testid={`file-${f.id}`} data-status={f.status}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-white truncate">
            {title}
            {f.kind === 'video' && f.label && viewLabel[f.camera_view] && f.label !== viewLabel[f.camera_view] && <span className="font-normal" style={{ color: '#94a3b8' }}> · {viewLabel[f.camera_view]}</span>}
          </p>
          <p className="text-xs truncate" style={{ color: '#64748b' }}>{f.original_name} · {fmtBytes(f.size_bytes)}{f.summary ? ` · ${f.summary}` : ''}</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {interrupted ? (
            <Tooltip content="Choose the same file again to continue — finished parts are kept.">
              <span className="text-xs font-bold" style={{ color: tone }}>{status}</span>
            </Tooltip>
          ) : <span className="text-xs font-bold" style={{ color: tone }}>{CHECKING.includes(f.status) ? 'Checking…' : status}</span>}
          {interrupted && !(failed && canRetry(t)) && <button type="button" onClick={onResume} className="text-xs font-bold hover:underline cursor-pointer" style={{ color: '#38bdf8' }}>Resume</button>}
          {!inFlight && !f.locked && <button type="button" onClick={onRemove} className="text-xs hover:underline cursor-pointer" style={{ color: '#64748b' }} aria-label={`Remove ${f.original_name}`}>Remove</button>}
        </div>
      </div>
      {inFlight && <TransferLine t={t} now={now} />}
      {failed && <FailureLine t={t} onRetry={() => onRetry(t)} canRetry={canRetry(t)} />}
      <Issues issues={f.issues || []} />
    </div>
  );
}

// A transfer the server has not got a row for yet (still reading or
// registering), or one that failed before it could register.
function PendingRow({ t, kindLabel, now, onDismiss, onRetry, canRetry }) {
  return (
    <div className="py-3 border-t first:border-t-0" style={{ borderColor: '#1e3a5f' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-white truncate">{t.label || kindLabel}</p>
          <p className="text-xs truncate" style={{ color: '#64748b' }}>{t.name} · {fmtBytes(t.size)}</p>
        </div>
        {t.phase === 'failed' && <button type="button" onClick={onDismiss} className="text-xs hover:underline cursor-pointer shrink-0" style={{ color: '#64748b' }}>Dismiss</button>}
      </div>
      {t.phase === 'failed' ? <FailureLine t={t} onRetry={onRetry} canRetry={canRetry} /> : <TransferLine t={t} now={now} />}
    </div>
  );
}
