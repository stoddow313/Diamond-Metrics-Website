// Event registration routes (eventLogic.js, eventStore.js; docs/COMMAND_OPS.md §3.23).
//
// Public — the sign-up page and its form; nothing here marks a registration paid:
//   GET  /api/public/events                         listed events taking registrations
//   GET  /api/public/events/:slug                   one event (an old slug still answers; a draft only for staff)
//   POST /api/public/events/:slug/register          save the registration, start its Stripe Checkout
//   GET  /api/public/event-registrations/session/:sessionId   the confirmation page's registration
//
// Desk — the live list, for any internal role (acting: admin or fulfillment)
// and for a booth login granted the event:
//   GET  /api/desk/events                           the events this login can work
//   GET  /api/desk/events/:id                       event, counts, every registration
//   GET  /api/desk/events/:id/roster.csv            the roster as CSV
//   POST /api/desk/events/:id/walk-ups              a walk-up: pay by QR on the parent's phone, or at the booth
//   PUT  /api/desk/registrations/:rid/check-in      { checked_in: true | false }
//   PUT  /api/desk/registrations/:rid/booth-payment { method: cash | venmo | other | comp, note }
//   POST /api/desk/registrations/:rid/pay-link      a new checkout for an unpaid registration (QR at the booth)
//
// Setup — Command → Events, admin or fulfillment:
//   POST /api/command/events · PUT /api/command/events/:id · GET /api/command/events/:id/setup
//   GET|POST /api/command/events/:id/access · DELETE /api/command/event-access/:id   booth logins
import { readStripeConfig, stripeClient } from './stripeConfig.js';
import { returnBase } from './tournamentCheckoutRoutes.js';
import { bearerToken } from './principals.js';
import { captureError, log } from './observability.js';
import { makeLimiter, rateLimit, clientIp } from './rateLimit.js';
import {
  EVENT_TYPES, PAYMENT_METHODS, BOOTH_METHODS, availability, validateRegistration, publicEvent, readEventPatch, parseDays, choiceLabel, rosterCsv,
} from './eventLogic.js';
import {
  getEvent, resolveEventSlug, createEvent, updateEvent, eventAliases, paidByDay, eventCounts, listEvents,
  createRegistration, recordSession, getRegistrationById, getRegistrationBySession, markPaidAtBooth, setCheckedIn, listRegistrations,
  staffEventIds, staffCanWorkEvent,
} from './eventStore.js';
import { upsertStaffInvite, accessList } from './staffAccess.js';

export const CHECKOUT_FAILED = 'We could not start secure checkout. Please try again.';
const CLOSED_COPY = {
  draft: 'Registration for this event has not opened yet.',
  not_open_yet: 'Registration for this event has not opened yet.',
  closed: 'Registration for this event is closed.',
  ended: 'This event has ended.',
  full: 'This event is full.',
  archived: 'This event is no longer available.',
};

const send = handler => async (req, res) => {
  try { await handler(req, res); } catch (err) {
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
    captureError(err, { event: 'event_registration_error', path: req.path });
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};

// The registration as the desk shows it.
const deskRow = (event, r) => ({ ...r, day_label: choiceLabel(event, r.preferred_day), payment_label: r.payment_method ? PAYMENT_METHODS[r.payment_method] : null });

export function mountEventRoutes(app, { db, principals }) {
  const { internalFromToken, staffFromToken, requireInternalRole } = principals;
  const canManage = requireInternalRole('admin', 'fulfillment');

  // Stripe Checkout for one registration, at the event's price. Stripe gets
  // ids and the email for the receipt — no player name.
  async function startCheckout(req, event, reg) {
    const config = readStripeConfig();
    const stripe = config.mode ? stripeClient(config) : null;
    if (!stripe) { log('warn', 'event_checkout_unavailable', { registration_id: reg.registration_id }); return null; }
    const base = returnBase(req.get('origin'));
    const ids = { registration_id: reg.registration_id, event_slug: event.slug };
    try {
      return await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: event.price_cents, product_data: { name: `${event.name} — registration` } } }],
        customer_email: reg.email,
        client_reference_id: reg.registration_id,
        metadata: ids,
        payment_intent_data: { metadata: ids, receipt_email: reg.email },
        success_url: `${base}/events/${event.slug}/registered?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/events/${event.slug}?checkout=cancelled`,
      });
    } catch (err) {
      // Stripe's message can echo the email: type and code only.
      log('warn', 'event_checkout_failed', { registration_id: reg.registration_id, type: err?.type, code: err?.code });
      if (err?.param === 'customer_email') throw Object.assign(new Error('Enter a valid email address.'), { status: 400 });
      return null;
    }
  }

  // ── Public ───────────────────────────────────────────────────────────────
  app.get('/api/public/events', (_req, res) => {
    const events = listEvents(db).filter(e => e.listed && e.status === 'open')
      .map(e => publicEvent(e, availability(e, paidByDay(db, e.id))))
      .filter(e => e.reason !== 'ended');
    res.json({ events });
  });

  app.get('/api/public/events/:slug', (req, res) => {
    const event = resolveEventSlug(db, String(req.params.slug));
    // A draft is seen only by staff signed in to Command (the preview banner says so).
    const staffPreview = event?.status === 'draft' && !!internalFromToken(bearerToken(req));
    if (!event || event.status === 'archived' || (event.status === 'draft' && !staffPreview)) return res.status(404).json({ error: 'Event not found' });
    const tournament = event.tournament_id ? db.prepare('SELECT name FROM tournaments WHERE id = ?').get(event.tournament_id) : null;
    res.json({ event: publicEvent(event, availability(event, paidByDay(db, event.id)), { preview: staffPreview, tournament_name: tournament?.name || null }) });
  });

  // Generous: many parents at one field share a carrier's address.
  const limits = rateLimit([
    { limiter: makeLimiter({ limit: 60, windowMs: 10 * 60 * 1000 }), key: clientIp, message: 'Too many registration attempts from this network.' },
    { limiter: makeLimiter({ limit: 10, windowMs: 60 * 60 * 1000 }), key: req => (typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '') || null, message: 'Too many registration attempts for this email.' },
  ]);
  app.post('/api/public/events/:slug/register', limits, send(async (req, res) => {
    const event = resolveEventSlug(db, String(req.params.slug));
    if (!event || ['draft', 'archived'].includes(event.status)) return res.status(404).json({ error: 'Event not found' });
    const avail = availability(event, paidByDay(db, event.id));
    if (!avail.accepting) return res.status(409).json({ error: CLOSED_COPY[avail.reason] || CLOSED_COPY.closed });
    const checked = validateRegistration(req.body, event, avail);
    if (checked.error) return res.status(400).json({ error: checked.error });
    if (!readStripeConfig().mode) return res.status(503).json({ error: CHECKOUT_FAILED });
    const reg = createRegistration(db, event, checked.value);
    const session = await startCheckout(req, event, reg);
    if (!session) return res.status(502).json({ error: CHECKOUT_FAILED });
    recordSession(db, reg.id, session.id);
    log('info', 'event_checkout_started', { registration_id: reg.registration_id, event_id: event.id, session_id: session.id });
    res.json({ url: session.url, registrationId: reg.registration_id });
  }));

  // The page Stripe returns to. The session id is the parent's own link; it
  // answers with what the confirmation shows, and whether Stripe has confirmed yet.
  app.get('/api/public/event-registrations/session/:sessionId', (req, res) => {
    const reg = getRegistrationBySession(db, String(req.params.sessionId));
    if (!reg) return res.status(404).json({ error: 'Registration not found' });
    const event = getEvent(db, reg.event_id);
    res.json({
      registration: {
        registration_id: reg.registration_id, paid: reg.status === 'paid', player_first_name: reg.player_name.split(/\s+/)[0],
        day: reg.preferred_day, day_label: choiceLabel(event, reg.preferred_day),
      },
      event: { name: event.name, slug: event.slug, location: event.location, what_to_bring: event.what_to_bring, days: parseDays(event.days) },
    });
  });

  // ── Desk ─────────────────────────────────────────────────────────────────
  function deskActor(req) {
    const token = bearerToken(req);
    const internal = internalFromToken(token);
    if (internal) return { kind: 'internal', id: internal.id, name: internal.name, role: internal.role, canAct: ['admin', 'fulfillment'].includes(internal.role) };
    const staff = staffFromToken(token);
    if (staff) return { kind: 'staff', id: staff.staff_user_id, name: staff.name, email: staff.email, canAct: true };
    return null;
  }
  // The event, when this login may work it (and act on it, when asked); else the response is sent.
  function deskFor(req, res, eventId, { act = false } = {}) {
    const actor = deskActor(req);
    if (!actor) { res.status(401).json({ error: 'Not authenticated' }); return null; }
    const event = getEvent(db, Number(eventId));
    if (!event || (actor.kind === 'staff' && !staffCanWorkEvent(db, actor.email, event.id))) { res.status(404).json({ error: 'Event not found' }); return null; }
    if (act && !actor.canAct) { res.status(403).json({ error: 'admin or fulfillment role required' }); return null; }
    return { actor, event };
  }
  function deskRegistration(req, res, { act = true } = {}) {
    const reg = getRegistrationById(db, String(req.params.rid));
    if (!reg) { res.status(404).json({ error: 'Registration not found' }); return null; }
    const ctx = deskFor(req, res, reg.event_id, { act });
    return ctx ? { ...ctx, reg } : null;
  }

  app.get('/api/desk/events', (req, res) => {
    const actor = deskActor(req);
    if (!actor) return res.status(401).json({ error: 'Not authenticated' });
    const events = actor.kind === 'staff'
      ? listEvents(db, { ids: staffEventIds(db, actor.email) })
      : listEvents(db, { includeArchived: req.query.archived === '1' });
    res.json({ events: events.map(e => ({ ...e, type_label: EVENT_TYPES[e.event_type] || 'Event' })), can_manage: actor.kind === 'internal' && actor.canAct });
  });

  app.get('/api/desk/events/:id', (req, res) => {
    const ctx = deskFor(req, res, req.params.id);
    if (!ctx) return;
    const { event, actor } = ctx;
    const avail = availability(event, paidByDay(db, event.id));
    res.json({
      event: { ...event, days: parseDays(event.days), type_label: EVENT_TYPES[event.event_type] || 'Event' },
      availability: avail,
      counts: eventCounts(db, event.id),
      registrations: listRegistrations(db, event.id).map(r => deskRow(event, r)),
      actor: { kind: actor.kind, name: actor.name, can_act: actor.canAct, can_manage: actor.kind === 'internal' && actor.canAct },
      booth_methods: BOOTH_METHODS.map(m => ({ key: m, label: PAYMENT_METHODS[m] })),
    });
  });

  app.get('/api/desk/events/:id/roster.csv', (req, res) => {
    const ctx = deskFor(req, res, req.params.id);
    if (!ctx) return;
    const { event } = ctx;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${event.slug}-roster.csv"`);
    res.send(rosterCsv(event, listRegistrations(db, event.id)));
  });

  app.put('/api/desk/registrations/:rid/check-in', (req, res) => {
    const ctx = deskRegistration(req, res);
    if (!ctx) return;
    if (typeof req.body?.checked_in !== 'boolean') return res.status(400).json({ error: 'checked_in must be true or false.' });
    if (req.body.checked_in && ctx.reg.status !== 'paid') return res.status(409).json({ error: 'Take payment before checking this player in.' });
    const reg = setCheckedIn(db, ctx.reg, req.body.checked_in, ctx.actor);
    res.json({ registration: deskRow(ctx.event, reg), counts: eventCounts(db, ctx.event.id) });
  });

  app.put('/api/desk/registrations/:rid/booth-payment', send((req, res) => {
    const ctx = deskRegistration(req, res);
    if (!ctx) return;
    const method = req.body?.method;
    if (!BOOTH_METHODS.includes(method)) return res.status(400).json({ error: 'Choose cash, Venmo, other or comped.' });
    const reg = markPaidAtBooth(db, ctx.reg, { method, note: req.body?.note, amountCents: ctx.event.price_cents, actor: ctx.actor });
    log('info', 'event_registration_paid_at_booth', { registration_id: reg.registration_id, method });
    res.json({ registration: deskRow(ctx.event, reg), counts: eventCounts(db, ctx.event.id) });
  }));

  app.post('/api/desk/registrations/:rid/pay-link', send(async (req, res) => {
    const ctx = deskRegistration(req, res);
    if (!ctx) return;
    if (ctx.reg.status === 'paid') return res.status(409).json({ error: 'This registration is already paid.' });
    const session = await startCheckout(req, ctx.event, ctx.reg);
    if (!session) return res.status(502).json({ error: CHECKOUT_FAILED });
    recordSession(db, ctx.reg.id, session.id, ctx.actor.kind, ctx.actor.id);
    res.json({ url: session.url });
  }));

  // A walk-up at the booth: the same form, then the parent pays by QR on their
  // own phone, or staff take payment at the booth. A closed page still takes
  // walk-ups; a full day does not.
  app.post('/api/desk/events/:id/walk-ups', send(async (req, res) => {
    const ctx = deskFor(req, res, req.params.id, { act: true });
    if (!ctx) return;
    const { event, actor } = ctx;
    if (['draft', 'archived'].includes(event.status)) return res.status(409).json({ error: 'Open the event before taking walk-ups.' });
    const payment = req.body?.payment;
    if (payment !== 'qr' && !BOOTH_METHODS.includes(payment)) return res.status(400).json({ error: 'Choose how they’re paying.' });
    const checked = validateRegistration({ ...req.body, source: 'booth' }, event, availability(event, paidByDay(db, event.id)));
    if (checked.error) return res.status(400).json({ error: checked.error });
    if (payment === 'qr' && !readStripeConfig().mode) return res.status(503).json({ error: CHECKOUT_FAILED });
    let reg = createRegistration(db, event, checked.value, { actorKind: actor.kind, actorId: actor.id, walkUp: true });
    let url = null;
    if (payment === 'qr') {
      const session = await startCheckout(req, event, reg);
      if (!session) return res.status(502).json({ error: CHECKOUT_FAILED, registration: deskRow(event, reg) });
      recordSession(db, reg.id, session.id, actor.kind, actor.id);
      url = session.url;
    } else {
      reg = markPaidAtBooth(db, reg, { method: payment, note: req.body?.note, amountCents: event.price_cents, actor });
    }
    res.status(201).json({ registration: deskRow(event, reg), url, counts: eventCounts(db, event.id) });
  }));

  // ── Setup (Command → Events) ─────────────────────────────────────────────
  const tournamentOptions = () => db.prepare('SELECT id, name, start_date FROM tournaments WHERE archived = 0 ORDER BY start_date DESC').all();
  const checkTournament = id => id == null || !!db.prepare('SELECT 1 FROM tournaments WHERE id = ?').get(id);

  app.post('/api/command/events', canManage, send((req, res) => {
    const r = readEventPatch(req.body, null);
    if (r.error) return res.status(400).json({ error: r.error });
    if (!checkTournament(r.value.tournament_id)) return res.status(400).json({ error: 'That tournament was not found.' });
    const event = createEvent(db, r.value, req.internal.id);
    log('info', 'signup_event_created', { event_id: event.id, by: req.internal.id });
    res.status(201).json({ event: { ...event, days: parseDays(event.days) } });
  }));

  app.get('/api/command/events/:id/setup', canManage, (req, res) => {
    const event = getEvent(db, Number(req.params.id));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    // days_raw: the days as saved (a blank label stays blank in the form).
    res.json({ event: { ...event, days: parseDays(event.days), days_raw: JSON.parse(event.days || '[]') }, aliases: eventAliases(db, event.id), tournaments: tournamentOptions(), event_types: EVENT_TYPES });
  });

  app.put('/api/command/events/:id', canManage, send((req, res) => {
    const current = getEvent(db, Number(req.params.id));
    if (!current) return res.status(404).json({ error: 'Event not found' });
    const r = readEventPatch(req.body, current);
    if (r.error) return res.status(400).json({ error: r.error });
    if (!checkTournament(r.value.tournament_id)) return res.status(400).json({ error: 'That tournament was not found.' });
    const event = updateEvent(db, current, r.value);
    if (r.value.status && r.value.status !== current.status) log('info', 'signup_event_status', { event_id: event.id, from: current.status, to: event.status, by: req.internal.id });
    res.json({ event: { ...event, days: parseDays(event.days) }, aliases: eventAliases(db, event.id) });
  }));

  app.get('/api/command/events/:id/access', canManage, (req, res) => {
    if (!getEvent(db, Number(req.params.id))) return res.status(404).json({ error: 'Not found' });
    res.json({ access: accessList(db, 'event_users', 'event_id', Number(req.params.id)) });
  });

  app.post('/api/command/events/:id/access', canManage, (req, res) => {
    const eventId = Number(req.params.id);
    if (!getEvent(db, eventId)) return res.status(404).json({ error: 'Not found' });
    const email = String(req.body?.email || '').toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'A valid email is required' });
    try {
      db.prepare("INSERT INTO event_users (event_id, email, role) VALUES (?, ?, 'booth')").run(eventId, email);
    } catch {
      return res.status(409).json({ error: 'That email already has access' });
    }
    const inviteToken = upsertStaffInvite(db, email);
    res.status(201).json({ access: accessList(db, 'event_users', 'event_id', eventId), invite_token: inviteToken });
  });

  app.delete('/api/command/event-access/:id', canManage, (req, res) => {
    const info = db.prepare('DELETE FROM event_users WHERE id = ?').run(req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'Assignment not found' });
    res.json({ ok: true });
  });
}
