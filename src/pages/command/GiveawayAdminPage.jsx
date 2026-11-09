// Command → Events → Giveaway: the /giveaway page's entry window and drawing
// date (settings, not code), and its entries, refreshed while the page is
// open, with a CSV export (server/giveawayRoutes.js). Admin and fulfillment.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { Field, TextInput, PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import { cardStyle } from '../../components/admin/theme';
import { InfoTip } from '../../components/Tooltip';
import { giveawayStatus } from './giveawayStatus';

const POLL_MS = 15000;
const PUBLIC_URL = () => `${window.location.origin}/giveaway`;
const mt = (iso, opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', ...opts }).format(new Date(iso));
const whenMt = iso => (iso ? mt(iso, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : '');
const sqlTime = ts => (ts ? `${ts.replace(' ', 'T')}Z` : null);

export default function GiveawayAdminPage() {
  const [data, setData] = useState(null);
  const [f, setF] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [q, setQ] = useState('');
  const [copied, setCopied] = useState(false);

  const fillForm = g => setF({ opens_local: g.opens_local || '', closes_local: g.closes_local || '', drawing_on: g.drawing_on || '' });
  // Entries refresh while the page is open; the form is filled once, so an edit in progress survives a refresh.
  useEffect(() => {
    let live = true;
    const tick = refill => api.commandGiveaway()
      .then(d => { if (!live) return; setData(d); if (refill) fillForm(d.giveaway); })
      .catch(err => live && setError(err.message));
    tick(true);
    const t = setInterval(() => tick(false), POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, []);

  async function save(e) {
    e.preventDefault();
    setError(''); setNotice('');
    try {
      await api.commandSetGiveaway(f);
      const d = await api.commandGiveaway();
      setData(d); fillForm(d.giveaway);
      setNotice('Saved — the giveaway page and its official rules show the new dates now.');
    } catch (err) { setError(err.message); }
  }
  async function exportCsv() {
    try {
      const blob = await api.commandGiveawayCsv();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'diamond-metrics-giveaway-entries.csv';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (err) { setError(err.message); }
  }
  async function downloadQr() {
    const QR = await import('qrcode');
    const a = document.createElement('a');
    a.href = await QR.toDataURL(PUBLIC_URL(), { margin: 2, width: 1024 });
    a.download = 'giveaway-qr.png';
    a.click();
  }
  async function copyLink() {
    try { await navigator.clipboard.writeText(PUBLIC_URL()); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError('Copy failed — select the link and copy it.'); }
  }

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.entries || []).filter(e => !needle || [e.full_name, e.email, e.phone].some(v => String(v || '').toLowerCase().includes(needle)));
  }, [data, q]);

  if (!data || !f) return error ? <ErrorNote>{error}</ErrorNote> : <p style={{ color: '#94a3b8' }}>Loading…</p>;
  const g = data.giveaway;
  const status = giveawayStatus(g);
  const setK = k => e => setF(x => ({ ...x, [k]: e.target.value }));

  return (
    <div data-testid="giveaway-admin">
      <Link to="/command/events" className="text-xs hover:underline" style={{ color: '#64748b' }}>← All events</Link>
      <div className="flex flex-wrap items-center gap-3 mt-1 mb-1">
        <h1 className="text-2xl font-bold text-white">Giveaway</h1>
        <span className="text-xs font-bold" style={{ color: status.color }} data-testid="giveaway-status">{status.label}</span>
      </div>
      <p className="text-sm mb-4" style={{ color: '#94a3b8' }}>
        {g.opens_at ? `Opens ${whenMt(g.opens_at)}` : 'Open now'} · {g.closes_at ? `closes ${whenMt(g.closes_at)}` : 'no end'}
        {' · '}<a href="/giveaway" target="_blank" rel="noreferrer" className="hover:underline" style={{ color: '#38bdf8' }}>/giveaway ↗</a>
      </p>
      <ErrorNote>{error}</ErrorNote>
      {notice && <p role="status" className="text-sm py-2 px-3 rounded-lg mb-3" style={{ backgroundColor: 'rgba(74, 222, 128, 0.12)', color: '#4ade80' }}>{notice}</p>}

      <div className="grid lg:grid-cols-[minmax(0,1fr)_340px] gap-4 items-start">
        <section className="rounded-2xl border overflow-hidden" style={cardStyle} data-testid="giveaway-entries">
          <div className="flex flex-wrap items-center gap-3 px-5 py-4">
            <div className="mr-auto">
              <p className="text-2xl font-extrabold text-white leading-none tabular-nums" data-testid="giveaway-count">{data.counts.entries}</p>
              <p className="text-[10px] font-bold uppercase tracking-wider mt-1" style={{ color: '#64748b' }}>Entries{data.counts.last_24h ? ` · ${data.counts.last_24h} in the last day` : ''}</p>
            </div>
            <TextInput value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, email or phone" aria-label="Search entries" style={{ width: 240 }} />
            <GhostButton type="button" onClick={exportCsv} disabled={!data.entries.length}>Export CSV</GhostButton>
          </div>
          {rows.length === 0 ? (
            <p className="px-5 pb-5 text-sm" style={{ color: '#94a3b8' }}>{data.entries.length ? 'No one matches.' : 'No entries yet. They appear here as people enter.'}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs uppercase tracking-wider" style={{ color: '#64748b' }}>
                  <th className="px-5 py-2">Submitted</th><th className="px-5 py-2">Name</th><th className="px-5 py-2">Email</th><th className="px-5 py-2">Phone</th>
                </tr></thead>
                <tbody>
                  {rows.map(e => (
                    <tr key={e.id} className="border-t" style={{ borderColor: '#1e3a5f' }}>
                      <td className="px-5 py-2.5 whitespace-nowrap tabular-nums" style={{ color: '#94a3b8' }}>{whenMt(sqlTime(e.created_at))}</td>
                      <td className="px-5 py-2.5 font-bold text-white">{e.full_name}</td>
                      <td className="px-5 py-2.5" style={{ color: '#cfe8ff' }}>{e.email}</td>
                      <td className="px-5 py-2.5 whitespace-nowrap" style={{ color: '#cfe8ff' }}>{e.phone || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="flex flex-col gap-4">
          <form onSubmit={save} className="rounded-2xl border p-5 flex flex-col gap-3" style={cardStyle} data-testid="giveaway-settings">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-white" style={{ fontSize: '1.125rem', marginBottom: 0 }}>Entry window</h2>
              <InfoTip label="About the entry window">Mountain time. The entry page and its official rules show these dates, and entries outside them are refused. Leave Opens blank to open now, or Closes blank for no end.</InfoTip>
            </div>
            <Field label="Opens"><TextInput type="datetime-local" value={f.opens_local} onChange={setK('opens_local')} data-testid="giveaway-opens" /></Field>
            <Field label="Closes"><TextInput type="datetime-local" value={f.closes_local} onChange={setK('closes_local')} data-testid="giveaway-closes" /></Field>
            <Field label="Drawing date"><TextInput type="date" value={f.drawing_on} onChange={setK('drawing_on')} data-testid="giveaway-drawing" /></Field>
            <PrimaryButton type="submit" data-testid="giveaway-save">Save</PrimaryButton>
            {g.updated_at && <p className="text-[11px]" style={{ color: '#64748b' }}>Last changed {whenMt(sqlTime(g.updated_at))}</p>}
          </form>
          <section className="rounded-2xl border p-5 flex flex-col gap-2" style={cardStyle}>
            <h2 className="text-lg font-bold text-white" style={{ fontSize: '1.125rem', marginBottom: 0 }}>Share</h2>
            <TextInput readOnly value={PUBLIC_URL()} onFocus={e => e.target.select()} />
            <div className="flex flex-wrap gap-2">
              <GhostButton type="button" onClick={copyLink}>{copied ? 'Copied ✓' : 'Copy link'}</GhostButton>
              <GhostButton type="button" onClick={downloadQr}>Download QR</GhostButton>
              <a href="/giveaway/official-rules" target="_blank" rel="noreferrer" className="text-sm font-bold hover:underline self-center" style={{ color: '#38bdf8' }}>Official rules ↗</a>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
