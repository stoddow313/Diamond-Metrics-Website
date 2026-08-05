import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { Field, Select, PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import { cardStyle } from '../../components/admin/theme';

// Server-side imports (requirements §8): pick a kind, upload CSV/XLSX, review
// the dry-run plan (with duplicate resolution), then apply. Every apply is
// audited; errors are row-level and downloadable.

const ACTION_STYLES = {
  create: { color: '#4ade80', label: 'CREATE' },
  update: { color: '#38bdf8', label: 'UPDATE' },
  skip: { color: '#64748b', label: 'SKIP' },
  error: { color: '#f87171', label: 'ERROR' },
  needs_resolution: { color: '#fbbf24', label: 'RESOLVE' },
};

export default function AdminImportsPage() {
  const [kinds, setKinds] = useState([]);
  const [kind, setKind] = useState('');
  const [rows, setRows] = useState(null);
  const [filename, setFilename] = useState('');
  const [plan, setPlan] = useState(null);
  const [resolutions, setResolutions] = useState({});
  const [result, setResult] = useState(null);
  const [audits, setAudits] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    api.importKinds().then(d => { setKinds(d.kinds); setKind(k => k || d.kinds[0]?.key); }).catch(err => setError(err.message));
    api.importAudits().then(d => setAudits(d.audits)).catch(() => {});
  }, []);

  const kindDef = kinds.find(k => k.key === kind);

  function downloadTemplate() {
    const cols = kindDef.columns.filter(c => !c.startsWith('…'));
    const csv = cols.join(',') + '\n';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `diamond-metrics-${kind}-template.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setResult(null);
    setPlan(null);
    setResolutions({});
    setBusy(true);
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
      // dateNF keeps date cells as plain yyyy-mm-dd strings (no timezone drift)
      const parsed = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false, dateNF: 'yyyy-mm-dd' });
      if (!parsed.length) throw new Error('No data rows found in the file.');
      setRows(parsed);
      setFilename(file.name);
      const { plan } = await api.importPreview(kind, parsed);
      setPlan(plan);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function repreview(nextResolutions) {
    const { plan } = await api.importPreview(kind, rows, nextResolutions);
    setPlan(plan);
  }

  async function apply() {
    setBusy(true);
    setError('');
    try {
      const res = await api.importApply(kind, rows, resolutions, filename);
      if (res.blocked) {
        setPlan(res.plan);
        setError(res.message);
      } else {
        setResult(res);
        setPlan(null);
        setRows(null);
        api.importAudits().then(d => setAudits(d.audits)).catch(() => {});
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function downloadErrorReport() {
    const bad = plan.filter(p => p.action === 'error' || p.action === 'needs_resolution');
    const csv = ['row,action,message', ...bad.map(p => `${p.index + 2},${p.action},"${p.message.replace(/"/g, '""')}"`)].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `import-errors-${filename || kind}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const unresolved = plan ? plan.filter(p => p.action === 'needs_resolution' && !resolutions[p.index]).length : 0;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Imports</h1>
        <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>
          Upload CSV or XLSX, review the dry-run plan, resolve duplicates, then apply. Re-importing the same file is safe.
        </p>
      </div>

      <ErrorNote>{error}</ErrorNote>

      <section className="rounded-2xl border p-6 mb-6" style={cardStyle}>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="What are you importing?">
            <Select value={kind} onChange={e => { setKind(e.target.value); setPlan(null); setRows(null); setResult(null); }}>
              {kinds.map(k => <option key={k.key} value={k.key}>{k.label}</option>)}
            </Select>
          </Field>
          <GhostButton type="button" onClick={downloadTemplate} disabled={!kindDef}>Download template</GhostButton>
          <PrimaryButton type="button" disabled={busy || !kind} onClick={() => fileRef.current?.click()}>
            {busy ? 'Working…' : 'Choose file & preview'}
          </PrimaryButton>
          <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={handleFile} />
        </div>
        {kindDef && (
          <p className="text-xs mt-3" style={{ color: '#64748b' }}>
            Columns: {kindDef.columns.join(', ')} · required: {kindDef.required.join(', ')}
          </p>
        )}
      </section>

      {plan && (
        <section className="rounded-2xl border p-6 mb-6" style={cardStyle}>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-lg font-bold text-white">Preview — nothing applied yet</h2>
              <p className="text-xs" style={{ color: '#94a3b8' }}>
                {filename} · {plan.length} rows · {plan.filter(p => p.action === 'create').length} create,{' '}
                {plan.filter(p => p.action === 'update').length} update, {plan.filter(p => p.action === 'error').length} errors
                {unresolved > 0 && <b style={{ color: '#fbbf24' }}> · {unresolved} need duplicate resolution</b>}
              </p>
            </div>
            <div className="flex gap-2">
              {plan.some(p => p.action === 'error' || p.action === 'needs_resolution') && (
                <GhostButton type="button" onClick={downloadErrorReport}>Error report</GhostButton>
              )}
              <PrimaryButton type="button" disabled={busy || unresolved > 0} onClick={apply}
                title={unresolved > 0 ? 'Resolve flagged duplicates first' : undefined}>
                {busy ? 'Applying…' : 'Apply import'}
              </PrimaryButton>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[560px]">
              <thead>
                <tr className="text-left uppercase tracking-wider" style={{ color: '#64748b' }}>
                  <th className="py-2 pr-3">Row</th><th className="py-2 pr-3">Action</th><th className="py-2 pr-3">Details</th>
                </tr>
              </thead>
              <tbody>
                {plan.map(p => {
                  const style = ACTION_STYLES[p.action] || ACTION_STYLES.skip;
                  return (
                    <tr key={p.index} className="border-t align-top" style={{ borderColor: '#1e3a5f' }}>
                      <td className="py-2 pr-3" style={{ color: '#64748b' }}>{p.index + 2}</td>
                      <td className="py-2 pr-3"><span className="font-bold" style={{ color: style.color }}>{style.label}</span></td>
                      <td className="py-2 pr-3" style={{ color: '#cfe8ff' }}>
                        {p.message}
                        {p.action === 'needs_resolution' && (
                          <select
                            className="block mt-1.5 px-2 py-1.5 rounded-lg border text-xs"
                            style={{ backgroundColor: 'rgba(30,41,59,0.95)', borderColor: '#334155', color: '#fff' }}
                            value={resolutions[p.index] ? (resolutions[p.index].create ? '__create__' : String(resolutions[p.index].player_id)) : ''}
                            onChange={async e => {
                              const v = e.target.value;
                              const next = { ...resolutions };
                              if (!v) delete next[p.index];
                              else next[p.index] = v === '__create__' ? { create: true } : { player_id: Number(v) };
                              setResolutions(next);
                              await repreview(next);
                            }}
                          >
                            <option value="">Choose: link or create…</option>
                            {p.candidates?.map(c => (
                              <option key={c.id} value={c.id}>
                                Link to {c.name}{c.grad_year ? ` (class of ${c.grad_year})` : ''}{c.date_of_birth ? ` · DOB ${c.date_of_birth}` : ''}
                              </option>
                            ))}
                            <option value="__create__">Create as a new player</option>
                          </select>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {result && (
        <section className="rounded-2xl border p-6 mb-6" style={cardStyle}>
          <h2 className="text-lg font-bold mb-1" style={{ color: '#4ade80' }}>Import applied ✓</h2>
          <p className="text-sm" style={{ color: '#cfe8ff' }}>
            {result.counts.created} created · {result.counts.updated} updated · {result.counts.skipped} skipped ·{' '}
            <span style={{ color: result.counts.errors ? '#f87171' : '#cfe8ff' }}>{result.counts.errors} errors</span>
          </p>
        </section>
      )}

      <section className="rounded-2xl border p-6" style={cardStyle}>
        <h2 className="text-lg font-bold text-white mb-3">Import history</h2>
        {audits.length === 0 ? (
          <p className="text-sm" style={{ color: '#94a3b8' }}>No imports yet.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left uppercase tracking-wider" style={{ color: '#64748b' }}>
                <th className="py-2 pr-3">When</th><th className="py-2 pr-3">Kind</th><th className="py-2 pr-3">File</th>
                <th className="py-2 pr-3">By</th><th className="py-2 pr-3">Result</th>
              </tr>
            </thead>
            <tbody>
              {audits.map(a => (
                <tr key={a.id} className="border-t" style={{ borderColor: '#1e3a5f' }}>
                  <td className="py-2 pr-3" style={{ color: '#94a3b8' }}>{a.created_at}</td>
                  <td className="py-2 pr-3 font-bold text-white">{a.kind}</td>
                  <td className="py-2 pr-3" style={{ color: '#cfe8ff' }}>{a.filename || '—'}</td>
                  <td className="py-2 pr-3" style={{ color: '#94a3b8' }}>{a.uploader_email}</td>
                  <td className="py-2 pr-3" style={{ color: '#cfe8ff' }}>
                    {a.created_count}c / {a.updated_count}u / {a.skipped_count}s / <span style={{ color: a.error_count ? '#f87171' : '#64748b' }}>{a.error_count}e</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
