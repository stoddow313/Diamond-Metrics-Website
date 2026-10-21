// Public event registration (server/eventRoutes.js): the sign-up page a QR
// code opens, the confirmation Stripe returns to, and the list of open events.
// The browser sends the form only; the server decides the price and starts
// the Stripe Checkout for the saved registration.
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import MarketingLayout from '../../components/MarketingLayout';
import { api } from '../../lib/api';
import heroImage from '../../assets/find-your-player-hero.jpeg';
import '../FindYourPlayerPage.css';
import './EventPages.css';

const CHECKOUT_FAILED = 'We could not start secure checkout. Please try again.';
const CLOSED_COPY = {
  draft: 'Registration for this event has not opened yet.',
  not_open_yet: 'Registration for this event has not opened yet.',
  closed: 'Registration for this event is closed.',
  ended: 'This event has ended.',
  full: 'This event is full.',
};
const dollars = cents => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const emptyForm = { guardianName: '', email: '', phone: '', playerName: '', playerAge: '', playerTeam: '', preferredDay: '', consent: false };

// The form survives a canceled checkout in the same tab (never the browser's other tabs).
const savedKey = slug => `dm-event-form-${slug}`;
function loadSaved(slug) {
  try { const v = JSON.parse(sessionStorage.getItem(savedKey(slug)) || 'null'); return v && typeof v === 'object' ? { ...emptyForm, ...v, consent: false } : null; } catch { return null; }
}
function save(slug, form) { try { sessionStorage.setItem(savedKey(slug), JSON.stringify({ ...form, consent: false })); } catch { /* private mode */ } }
function forget(slug) { try { sessionStorage.removeItem(savedKey(slug)); } catch { /* private mode */ } }

function validate(form, event) {
  const e = {};
  if (!form.guardianName.trim()) e.guardianName = 'Enter the parent or guardian name.';
  if (!form.email.trim()) e.email = 'Enter an email address.';
  else if (!/^\S+@\S+\.\S+$/.test(form.email)) e.email = 'Enter a valid email address.';
  if (!form.playerName.trim()) e.playerName = 'Enter the player name.';
  const age = Number(form.playerAge);
  if (!String(form.playerAge).trim()) e.playerAge = 'Enter the player’s age.';
  else if (!Number.isInteger(age) || age < 4 || age > 25) e.playerAge = 'Enter the age in years.';
  if (!form.playerTeam.trim()) e.playerTeam = 'Enter the player’s team.';
  if (event.days.length > 1 && !form.preferredDay) e.preferredDay = 'Choose a day.';
  if (!form.consent) e.consent = 'Please agree to the consent statement.';
  return e;
}

export function EventSignupPage() {
  const { slug } = useParams();
  const [params] = useSearchParams();
  const cancelled = params.get('checkout') === 'cancelled';
  const source = params.get('src') || '';
  const [event, setEvent] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState(() => (cancelled && loadSaved(slug)) || emptyForm);
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.publicEvent(slug).then(d => {
      setEvent(d.event);
      // A renamed event's old link (a printed QR code) shows its current address.
      if (d.event.slug !== slug) window.history.replaceState(null, '', `/events/${d.event.slug}${window.location.search}`);
      if (d.event.days.length === 1) setForm(f => ({ ...f, preferredDay: d.event.days[0].date }));
    }).catch(err => setLoadError(err.status === 404 ? 'We couldn’t find that event.' : 'We couldn’t load this event. Please try again.'));
  }, [slug]);

  const set = e => {
    const { name, value, type, checked } = e.target;
    setForm(f => ({ ...f, [name]: type === 'checkbox' ? checked : value }));
    setErrors(x => ({ ...x, [name]: undefined }));
  };

  async function submit(e) {
    e.preventDefault();
    const next = validate(form, event);
    setErrors(next);
    if (Object.keys(next).length) return;
    setSubmitError(''); setBusy(true);
    try {
      const d = await api.registerForEvent(event.slug, { ...form, source });
      if (!d?.url) throw new Error(CHECKOUT_FAILED);
      save(event.slug, form);
      window.location.assign(d.url);
    } catch (err) {
      setSubmitError(err.message && !/Failed to fetch/.test(err.message) ? err.message : CHECKOUT_FAILED);
      setBusy(false);
    }
  }

  if (loadError) return <MarketingLayout contact={false}><section className="player-intake-page"><h1>Event not found</h1><p>{loadError}</p><Link className="player-intake-link" to="/events">See open events</Link></section></MarketingLayout>;
  if (!event) return <MarketingLayout contact={false}><section className="player-intake-page"><p>Loading…</p></section></MarketingLayout>;

  const price = dollars(event.price_cents);
  const choices = [...event.days.map(d => ({ value: d.date, label: d.label, full: d.full })), ...(event.either ? [{ value: 'either', label: 'Either day', full: false }] : [])];
  return (
    <MarketingLayout contact={false}>
      <section className="player-finder" aria-labelledby="event-title">
        {event.preview && <div className="player-finder-alert" role="status" data-testid="event-preview">Preview — this event is a draft. Only staff signed in to Command can see this page.</div>}
        {cancelled && <div className="player-finder-alert" role="status">Checkout was canceled. Your details are still here — agree to the consent statement and try again whenever you’re ready.</div>}
        <div className="player-finder-grid">
          <div className="player-finder-story">
            <div className="player-finder-image-wrap"><img src={heroImage} alt="Aerial view of a baseball diamond" className="player-finder-image" /><p className="player-finder-tag">{event.type_label}{event.tournament_name ? ` · ${event.tournament_name}` : ''}</p></div>
            <p className="player-finder-eyebrow">{event.type_label} registration</p>
            <h1 id="event-title">{event.name}</h1>
            {event.description && <p className="player-finder-intro">{event.description}</p>}
            <dl className="event-facts">
              <div><dt>When</dt><dd>{event.days.map(d => d.label).join(' · ')}</dd></div>
              {event.location && <div><dt>Where</dt><dd>{event.location}</dd></div>}
              <div><dt>Price</dt><dd>{price} per player</dd></div>
              {event.what_to_bring && <div><dt>Bring</dt><dd>{event.what_to_bring}</dd></div>}
            </dl>
          </div>
          {event.accepting ? (
            <form className="player-finder-card" onSubmit={submit} noValidate data-testid="event-form">
              <p className="player-finder-eyebrow">Reserve a spot</p><h2>Register</h2>
              <p className="player-finder-card-copy">One form per player. You’ll pay {price} on the next screen.</p>
              <div className="player-finder-fields">
                <Field label="Parent or Guardian Name" name="guardianName" value={form.guardianName} onChange={set} error={errors.guardianName} autoComplete="name" />
                <Field label="Email" name="email" type="email" value={form.email} onChange={set} error={errors.email} autoComplete="email" />
                <Field label="Phone" optional name="phone" type="tel" value={form.phone} onChange={set} autoComplete="tel" />
                <Field label="Player Name" name="playerName" value={form.playerName} onChange={set} error={errors.playerName} />
                <Field label="Player Age" name="playerAge" type="number" inputMode="numeric" min="4" max="25" value={form.playerAge} onChange={set} error={errors.playerAge} />
                <Field label="Player’s Team" name="playerTeam" value={form.playerTeam} onChange={set} error={errors.playerTeam} />
                {choices.length > 1 && (
                  <fieldset className="full event-days" aria-describedby={errors.preferredDay ? 'preferredDay-error' : undefined}>
                    <legend>Preferred day</legend>
                    <div className="event-day-options">
                      {choices.map(c => (
                        <label key={c.value} className={`event-day ${form.preferredDay === c.value ? 'is-selected' : ''} ${c.full ? 'is-full' : ''}`}>
                          <input type="radio" name="preferredDay" value={c.value} checked={form.preferredDay === c.value} onChange={set} disabled={c.full} />
                          <span>{c.label}</span>{c.full && <small>Full</small>}
                        </label>
                      ))}
                    </div>
                    {errors.preferredDay && <span className="player-finder-field-error" id="preferredDay-error">{errors.preferredDay}</span>}
                  </fieldset>
                )}
                <label className="full event-consent">
                  <span className="event-consent-row"><input type="checkbox" name="consent" checked={form.consent} onChange={set} aria-invalid={Boolean(errors.consent)} /><span>{event.consent_text}</span></span>
                  {errors.consent && <span className="player-finder-field-error">{errors.consent}</span>}
                </label>
              </div>
              {submitError && <p className="player-finder-checkout-error" role="alert">{submitError}</p>}
              <button className="player-finder-primary" type="submit" disabled={busy}>{busy ? 'Starting secure checkout…' : `Register & pay ${price}`}</button>
              <p className="player-finder-note">Payment is handled by Stripe. Your details are used to run the event and deliver your player’s results. <a href="/privacy">Privacy Policy</a></p>
            </form>
          ) : (
            <div className="player-finder-card" data-testid="event-closed">
              <p className="player-finder-eyebrow">Registration</p><h2>{event.reason === 'full' ? 'Full' : 'Closed'}</h2>
              <p className="player-finder-card-copy">{CLOSED_COPY[event.reason] || CLOSED_COPY.closed}{event.reason === 'closed' ? ' Walk-ups may still be welcome at the booth on the day.' : ''}</p>
            </div>
          )}
        </div>
      </section>
    </MarketingLayout>
  );
}

function Field({ label, optional, error, ...props }) {
  const errorId = `${props.name}-error`;
  return <label>{label} {optional && <span>(optional)</span>}<input {...props} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} />{error && <span className="player-finder-field-error" id={errorId}>{error}</span>}</label>;
}

// An all-day calendar entry for the chosen day (or the first day, for "Either").
function icsHref(event, registration) {
  const day = registration.day === 'either' ? event.days[0]?.date : registration.day;
  if (!day) return null;
  const d = day.replace(/-/g, '');
  const next = new Date(`${day}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
  const end = next.toISOString().slice(0, 10).replace(/-/g, '');
  const esc = s => String(s || '').replace(/[\\;,]/g, m => `\\${m}`).replace(/\n/g, '\\n');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Diamond Metrics//Events//EN', 'BEGIN:VEVENT',
    `UID:${registration.registration_id}@diamondmetrics.ai`, `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${end}`,
    `SUMMARY:${esc(event.name)}`, `LOCATION:${esc(event.location)}`, `DESCRIPTION:${esc(`Registration ${registration.registration_id}`)}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;
}

export function EventRegisteredPage() {
  const { slug } = useParams();
  const [params] = useSearchParams();
  const sessionId = params.get('session_id');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [waitedOut, setWaitedOut] = useState(false);

  useEffect(() => {
    if (!sessionId) return undefined;
    let tries = 0; let stop = false; let timer;
    const load = () => api.eventRegistrationBySession(sessionId).then(d => {
      if (stop) return;
      setData(d);
      if (d.registration.paid) forget(d.event.slug);
      // Stripe's confirmation usually lands within seconds of the redirect.
      else if (++tries < 15) timer = setTimeout(load, 2000);
      else setWaitedOut(true);
    }).catch(() => !stop && setError('We couldn’t find this registration. Keep your Stripe receipt — it has your payment details.'));
    load();
    return () => { stop = true; clearTimeout(timer); };
  }, [sessionId]);

  if (!sessionId || error) return <MarketingLayout contact={false}><section className="player-intake-page"><h1>Almost there</h1><p>{error || 'Please return from your Stripe confirmation page to see your registration.'}</p><Link className="player-intake-link" to={`/events/${slug}`}>Back to the event</Link></section></MarketingLayout>;
  if (!data) return <MarketingLayout contact={false}><section className="player-intake-page"><p>Loading…</p></section></MarketingLayout>;
  const { registration: r, event } = data;
  const ics = icsHref(event, r);
  return (
    <MarketingLayout contact={false}>
      <section className="player-intake-page" data-testid="event-registered">
        <p className="player-finder-eyebrow">{r.paid ? 'You’re registered' : 'Confirming your payment'}</p>
        <h1>{r.paid ? `See you there, ${r.player_first_name}.` : 'One moment…'}</h1>
        <p>{r.paid
          ? <>{event.name} · <strong>{r.day_label}</strong>{event.location ? <> · {event.location}</> : null}</>
          : waitedOut ? 'Stripe has your payment; your confirmation is on its way. Keep your registration number below.' : 'We’re waiting for Stripe to confirm your payment. This page updates on its own.'}</p>
        <div className="player-intake-order"><p className="player-finder-eyebrow">Registration number</p><p className="player-intake-order-id">{r.registration_id}</p></div>
        {event.what_to_bring && <p className="player-intake-next"><strong>Bring:</strong> {event.what_to_bring}</p>}
        <p className="player-intake-next">Stripe will email your receipt. Show your registration number or the player’s name at check-in.</p>
        {r.paid && ics && <a className="player-intake-link" href={ics} download={`${event.slug}.ics`}>Add to calendar</a>}
      </section>
    </MarketingLayout>
  );
}

export function EventsIndexPage() {
  const [events, setEvents] = useState(null);
  useEffect(() => { api.publicEvents().then(d => setEvents(d.events)).catch(() => setEvents([])); }, []);
  const open = useMemo(() => (events || []).filter(e => e.accepting), [events]);
  return (
    <MarketingLayout contact={false}>
      <section className="player-intake-page event-index">
        <p className="player-finder-eyebrow">Events</p>
        <h1>Upcoming events</h1>
        {events === null ? <p>Loading…</p> : open.length === 0 ? <p>No events are open for registration right now.</p> : (
          <div className="event-index-list">
            {open.map(e => (
              <Link key={e.slug} to={`/events/${e.slug}`} className="event-index-card">
                <span className="player-finder-eyebrow">{e.type_label}</span>
                <strong>{e.name}</strong>
                <span>{e.days.map(d => d.label).join(' · ')}{e.location ? ` · ${e.location}` : ''}</span>
                <span className="event-index-price">{dollars(e.price_cents)} · Register →</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </MarketingLayout>
  );
}
