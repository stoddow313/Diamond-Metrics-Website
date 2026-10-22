// Public event registration (server/eventRoutes.js): the sign-up page a QR
// code opens, the confirmation Stripe returns to, and the list of open events.
// The browser sends the form only; the server decides the price and starts
// the Stripe Checkout for the saved registration. An event with a team price
// also takes a whole team on one form, from its coach or manager.
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import MarketingLayout from '../../components/MarketingLayout';
import { api } from '../../lib/api';
import heroImage from '../../assets/pro-day-hero.jpg';
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

// The Pro Day page's own copy (Will's Pro Day page, 2026-10): shown on every
// Pro Day event, beside what the event's setup says (name, dates, place, price).
const PRO_DAY = {
  tagline: 'Get real MLB-level metrics. See where your game stands.',
  tools: [
    { number: '01', name: 'Hitting', summary: 'See how your contact, power, and batted-ball direction come together.', metrics: ['Maximum and average exit velocity', 'Hard-hit rate', 'Spray chart', 'Launch angle'] },
    { number: '02', name: 'Running', summary: 'Measure your speed over short and longer distances.', metrics: ['Home-to-first splits', '60-yard dash'] },
    { number: '03', name: 'Pitching', summary: 'Get a snapshot of velocity, strike throwing, and command.', metrics: ['Maximum and average velocity', 'Strike percentage', 'Command and accuracy'] },
    { number: '04', name: 'Fielding', summary: 'Measure throwing strength and how cleanly you field the ball.', metrics: ['Arm strength: shortstop to first and/or right field to third', 'Fielding percentage'] },
    { number: '05', name: 'Catchers', summary: 'Measure quickness behind the plate and throwing strength.', metrics: ['Pop time', 'Catcher arm strength'] },
  ],
};

// "November 6–7, 2026" for back-to-back days in one month; otherwise each day.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function dateRange(days) {
  const parts = days.map(d => d.date.split('-').map(Number));
  if (!parts.length) return '';
  const [y, m, d0] = parts[0];
  const sameMonth = parts.every(([yy, mm]) => yy === y && mm === m);
  const consecutive = parts.every(([, , dd], i) => dd === d0 + i);
  if (parts.length === 1) return `${MONTHS[m - 1]} ${d0}, ${y}`;
  if (sameMonth && consecutive) return `${MONTHS[m - 1]} ${d0}–${parts.at(-1)[2]}, ${y}`;
  return days.map(d => d.label).join(' · ');
}
// "Nebo View Baseball Complex · Field 4, 940 North 400 East, Nephi, Utah" → the venue, then the address.
function splitLocation(location = '') {
  const i = location.indexOf(',');
  return i < 0 ? [location.trim(), ''] : [location.slice(0, i).trim(), location.slice(i + 1).trim()];
}
const emptyForm = { kind: 'player', guardianName: '', email: '', phone: '', playerName: '', playerAge: '', playerTeam: '', coachName: '', teamName: '', teamSize: '', division: '', preferredDay: '', consent: false };

// The form survives a canceled checkout in the same tab (never the browser's other tabs).
const savedKey = slug => `dm-event-form-${slug}`;
function loadSaved(slug) {
  try { const v = JSON.parse(sessionStorage.getItem(savedKey(slug)) || 'null'); return v && typeof v === 'object' ? { ...emptyForm, ...v, consent: false } : null; } catch { return null; }
}
function save(slug, form) { try { sessionStorage.setItem(savedKey(slug), JSON.stringify({ ...form, consent: false })); } catch { /* private mode */ } }
function forget(slug) { try { sessionStorage.removeItem(savedKey(slug)); } catch { /* private mode */ } }

function validate(form, event) {
  const e = {};
  if (!form.email.trim()) e.email = 'Enter an email address.';
  else if (!/^\S+@\S+\.\S+$/.test(form.email)) e.email = 'Enter a valid email address.';
  if (form.kind === 'team') {
    if (!form.coachName.trim()) e.coachName = 'Enter the coach or manager name.';
    if (!form.teamName.trim()) e.teamName = 'Enter the team name.';
    const size = Number(form.teamSize);
    if (!String(form.teamSize).trim()) e.teamSize = 'Enter the number of players.';
    else if (!Number.isInteger(size) || size < 1 || size > event.team.max_size) e.teamSize = `Enter 1 to ${event.team.max_size} players.`;
    if (!form.division.trim()) e.division = 'Choose the division or age group.';
  } else {
    if (!form.guardianName.trim()) e.guardianName = 'Enter the parent or guardian name.';
    if (!form.playerName.trim()) e.playerName = 'Enter the player name.';
    const age = Number(form.playerAge);
    if (!String(form.playerAge).trim()) e.playerAge = 'Enter the player’s age.';
    else if (!Number.isInteger(age) || age < 4 || age > 25) e.playerAge = 'Enter the age in years.';
    if (!form.playerTeam.trim()) e.playerTeam = 'Enter the player’s team.';
  }
  if (event.days.length > 1 && !form.preferredDay) e.preferredDay = 'Choose a day.';
  if (!form.consent) e.consent = 'Please agree to the consent statement.';
  return e;
}

export function EventSignupPage() {
  const { slug } = useParams();
  const [params] = useSearchParams();
  const cancelled = params.get('checkout') === 'cancelled';
  const source = params.get('src') || '';
  const asTeam = params.get('as') === 'team';
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
      // ?as=team opens the team form (a coach's link); an event without a team price has none.
      setForm(f => ({ ...f, kind: d.event.team && (f.kind === 'team' || asTeam) ? 'team' : 'player' }));
      if (cancelled) requestAnimationFrame(() => document.getElementById('event-signup')?.scrollIntoView());
    }).catch(err => setLoadError(err.status === 404 ? 'We couldn’t find that event.' : 'We couldn’t load this event. Please try again.'));
  }, [slug, cancelled, asTeam]);

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
  const teamPrice = event.team ? dollars(event.team.price_cents) : null;
  const team = form.kind === 'team' && !!event.team;
  const due = team ? teamPrice : price;
  const pick = kind => { setForm(f => ({ ...f, kind, consent: false })); setErrors({}); setSubmitError(''); };
  const choices = [...event.days.map(d => ({ value: d.date, label: d.label, full: d.full })), ...(event.either ? [{ value: 'either', label: 'Either day', full: false }] : [])];
  const proDay = event.event_type === 'pro_day';
  const dates = dateRange(event.days);
  const [venue, address] = splitLocation(event.location);
  // "Gobbler Last Chance Tournament · Field 4": the tournament, then the venue's last part ("… · Field 4").
  const field = venue.includes(' · ') ? venue.split(' · ').at(-1) : '';
  const eyebrow = [event.tournament_name || event.type_label, field].filter(Boolean).join(' · ');
  return (
    <MarketingLayout contact={false}>
      <div className="ep-page">
        {event.preview && <div className="player-finder-alert" role="status" data-testid="event-preview">Preview — this event is a draft. Only staff signed in to Command can see this page.</div>}
        {cancelled && <div className="player-finder-alert" role="status">Checkout was canceled. Your details are still here — agree to the consent statement and try again whenever you’re ready.</div>}
        <section className="ep-hero" aria-labelledby="event-title">
          <div className="ep-hero-copy">
            <p className="ep-eyebrow">{eyebrow}</p>
            <h1 id="event-title" className={event.name.length > 14 ? 'is-long' : ''}>{event.name}</h1>
            <p className="ep-presented">Presented by Diamond Metrics</p>
            {proDay && <p className="ep-tagline">{PRO_DAY.tagline}</p>}
            <div className="ep-details">
              {event.location && <div><span className="ep-detail-label">Location</span><strong>{venue}</strong>{address && <span>{address}</span>}</div>}
              <div><span className="ep-detail-label">{event.days.length > 1 ? 'Event dates' : 'Event date'}</span><strong>{dates}</strong>{event.tournament_name && <span>During the {event.tournament_name}</span>}</div>
              <div><span className="ep-detail-label">Price</span><strong>{price} per player{teamPrice ? ` · ${teamPrice} per team` : ''}</strong><span>Paid securely at checkout</span></div>
            </div>
            {event.accepting
              ? <a className="ep-button" href="#event-signup">Sign up today <span aria-hidden="true">→</span></a>
              : <p className="ep-closed-chip">{event.reason === 'full' ? 'Full' : 'Registration closed'}</p>}
          </div>
          <figure className="ep-hero-figure">
            <img src={heroImage} alt="Youth baseball player waiting for a pitch" />
            <figcaption>Your game, measured.</figcaption>
          </figure>
        </section>

        {event.description && <section className="ep-intro" aria-label={`About ${event.name}`}><p>{event.description}</p></section>}

        {proDay && (
          <section className="ep-metrics" aria-labelledby="event-metrics-title">
            <div className="ep-section-heading">
              <p className="ep-eyebrow">Five tools of baseball</p>
              <h2 id="event-metrics-title">What you’ll measure</h2>
              <p>See the metrics and player insights available across the Pro Day stations.</p>
            </div>
            <div className="ep-metrics-box">
              <div className="ep-tools-grid">
                {PRO_DAY.tools.map(tool => (
                  <article className="ep-tool-card" key={tool.number}>
                    <span className="ep-tool-number">{tool.number}</span>
                    <h3>{tool.name}</h3>
                    <p>{tool.summary}</p>
                    <ul>{tool.metrics.map(m => <li key={m}>{m}</li>)}</ul>
                  </article>
                ))}
              </div>
              <p className="ep-metrics-note">Metrics received may vary by player position and station.</p>
            </div>
          </section>
        )}

        {proDay && (
          <section className="ep-profile-band" aria-label="Diamond Metrics player profile">
            <div className="ep-profile-mark" aria-hidden="true">DM</div>
            <div>
              <p className="ep-eyebrow">Your results, all in one place</p>
              <h2>A player profile<br />you can share.</h2>
            </div>
            <p>Each athlete receives a personalized online baseball card with a data-backed snapshot of their performance.</p>
          </section>
        )}

        <section className="ep-signup" id="event-signup" aria-labelledby="event-signup-title">
          <div className="ep-signup-copy">
            <p className="ep-eyebrow">{eyebrow}</p>
            <h2 id="event-signup-title">Take the field.<br /><span>Know your game.</span></h2>
            <p>Register in advance for {event.name} on {event.days.map(d => d.label).join(' or ')}.</p>
            <div className="ep-prices" aria-label="Pricing">
              <p>{event.type_label} pricing</p>
              {teamPrice && <div><span>Team price</span><strong>{teamPrice}</strong></div>}
              <div><span>{teamPrice ? 'Individual price' : 'Per player'}</span><strong>{price}</strong></div>
            </div>
            {event.location && <p className="ep-address"><strong>{venue}</strong>{address && <><br />{address}</>}</p>}
            {event.what_to_bring && <p className="ep-address"><strong>Bring:</strong> {event.what_to_bring}</p>}
          </div>

          {event.accepting ? (
            <form className="ep-form-card" onSubmit={submit} noValidate data-testid="event-form">
              <p className="ep-eyebrow">{team ? 'Team registration' : 'Player registration'}</p>
              <h3>Sign up today</h3>
              {event.team && (
                <div className="ep-kind" role="radiogroup" aria-label="Register">
                  {[['player', 'A player', price], ['team', 'A team', teamPrice]].map(([k, label, amount]) => (
                    <button key={k} type="button" role="radio" aria-checked={form.kind === k} className={form.kind === k ? 'is-selected' : ''} onClick={() => pick(k)} data-testid={`register-as-${k}`}>
                      <span>{label}</span><strong>{amount}</strong>
                    </button>
                  ))}
                </div>
              )}
              <p className="ep-form-copy">{team ? `Coach or manager: one form for the whole team. You’ll pay ${teamPrice} on the next screen.` : `Parent or guardian: one form per player. You’ll pay ${price} on the next screen.`}</p>
              <div className="player-finder-fields">
                {team ? (
                  <>
                    <Field label="Coach or Manager Name" name="coachName" value={form.coachName} onChange={set} error={errors.coachName} autoComplete="name" />
                    <Field label="Email" name="email" type="email" value={form.email} onChange={set} error={errors.email} autoComplete="email" />
                    <Field label="Phone" optional name="phone" type="tel" value={form.phone} onChange={set} autoComplete="tel" />
                    <Field label="Team Name" name="teamName" value={form.teamName} onChange={set} error={errors.teamName} />
                    <Field label="Number of Players" name="teamSize" type="number" inputMode="numeric" min="1" max={event.team.max_size} value={form.teamSize} onChange={set} error={errors.teamSize} />
                    {event.team.divisions.length ? (
                      <label>
                        <span className="ep-label">Division / Age Group</span>
                        <select name="division" value={form.division} onChange={set} aria-invalid={Boolean(errors.division)} aria-describedby={errors.division ? 'division-error' : undefined}>
                          <option value="">Choose…</option>
                          {event.team.divisions.map(d => <option key={d} value={d}>{d}</option>)}
                        </select>
                        {errors.division && <span className="player-finder-field-error" id="division-error">{errors.division}</span>}
                      </label>
                    ) : <Field label="Division / Age Group" name="division" value={form.division} onChange={set} error={errors.division} placeholder="12U" />}
                  </>
                ) : (
                  <>
                    <Field label="Parent or Guardian Name" name="guardianName" value={form.guardianName} onChange={set} error={errors.guardianName} autoComplete="name" />
                    <Field label="Email" name="email" type="email" value={form.email} onChange={set} error={errors.email} autoComplete="email" />
                    <Field label="Phone" optional name="phone" type="tel" value={form.phone} onChange={set} autoComplete="tel" />
                    <Field label="Player Name" name="playerName" value={form.playerName} onChange={set} error={errors.playerName} />
                    <Field label="Player Age" name="playerAge" type="number" inputMode="numeric" min="4" max="25" value={form.playerAge} onChange={set} error={errors.playerAge} />
                    <Field label="Player’s Team" name="playerTeam" value={form.playerTeam} onChange={set} error={errors.playerTeam} />
                  </>
                )}
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
                  <span className="event-consent-row"><input type="checkbox" name="consent" checked={form.consent} onChange={set} aria-invalid={Boolean(errors.consent)} /><span>{team ? event.team.consent_text : event.consent_text}</span></span>
                  {errors.consent && <span className="player-finder-field-error">{errors.consent}</span>}
                </label>
              </div>
              {submitError && <p className="player-finder-checkout-error" role="alert">{submitError}</p>}
              <button className="ep-submit" type="submit" disabled={busy}>{busy ? 'Starting secure checkout…' : <>{team ? 'Register team' : 'Register'} &amp; pay {due} <span aria-hidden="true">→</span></>}</button>
              <p className="player-finder-note">Payment is handled by Stripe. Your details are used to run the event and deliver {team ? 'your players’' : 'your player’s'} results. <a href="/privacy">Privacy Policy</a></p>
            </form>
          ) : (
            <div className="ep-form-card" data-testid="event-closed">
              <p className="ep-eyebrow">Registration</p><h3>{event.reason === 'full' ? 'Full' : 'Closed'}</h3>
              <p className="ep-form-copy">{CLOSED_COPY[event.reason] || CLOSED_COPY.closed}{event.reason === 'closed' ? ' Walk-ups may still be welcome at the booth on the day.' : ''}</p>
            </div>
          )}
        </section>
      </div>
    </MarketingLayout>
  );
}

function Field({ label, optional, error, ...props }) {
  const errorId = `${props.name}-error`;
  return <label><span className="ep-label">{label}{optional && <small> (optional)</small>}</span><input {...props} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} />{error && <span className="player-finder-field-error" id={errorId}>{error}</span>}</label>;
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
        <h1>{r.paid ? `See you there, ${r.kind === 'team' ? r.team_name : r.player_first_name}.` : 'One moment…'}</h1>
        <p>{r.paid
          ? <>{event.name} · <strong>{r.day_label}</strong>{r.kind === 'team' ? <> · {r.team_size} players · {r.division}</> : null}{event.location ? <> · {event.location}</> : null}</>
          : waitedOut ? 'Stripe has your payment; your confirmation is on its way. Keep your registration number below.' : 'We’re waiting for Stripe to confirm your payment. This page updates on its own.'}</p>
        <div className="player-intake-order"><p className="player-finder-eyebrow">Registration number</p><p className="player-intake-order-id">{r.registration_id}</p></div>
        {event.what_to_bring && <p className="player-intake-next"><strong>Bring:</strong> {event.what_to_bring}</p>}
        <p className="player-intake-next">Stripe will email your receipt. Show your registration number or the {r.kind === 'team' ? 'team’s' : 'player’s'} name at check-in.</p>
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
                <span className="event-index-price">{dollars(e.price_cents)}{e.team ? ` · ${dollars(e.team.price_cents)} per team` : ''} · Register →</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </MarketingLayout>
  );
}
