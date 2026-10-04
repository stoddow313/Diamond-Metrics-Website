// In-memory fixed-window rate limits for the public auth and intake endpoints.
// The API is one instance (COMMAND_OPS §1), so process memory is the right
// store; a restart resets the windows, which errs toward letting a real
// customer back in rather than locking them out.

// First X-Forwarded-For hop (Vercel → Render puts the client there). It is
// client-supplied, so per-IP limits are coarse protection only; anything that
// matters (password guessing, email sends) is also limited per account email.
export function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket?.remoteAddress || 'unknown';
}

export function makeLimiter({ limit, windowMs }) {
  const hits = new Map();   // key → { count, resetAt }
  let lastSweep = Date.now();
  return {
    take(key) {
      const now = Date.now();
      if (now - lastSweep > windowMs) {
        for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
        lastSweep = now;
      }
      const cur = hits.get(key);
      if (!cur || cur.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return { ok: true };
      }
      cur.count += 1;
      if (cur.count > limit) return { ok: false, retryAfterS: Math.max(1, Math.ceil((cur.resetAt - now) / 1000)) };
      return { ok: true };
    },
    reset() { hits.clear(); },
  };
}

// Express middleware: every rule must pass. A rule whose key function returns
// null does not apply to this request (e.g. no email in the body).
export function rateLimit(rules) {
  return (req, res, next) => {
    if (process.env.DM_RATE_LIMITS === '0') return next();
    for (const { limiter, key, message } of rules) {
      const k = key(req);
      if (k == null || k === '') continue;
      const verdict = limiter.take(String(k));
      if (!verdict.ok) {
        res.set('Retry-After', String(verdict.retryAfterS));
        const wait = verdict.retryAfterS >= 120 ? `${Math.ceil(verdict.retryAfterS / 60)} minutes` : `${verdict.retryAfterS} seconds`;
        return res.status(429).json({ error: message ? `${message} Try again in ${wait}.` : `Too many attempts — try again in ${wait}.` });
      }
    }
    next();
  };
}
