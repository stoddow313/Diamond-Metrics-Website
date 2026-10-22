// The booth desk for one event (server/eventRoutes.js /api/desk/…): the live
// list of registrations, one-tap check-in, walk-ups, pay-by-QR and booth
// payment, CSV export and a printed roster. Used in Command and by booth
// logins (/staff/events/:id). Refreshes every few seconds; a check-in tap made
// while the connection is down is kept on this device and sent when it is back.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { Field, TextInput, Select, PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import { cardStyle } from '../../components/admin/theme';

const POLL_MS = 5000;
const dollars = cents => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const time = ts => (ts ? new Date(`${ts.replace(' ', 'T')}Z`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
const chip = active => (active ? { backgroundColor: '#38bdf8', color: '#06122b' } : { backgroundColor: 'rgba(30, 41, 59, 0.9)', color: '#94a3b8' });
// A registration's price: what it was quoted (older rows: the event's).
const priceOf = (event, r) => r?.price_cents ?? (r?.kind === 'team' ? event.team_price_cents : event.price_cents);
const nameOf = r => (r.kind === 'team' ? r.player_team : r.player_name);
const divisionsOf = event => String(event.team_divisions || '').split(',').map(d => d.trim()).filter(Boolean);

// Taps waiting to reach the server: { [registration_id]: true | false }.
const queueKey = id => `dm-desk-queue-${id}`;
const readQueue = id => { try { return JSON.parse(localStorage.getItem(queueKey(id)) || '{}'); } catch { return {}; } };
const writeQueue = (id, q) => { try { localStorage.setItem(queueKey(id), JSON.stringify(q)); } catch { /* storage off */ } };
const offline = err => !err?.status;   // a fetch that never got an answer

function QrImage({ url }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let live = true;
    import('qrcode').then(QR => QR.toDataURL(url, { margin: 1, width: 280 })).then(s => live && setSrc(s)).catch(() => {});
    return () => { live = false; };
  }, [url]);
  return src ? <img src={src} alt="QR code to pay on your phone" width={280} height={280} className="rounded-lg bg-white p-2" /> : <div style={{ width: 280, height: 280 }} />;
}

export default function EventDesk({ eventId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [day, setDay] = useState('all');
  const [queue, setQueue] = useState(() => readQueue(eventId));
  const [walkUp, setWalkUp] = useState(false);
  const [qr, setQr] = useState(null);         // { url, rid }
  const [paying, setPaying] = useState(null); // registration_id being marked paid at the booth
  const [live, setLive] = useState(true);
  const queueRef = useRef(queue);
  useEffect(() => { queueRef.current = queue; }, [queue]);

  const load = useCallback(async () => {
    try {
      const d = await api.deskEvent(eventId);
      setData(d); setLive(true); setError('');
    } catch (err) {
      if (offline(err)) setLive(false); else setError(err.message);
    }
  }, [eventId]);

  // Send queued taps, then refresh.
  const flush = useCallback(async () => {
    const pending = Object.entries(queueRef.current);
    for (const [rid, checked] of pending) {
      try {
        await api.deskCheckIn(rid, checked);
      } catch (err) {
        if (offline(err)) return;   // still down: keep the rest for next time
        setError(err.message);
      }
      const next = { ...queueRef.current }; delete next[rid];
      queueRef.current = next;
      writeQueue(eventId, next); setQueue(next);
    }
  }, [eventId]);

  useEffect(() => {
    const refresh = () => { flush().then(load); };
    refresh();
    const t = setInterval(refresh, POLL_MS);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(t); window.removeEventListener('focus', refresh); };
  }, [load, flush]);

  async function toggleCheckIn(r) {
    const next = !r.checked;
    try {
      await api.deskCheckIn(r.registration_id, next);
      await load();
    } catch (err) {
      if (!offline(err)) return setError(err.message);
      const qd = { ...queueRef.current, [r.registration_id]: next };
      queueRef.current = qd;
      writeQueue(eventId, qd); setQueue(qd); setLive(false);
    }
  }

  async function payLink(r) {
    setError('');
    try { const d = await api.deskPayLink(r.registration_id); setQr({ url: d.url, rid: r.registration_id }); }
    catch (err) { setError(err.message); }
  }

  async function exportCsv() {
    try {
      const blob = await api.deskRosterCsv(eventId);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${data.event.slug}-roster.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (err) { setError(err.message); }
  }

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.registrations.map(r => ({ ...r, rid: r.registration_id, checked: r.registration_id in queue ? queue[r.registration_id] : !!r.checked_in_at, queued: r.registration_id in queue }))
      .filter(r => !needle || [r.player_name, r.guardian_name, r.player_team, r.division, r.registration_id, r.email].some(v => String(v || '').toLowerCase().includes(needle)))
      .filter(r => day === 'all' || r.preferred_day === day)
      .filter(r => (filter === 'all' ? true : filter === 'unpaid' ? r.status !== 'paid' : filter === 'in' ? r.checked : r.status === 'paid' && !r.checked));
  }, [data, q, filter, day, queue]);

  if (error && !data) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <p style={{ color: '#94a3b8' }}>Loading…</p>;
  const { event, counts, actor } = data;
  const canAct = actor.can_act;
  const qrReg = qr && data.registrations.find(r => r.registration_id === qr.rid);
  const qrPaid = qrReg?.status === 'paid';
  const teams = event.team_price_cents != null || counts.teams > 0;
  const queued = Object.keys(queue).length;

  return (
    <div data-testid="event-desk">
      <div className="flex flex-wrap items-center gap-3 mb-4 print:hidden">
        {[['Registered', counts.registered], ['Paid', counts.paid], ['Checked in', counts.checked_in], ['Walk-ups', counts.walk_ups], ...(teams ? [['Teams', counts.teams]] : [])].map(([label, n]) => (
          <div key={label} className="rounded-xl border px-4 py-2 text-center min-w-[96px]" style={cardStyle}>
            <p className="text-2xl font-extrabold text-white leading-none tabular-nums" data-testid={`count-${label.toLowerCase().replace(' ', '-')}`}>{n}</p>
            <p className="text-[10px] font-bold uppercase tracking-wider mt-1" style={{ color: '#64748b' }}>{label}</p>
          </div>
        ))}
        <span className="text-xs" style={{ color: live ? '#4ade80' : '#fbbf24' }} data-testid="desk-live">
          {live ? '● Live' : '● Offline — check-ins are saved on this device'}{queued ? ` · ${queued} to send` : ''}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          {canAct && <PrimaryButton type="button" onClick={() => setWalkUp(w => !w)} data-testid="add-walk-up">+ Walk-up</PrimaryButton>}
          <GhostButton type="button" onClick={exportCsv}>Export CSV</GhostButton>
          <GhostButton type="button" onClick={() => window.print()}>Print roster</GhostButton>
        </div>
      </div>
      <ErrorNote>{error}</ErrorNote>
      {notice && <p role="status" className="text-sm py-2 px-3 rounded-lg mb-3 print:hidden" style={{ backgroundColor: 'rgba(74, 222, 128, 0.12)', color: '#4ade80' }}>{notice}</p>}
      {walkUp && <WalkUpForm data={data} onDone={(msg, created) => { setWalkUp(false); if (msg) setNotice(msg); if (created?.url) setQr({ url: created.url, rid: created.registration.registration_id }); load(); }} />}

      <div className="flex flex-wrap items-center gap-2 mb-3 print:hidden">
        <TextInput value={q} onChange={e => setQ(e.target.value)} placeholder={teams ? 'Search player, team, parent, coach or number' : 'Search player, parent, team or number'} aria-label="Search" style={{ minWidth: 260, flex: '1 1 260px' }} data-testid="desk-search" />
        {[['all', 'All'], ['not_in', 'Not checked in'], ['in', 'Checked in'], ['unpaid', 'Unpaid']].map(([k, label]) => (
          <button key={k} type="button" onClick={() => setFilter(k)} aria-pressed={filter === k} className="px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer" style={chip(filter === k)}>{label}</button>
        ))}
        {event.days.length > 1 && (
          <Select value={day} onChange={e => setDay(e.target.value)} aria-label="Day" style={{ width: 'auto' }}>
            <option value="all">All days</option>
            {event.days.map(d => <option key={d.date} value={d.date}>{d.label}</option>)}
            <option value="either">Either day</option>
          </Select>
        )}
      </div>

      <section className="rounded-2xl border print:hidden" style={cardStyle}>
        {rows.length === 0 ? <p className="p-5 text-sm" style={{ color: '#94a3b8' }}>{data.registrations.length ? 'No one matches.' : 'No registrations yet.'}</p> : rows.map(r => (
          <div key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3 border-t first:border-t-0" style={{ borderColor: '#1e3a5f' }} data-testid={`reg-${r.registration_id}`}>
            <button type="button" disabled={!canAct || r.status !== 'paid'} onClick={() => toggleCheckIn(r)}
              className="w-[118px] min-h-[44px] rounded-xl font-bold text-sm cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
              style={r.checked ? { backgroundColor: 'rgba(74, 222, 128, 0.16)', color: '#4ade80', border: '1px solid #166534' } : { backgroundColor: '#38bdf8', color: '#06122b' }}
              title={r.status !== 'paid' ? 'Take payment first' : r.checked ? 'Tap to undo' : 'Check in'} data-testid={`check-in-${r.registration_id}`}>
              {r.checked ? `✓ ${r.queued ? 'Saved' : time(r.checked_in_at)}` : 'Check in'}
            </button>
            <div className="min-w-[180px] flex-1">
              {r.kind === 'team' ? (
                <p className="font-bold text-white">{r.player_team} <span className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider align-middle" style={{ backgroundColor: 'rgba(245, 184, 61, 0.16)', color: '#f5b83d' }}>Team</span> <span className="font-normal text-xs" style={{ color: '#94a3b8' }}>{r.team_size} players{r.division ? ` · ${r.division}` : ''}</span></p>
              ) : (
                <p className="font-bold text-white">{r.player_name} <span className="font-normal text-xs" style={{ color: '#94a3b8' }}>{r.player_age ? `${r.player_age} · ` : ''}{r.player_team}</span></p>
              )}
              <p className="text-xs" style={{ color: '#64748b' }}>{r.kind === 'team' ? 'Coach ' : ''}{r.guardian_name}{r.phone ? ` · ${r.phone}` : ''} · {r.registration_id}{r.walk_up ? ' · walk-up' : ''}</p>
            </div>
            <span className="text-xs font-bold w-[96px]" style={{ color: '#cfe8ff' }}>{r.day_label}</span>
            {r.status === 'paid' ? (
              <span className="text-xs font-bold w-[120px]" style={{ color: '#4ade80' }} title={r.paid_note || undefined}>Paid · {r.payment_label}</span>
            ) : (
              <span className="flex flex-wrap items-center gap-1.5 w-full sm:w-auto">
                <span className="text-xs font-bold" style={{ color: '#fbbf24' }}>Unpaid</span>
                {canAct && <GhostButton type="button" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => payLink(r)} data-testid={`pay-qr-${r.registration_id}`}>Pay by QR</GhostButton>}
                {canAct && <GhostButton type="button" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => setPaying(paying === r.registration_id ? null : r.registration_id)}>Paid at booth</GhostButton>}
              </span>
            )}
            {paying === r.registration_id && <BoothPayment data={data} rid={r.registration_id} onDone={msg => { setPaying(null); if (msg) setNotice(msg); load(); }} />}
          </div>
        ))}
      </section>

      {/* Paper backup: every registration, a box to tick. */}
      <div className="hidden print:block">
        <h1 style={{ fontSize: 18, fontWeight: 700 }}>{event.name} — roster</h1>
        <p style={{ fontSize: 11 }}>{event.days.map(d => d.label).join(' · ')} · printed {new Date().toLocaleString()}</p>
        <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse', marginTop: 8 }}>
          <thead><tr>{['In', 'Player', 'Age', 'Team', 'Day', 'Parent / phone', 'Paid', 'No.'].map(hd => <th key={hd} style={{ textAlign: 'left', borderBottom: '1px solid #000', padding: '4px 6px' }}>{hd}</th>)}</tr></thead>
          <tbody>{[...data.registrations].sort((a, b) => nameOf(a).localeCompare(nameOf(b))).map(r => (
            <tr key={r.id}><td style={{ padding: '4px 6px', borderBottom: '1px solid #ccc' }}>{r.checked_in_at ? '✓' : '☐'}</td><td style={{ padding: '4px 6px', borderBottom: '1px solid #ccc' }}>{r.kind === 'team' ? `TEAM · ${r.team_size} players` : r.player_name}</td><td style={{ padding: '4px 6px', borderBottom: '1px solid #ccc' }}>{r.kind === 'team' ? r.division : r.player_age}</td><td style={{ padding: '4px 6px', borderBottom: '1px solid #ccc' }}>{r.player_team}</td><td style={{ padding: '4px 6px', borderBottom: '1px solid #ccc' }}>{r.day_label}</td><td style={{ padding: '4px 6px', borderBottom: '1px solid #ccc' }}>{r.guardian_name}{r.phone ? ` · ${r.phone}` : ''}</td><td style={{ padding: '4px 6px', borderBottom: '1px solid #ccc' }}>{r.status === 'paid' ? r.payment_label : 'UNPAID'}</td><td style={{ padding: '4px 6px', borderBottom: '1px solid #ccc' }}>{r.registration_id}</td></tr>
          ))}</tbody>
        </table>
      </div>

      {qr && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 print:hidden" style={{ backgroundColor: 'rgba(2, 6, 23, 0.8)' }} role="dialog" aria-label="Pay by QR" data-testid="pay-qr-dialog">
          <div className="rounded-2xl border p-6 flex flex-col items-center gap-3 text-center" style={{ ...cardStyle, backgroundColor: '#0b1528' }}>
            {qrPaid ? <p className="text-2xl font-extrabold" style={{ color: '#4ade80' }} data-testid="pay-qr-paid">Paid ✓</p> : <QrImage url={qr.url} />}
            <p className="text-sm text-white font-bold">{qrPaid ? 'Payment confirmed — check them in.' : `Scan to pay ${dollars(priceOf(event, qrReg))} on your phone`}</p>
            {!qrPaid && <p className="text-xs" style={{ color: '#94a3b8' }}>This turns to Paid by itself once Stripe confirms.</p>}
            <GhostButton type="button" onClick={() => setQr(null)}>Close</GhostButton>
          </div>
        </div>
      )}
    </div>
  );
}

function BoothPayment({ data, rid, onDone }) {
  const [method, setMethod] = useState(data.booth_methods[0].key);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  async function save() {
    try { await api.deskBoothPayment(rid, method, note); onDone(`Marked paid (${data.booth_methods.find(m => m.key === method).label}).`); }
    catch (err) { setError(err.message); }
  }
  return (
    <div className="w-full flex flex-wrap items-end gap-2 pt-2">
      <Field label="How they paid"><Select value={method} onChange={e => setMethod(e.target.value)} style={{ width: 'auto' }}>{data.booth_methods.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}</Select></Field>
      <Field label="Note (optional)"><TextInput value={note} onChange={e => setNote(e.target.value)} placeholder="$75 cash" /></Field>
      <PrimaryButton type="button" onClick={save}>Mark paid</PrimaryButton>
      <GhostButton type="button" onClick={() => onDone('')}>Cancel</GhostButton>
      {error && <span className="text-xs" style={{ color: '#f87171' }}>{error}</span>}
    </div>
  );
}

const emptyWalkUp = { kind: 'player', guardianName: '', email: '', phone: '', playerName: '', playerAge: '', playerTeam: '', coachName: '', teamName: '', teamSize: '', division: '', preferredDay: '', consent: false, payment: 'qr', note: '' };

function WalkUpForm({ data, onDone }) {
  const { event, availability } = data;
  const [f, setF] = useState(() => ({ ...emptyWalkUp, preferredDay: event.days.length === 1 ? event.days[0].date : '' }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = k => e => setF(x => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  async function save(e) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      const d = await api.deskWalkUp(event.id, f);
      const who = f.kind === 'team' ? f.teamName : f.playerName;
      onDone(d.url ? `${who} added — waiting for payment.` : `${who} added and marked paid.`, d);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const days = availability.days;
  const teamOn = event.team_price_cents != null;
  const team = teamOn && f.kind === 'team';
  const divisions = divisionsOf(event);
  const price = dollars(team ? event.team_price_cents : event.price_cents);
  return (
    <form onSubmit={save} className="rounded-2xl border p-4 mb-4 flex flex-col gap-3 print:hidden" style={{ ...cardStyle, borderColor: '#38bdf8' }} data-testid="walk-up-form">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-bold text-white mr-2">Walk-up registration</p>
        {teamOn && [['player', 'Player'], ['team', 'Team']].map(([k, label]) => (
          <button key={k} type="button" onClick={() => setF(x => ({ ...x, kind: k, consent: false }))} aria-pressed={f.kind === k}
            className="px-3 py-1 rounded-lg text-xs font-bold cursor-pointer" style={chip(f.kind === k)} data-testid={`walk-up-as-${k}`}>{label}</button>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {team ? (
          <>
            <Field label="Coach or manager"><TextInput value={f.coachName} onChange={set('coachName')} required /></Field>
            <Field label="Email (for the receipt)"><TextInput type="email" value={f.email} onChange={set('email')} required /></Field>
            <Field label="Phone (optional)"><TextInput type="tel" value={f.phone} onChange={set('phone')} /></Field>
            <Field label="Team name"><TextInput value={f.teamName} onChange={set('teamName')} required /></Field>
            <Field label="Players"><TextInput type="number" min="1" max="60" value={f.teamSize} onChange={set('teamSize')} required /></Field>
            <Field label="Division / age group">
              {divisions.length
                ? <Select value={f.division} onChange={set('division')} required><option value="">—</option>{divisions.map(d => <option key={d} value={d}>{d}</option>)}</Select>
                : <TextInput value={f.division} onChange={set('division')} placeholder="12U" required />}
            </Field>
          </>
        ) : (
          <>
            <Field label="Parent or guardian"><TextInput value={f.guardianName} onChange={set('guardianName')} required /></Field>
            <Field label="Email (for the receipt)"><TextInput type="email" value={f.email} onChange={set('email')} required /></Field>
            <Field label="Phone (optional)"><TextInput type="tel" value={f.phone} onChange={set('phone')} /></Field>
            <Field label="Player"><TextInput value={f.playerName} onChange={set('playerName')} required /></Field>
            <Field label="Age"><TextInput type="number" min="4" max="25" value={f.playerAge} onChange={set('playerAge')} required /></Field>
            <Field label="Team"><TextInput value={f.playerTeam} onChange={set('playerTeam')} required /></Field>
          </>
        )}
        {days.length > 1 && (
          <Field label="Day">
            <Select value={f.preferredDay} onChange={set('preferredDay')} required>
              <option value="">—</option>
              {days.map(d => <option key={d.date} value={d.date} disabled={d.full}>{d.label}{d.full ? ' (full)' : ''}</option>)}
              {availability.either && <option value="either">Either day</option>}
            </Select>
          </Field>
        )}
        <Field label="Payment">
          <Select value={f.payment} onChange={set('payment')} data-testid="walk-up-payment">
            <option value="qr">Pay by QR on their phone ({price})</option>
            {data.booth_methods.map(m => <option key={m.key} value={m.key}>{m.label} at the booth</option>)}
          </Select>
        </Field>
        {f.payment !== 'qr' && <Field label="Note (optional)"><TextInput value={f.note} onChange={set('note')} placeholder={`${price} cash`} /></Field>}
      </div>
      <label className="flex items-start gap-2 text-xs" style={{ color: '#cfe8ff' }}>
        <input type="checkbox" checked={f.consent} onChange={set('consent')} className="mt-0.5" data-testid="walk-up-consent" />
        <span><b>{team ? 'The coach or manager agreed:' : 'The parent or guardian agreed:'}</b> {team ? event.team_consent_text : event.consent_text}</span>
      </label>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex gap-2">
        <PrimaryButton type="submit" disabled={busy}>{f.payment === 'qr' ? 'Add and show pay QR' : 'Add and mark paid'}</PrimaryButton>
        <GhostButton type="button" onClick={() => onDone('')}>Cancel</GhostButton>
      </div>
    </form>
  );
}
