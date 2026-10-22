// Command → Events: set up an event's public sign-up page (Pro Day, showcase,
// camp), share its link and QR code, and run check-in at the booth
// (server/eventRoutes.js; docs/COMMAND_OPS.md §3.23). Setup is for admin and
// fulfillment; any internal role can look at the desk.
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { Field, TextInput, Select, PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import { cardStyle } from '../../components/admin/theme';
import AccessPanel from '../../components/admin/AccessPanel';
import { InfoTip } from '../../components/Tooltip';
import EventDesk from './EventDesk';

const STATUS = {
  draft: { label: 'Draft', color: '#94a3b8' },
  open: { label: 'Open', color: '#4ade80' },
  closed: { label: 'Closed', color: '#fbbf24' },
  archived: { label: 'Archived', color: '#64748b' },
};
const publicUrl = (slug, src = '') => `${window.location.origin}/events/${slug}${src ? `?src=${encodeURIComponent(src)}` : ''}`;
const dayList = days => days.map(d => d.label).join(' · ');

export function EventsListPage() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', day1: '', day2: '', price: '75', teamPrice: '' });
  const [archived, setArchived] = useState(false);

  useEffect(() => { api.deskEvents(archived).then(setData).catch(err => setError(err.message)); }, [archived]);

  async function create(e) {
    e.preventDefault();
    setError('');
    const days = [form.day1, form.day2].filter(Boolean).map(date => ({ date }));
    try {
      const { event } = await api.commandCreateEvent({
        name: form.name, days, price_cents: Math.round(Number(form.price) * 100), event_type: 'pro_day',
        ...(form.teamPrice ? { team_price_cents: Math.round(Number(form.teamPrice) * 100) } : {}),
      });
      navigate(`/command/events/${event.id}?tab=setup`);
    } catch (err) { setError(err.message); }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Events</h1>
          <p className="text-sm" style={{ color: '#94a3b8' }}>Sign-up pages for Pro Days, showcases and camps, and check-in at the booth.</p>
        </div>
        {data?.can_manage && <PrimaryButton type="button" onClick={() => setCreating(c => !c)} data-testid="new-event">+ New event</PrimaryButton>}
      </div>
      <ErrorNote>{error}</ErrorNote>
      {creating && (
        <form onSubmit={create} className="rounded-2xl border p-5 mb-4 grid grid-cols-1 sm:grid-cols-5 gap-3 items-end" style={cardStyle} data-testid="new-event-form">
          <Field label="Event name"><TextInput value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Gobbler Pro Day" required /></Field>
          <Field label="Day"><TextInput type="date" value={form.day1} onChange={e => setForm(f => ({ ...f, day1: e.target.value }))} required /></Field>
          <Field label="Second day (optional)"><TextInput type="date" value={form.day2} onChange={e => setForm(f => ({ ...f, day2: e.target.value }))} /></Field>
          <Field label="Price ($ per player)"><TextInput type="number" min="1" step="1" value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))} required /></Field>
          <Field label="Team price ($, optional)"><TextInput type="number" min="1" step="1" value={form.teamPrice} onChange={e => setForm(f => ({ ...f, teamPrice: e.target.value }))} placeholder="900" data-testid="new-event-team-price" /></Field>
          <div className="sm:col-span-5 flex gap-2"><PrimaryButton type="submit">Create draft</PrimaryButton><GhostButton type="button" onClick={() => setCreating(false)}>Cancel</GhostButton></div>
        </form>
      )}
      <section className="rounded-2xl border overflow-hidden" style={cardStyle}>
        {!data ? <p className="p-5 text-sm" style={{ color: '#94a3b8' }}>Loading…</p> : data.events.length === 0 ? (
          <p className="p-5 text-sm" style={{ color: '#94a3b8' }}>No events yet.{data.can_manage ? ' Create one to get its sign-up page and QR code.' : ''}</p>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs uppercase tracking-wider" style={{ color: '#64748b' }}>
              <th className="px-5 py-2.5">Event</th><th className="px-5 py-2.5">Days</th><th className="px-5 py-2.5">Status</th><th className="px-5 py-2.5 text-right">Paid</th><th className="px-5 py-2.5 text-right">Checked in</th>
            </tr></thead>
            <tbody>
              {data.events.map(e => (
                <tr key={e.id} className="border-t cursor-pointer hover:bg-slate-800/40" style={{ borderColor: '#1e3a5f' }} onClick={() => navigate(`/command/events/${e.id}`)}>
                  <td className="px-5 py-3 font-bold text-white">{e.name}<span className="ml-2 text-xs font-normal" style={{ color: '#64748b' }}>{e.type_label}</span></td>
                  <td className="px-5 py-3" style={{ color: '#94a3b8' }}>{dayList(e.days)}</td>
                  <td className="px-5 py-3"><span className="text-xs font-bold" style={{ color: STATUS[e.status]?.color }}>{STATUS[e.status]?.label}{e.listed ? ' · listed' : ''}</span></td>
                  <td className="px-5 py-3 text-right tabular-nums" style={{ color: '#cfe8ff' }}>{e.counts.paid}</td>
                  <td className="px-5 py-3 text-right tabular-nums" style={{ color: '#cfe8ff' }}>{e.counts.checked_in}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <label className="inline-flex items-center gap-2 mt-3 text-xs cursor-pointer" style={{ color: '#64748b' }}>
        <input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)} /> Show archived
      </label>
    </div>
  );
}

export function EventPage() {
  const { eventId } = useParams();
  const [tab, setTab] = useState(() => new URLSearchParams(window.location.search).get('tab') === 'setup' ? 'setup' : 'desk');
  const [summary, setSummary] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { api.deskEvent(eventId).then(setSummary).catch(() => setSummary(null)); }, [eventId, tick]);
  const ev = summary?.event;
  return (
    <div>
      <div className="mb-4 print:hidden">
        <Link to="/command/events" className="text-xs hover:underline" style={{ color: '#64748b' }}>← All events</Link>
        <div className="flex flex-wrap items-center gap-3 mt-1">
          <h1 className="text-2xl font-bold text-white">{ev?.name || 'Event'}</h1>
          {ev && <span className="text-xs font-bold" style={{ color: STATUS[ev.status]?.color }} data-testid="event-status">{STATUS[ev.status]?.label}</span>}
        </div>
        {ev && <p className="text-sm" style={{ color: '#94a3b8' }}>{dayList(ev.days)}{ev.location ? ` · ${ev.location}` : ''} · <a href={`/events/${ev.slug}`} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: '#38bdf8' }}>/events/{ev.slug} ↗</a></p>}
        {summary?.actor.can_manage && (
          <div className="flex gap-1.5 mt-3">
            {[['desk', 'Check-in'], ['setup', 'Setup']].map(([k, label]) => (
              <button key={k} type="button" onClick={() => setTab(k)} aria-pressed={tab === k} className="px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer"
                style={tab === k ? { backgroundColor: '#38bdf8', color: '#06122b' } : { backgroundColor: 'rgba(30, 41, 59, 0.9)', color: '#94a3b8' }} data-testid={`tab-${k}`}>{label}</button>
            ))}
          </div>
        )}
      </div>
      {tab === 'setup' && summary?.actor.can_manage ? <EventSetup eventId={eventId} onSaved={() => setTick(t => t + 1)} /> : <EventDesk eventId={eventId} />}
    </div>
  );
}

function EventSetup({ eventId, onSaved }) {
  const [data, setData] = useState(null);
  const [f, setF] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [src, setSrc] = useState('');
  const [copied, setCopied] = useState(false);
  const onError = useCallback(msg => setError(msg), []);

  const fill = d => {
    setData(d);
    const e = d.event;
    setF({
      name: e.name, event_type: e.event_type, location: e.location, description: e.description, what_to_bring: e.what_to_bring,
      days: (e.days_raw || e.days).map(x => ({ date: x.date, label: x.label || '', capacity: x.capacity ?? '' })),
      allow_either: !!e.allow_either, price: String(e.price_cents / 100), opens_on: e.opens_on || '', closes_on: e.closes_on || '',
      tournament_id: e.tournament_id ? String(e.tournament_id) : '', consent_text: e.consent_text, slug: e.slug, listed: !!e.listed,
      team_price: e.team_price_cents != null ? String(e.team_price_cents / 100) : '', team_divisions: e.team_divisions || '', team_consent_text: e.team_consent_text || '',
    });
  };
  useEffect(() => { api.commandEventSetup(eventId).then(fill).catch(err => setError(err.message)); }, [eventId]);

  async function patch(body, message) {
    setError(''); setNotice('');
    try {
      await api.commandUpdateEvent(eventId, body);
      fill(await api.commandEventSetup(eventId));
      setNotice(message);
      onSaved();
    } catch (err) { setError(err.message); }
  }
  function saveDetails(e) {
    e.preventDefault();
    const { price, team_price, days, tournament_id, slug, listed: _listed, ...rest } = f;
    patch({
      ...rest, price_cents: Math.round(Number(price) * 100), tournament_id: tournament_id || null,
      team_price_cents: team_price === '' ? null : Math.round(Number(team_price) * 100),
      days: days.filter(d => d.date).map(d => ({ date: d.date, label: d.label, capacity: d.capacity === '' ? null : Number(d.capacity) })),
      ...(slug !== data.event.slug ? { slug } : {}),
    }, 'Saved');
  }
  async function downloadQr() {
    const QR = await import('qrcode');
    const url = await QR.toDataURL(publicUrl(data.event.slug, src), { margin: 2, width: 1024 });
    const a = document.createElement('a');
    a.href = url; a.download = `${data.event.slug}${src ? `-${src}` : ''}-qr.png`; a.click();
  }
  async function copyLink() {
    try { await navigator.clipboard.writeText(publicUrl(data.event.slug, src)); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError('Copy failed — select the link and copy it.'); }
  }

  if (!f) return error ? <ErrorNote>{error}</ErrorNote> : <p style={{ color: '#94a3b8' }}>Loading…</p>;
  const ev = data.event;
  const setK = k => e => setF(x => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const setDay = (i, k) => e => setF(x => ({ ...x, days: x.days.map((d, j) => (j === i ? { ...d, [k]: e.target.value } : d)) }));
  const statusActions = {
    draft: [['open', 'Open registration']],
    open: [['closed', 'Close registration'], ['draft', 'Back to draft']],
    closed: [['open', 'Reopen registration'], ['archived', 'Archive']],
    archived: [['closed', 'Restore']],
  }[ev.status] || [];

  return (
    <div data-testid="event-setup">
      <ErrorNote>{error}</ErrorNote>
      {notice && <p role="status" className="text-sm py-2 px-3 rounded-lg mb-3" style={{ backgroundColor: 'rgba(74, 222, 128, 0.12)', color: '#4ade80' }} data-testid="setup-notice">{notice}</p>}

      <section className="rounded-2xl border p-5 mb-4" style={cardStyle}>
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <h2 className="text-lg font-bold text-white" style={{ fontSize: '1.125rem', marginBottom: 0 }}>Sign-up page</h2>
          <span className="text-xs font-bold" style={{ color: STATUS[ev.status]?.color }}>{STATUS[ev.status]?.label}</span>
          <InfoTip label="About the statuses">Draft: only staff signed in to Command can see the page. Open: parents can register and pay. Closed: the page says registration is closed; walk-ups still work at the booth. Archived: hidden.</InfoTip>
          <div className="ml-auto flex flex-wrap gap-2">
            {statusActions.map(([to, label]) => (
              <GhostButton key={to} type="button" onClick={() => patch({ status: to }, `${label} — done`)} data-testid={`status-${to}`}
                style={to === 'open' ? { borderColor: '#166534', color: '#4ade80' } : {}}>{label}</GhostButton>
            ))}
            <GhostButton type="button" onClick={() => patch({ listed: !ev.listed }, ev.listed ? 'Unlisted — link only' : 'Listed on /events and its tournament page')} data-testid="toggle-listed">
              {ev.listed ? 'Listed ✓' : 'List publicly'}
            </GhostButton>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Public link"><TextInput readOnly value={publicUrl(ev.slug, src)} style={{ minWidth: 340 }} onFocus={e => e.target.select()} data-testid="public-link" /></Field>
          <Field label="Source tag (optional)" hint="Tells you which QR code drove a sign-up, e.g. flyer or booth. No personal details."><TextInput value={src} onChange={e => setSrc(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))} placeholder="flyer" style={{ width: 120 }} /></Field>
          <GhostButton type="button" onClick={copyLink}>{copied ? 'Copied ✓' : 'Copy link'}</GhostButton>
          <GhostButton type="button" onClick={downloadQr} data-testid="download-qr">Download QR</GhostButton>
          <a href={`/events/${ev.slug}`} target="_blank" rel="noreferrer" className="text-sm font-bold hover:underline pb-2" style={{ color: '#38bdf8' }}>Open page ↗</a>
        </div>
        {data.aliases.length > 0 && <p className="text-xs mt-2" style={{ color: '#64748b' }}>Old links that still open this page: {data.aliases.map(a => `/events/${a.slug}`).join(', ')}</p>}
      </section>

      <form onSubmit={saveDetails} className="rounded-2xl border p-5 mb-4 flex flex-col gap-4" style={cardStyle}>
        <div className="flex items-center justify-between"><h2 className="text-lg font-bold text-white" style={{ fontSize: '1.125rem', marginBottom: 0 }}>Details</h2><PrimaryButton type="submit" data-testid="save-event">Save</PrimaryButton></div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Field label="Name"><TextInput value={f.name} onChange={setK('name')} required /></Field>
          <Field label="Kind"><Select value={f.event_type} onChange={setK('event_type')}>{Object.entries(data.event_types).map(([k, label]) => <option key={k} value={k}>{label}</option>)}</Select></Field>
          <Field label="Location"><TextInput value={f.location} onChange={setK('location')} placeholder="Nebo View Baseball Complex · Field 4, 940 North 400 East, Nephi, Utah" /></Field>
          <Field label="Price ($ per player)"><TextInput type="number" min="1" step="0.01" value={f.price} onChange={setK('price')} required data-testid="event-price" /></Field>
          <Field label="Team price ($ per team, optional)" hint="Set it to let a coach register a whole team; blank: players only.">
            <TextInput type="number" min="1" step="0.01" value={f.team_price} onChange={setK('team_price')} placeholder="900" data-testid="event-team-price" />
          </Field>
          {f.team_price !== '' && (
            <Field label="Divisions (optional)" hint="Comma-separated. Teams pick one; blank lets them type theirs.">
              <TextInput value={f.team_divisions} onChange={setK('team_divisions')} placeholder="8U, 9U, 10U, 11U, 12U, 13U, 14U" data-testid="event-team-divisions" />
            </Field>
          )}
          <Field label="Registration opens (optional)"><TextInput type="date" value={f.opens_on} onChange={setK('opens_on')} /></Field>
          <Field label="Registration closes (optional)"><TextInput type="date" value={f.closes_on} onChange={setK('closes_on')} /></Field>
          <Field label="Tournament (optional)" hint="Listed events show a sign-up button on that tournament's page.">
            <Select value={f.tournament_id} onChange={setK('tournament_id')}><option value="">None</option>{data.tournaments.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
          </Field>
          <Field label="Link (/events/…)" hint="Changing it keeps the old link working."><TextInput value={f.slug} onChange={setK('slug')} /></Field>
        </div>
        <div>
          <p className="text-xs font-bold mb-2" style={{ color: '#cfe8ff' }}>Days</p>
          {f.days.map((d, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2 mb-2">
              <Field label="Date"><TextInput type="date" value={d.date} onChange={setDay(i, 'date')} required /></Field>
              <Field label="Label (optional)"><TextInput value={d.label} onChange={setDay(i, 'label')} placeholder="Thursday session" /></Field>
              <Field label="Limit (blank = none)"><TextInput type="number" min="1" value={d.capacity} onChange={setDay(i, 'capacity')} style={{ width: 110 }} data-testid={`day-limit-${i}`} /></Field>
              {f.days.length > 1 && <GhostButton type="button" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => setF(x => ({ ...x, days: x.days.filter((_, j) => j !== i) }))}>Remove</GhostButton>}
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-4">
            <GhostButton type="button" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => setF(x => ({ ...x, days: [...x.days, { date: '', label: '', capacity: '' }] }))}>+ Day</GhostButton>
            {f.days.length > 1 && <label className="inline-flex items-center gap-2 text-xs" style={{ color: '#cfe8ff' }}><input type="checkbox" checked={f.allow_either} onChange={setK('allow_either')} /> Offer “Either day”</label>}
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Description (optional)"><textarea value={f.description} onChange={setK('description')} rows={3} className="w-full rounded-lg border px-3 py-2 text-sm text-white" style={{ backgroundColor: 'rgba(30, 41, 59, 0.95)', borderColor: '#334155' }} /></Field>
          <Field label="What to bring (optional)"><textarea value={f.what_to_bring} onChange={setK('what_to_bring')} rows={3} className="w-full rounded-lg border px-3 py-2 text-sm text-white" style={{ backgroundColor: 'rgba(30, 41, 59, 0.95)', borderColor: '#334155' }} placeholder="Cleats, glove, water" /></Field>
        </div>
        <Field label="Consent statement" hint="Parents tick this to register; each registration keeps the version it agreed to.">
          <textarea value={f.consent_text} onChange={setK('consent_text')} rows={3} required className="w-full rounded-lg border px-3 py-2 text-sm text-white" style={{ backgroundColor: 'rgba(30, 41, 59, 0.95)', borderColor: '#334155' }} />
        </Field>
        {f.team_price !== '' && (
          <Field label="Team consent statement" hint="The coach or manager ticks this to register a team. Blank: the standard wording.">
            <textarea value={f.team_consent_text} onChange={setK('team_consent_text')} rows={3} className="w-full rounded-lg border px-3 py-2 text-sm text-white" style={{ backgroundColor: 'rgba(30, 41, 59, 0.95)', borderColor: '#334155' }} data-testid="event-team-consent" />
          </Field>
        )}
      </form>

      <AccessPanel kind="command/events" id={eventId} title="Booth logins" subtitle="Helpers who check players in at the booth. Each gets an invite link to set a password, and sees only this event's check-in list." onError={onError} />
    </div>
  );
}
