// Paired game jobs (gamePairing.js): see, set and clear which job is the
// other team's job for the same game.
import { pairingOf, pairingCandidates, pairJobs, unpairJobs, describeJob } from './gamePairing.js';

export function mountGamePairingRoutes(app, { db, requireInternal }) {
  const view = jobId => {
    const p = pairingOf(db, jobId);
    if (!p.job) return null;
    return { role: p.role, partner: p.partner ? describeJob(db, p.partner) : null, candidates: p.role ? [] : pairingCandidates(db, p.job) };
  };
  const handle = (res, fn) => { try { fn(); } catch (err) { res.status(err.status || 500).json({ error: err.message }); } };

  app.get('/api/command/jobs/:id/pairing', requireInternal, (req, res) => {
    const v = view(Number(req.params.id));
    if (!v) return res.status(404).json({ error: 'Job not found' });
    res.json(v);
  });

  app.post('/api/command/jobs/:id/pairing', requireInternal, (req, res) => handle(res, () => {
    const r = pairJobs(db, Number(req.params.id), Number(req.body?.partner_job_id), req.internal.id);
    res.status(201).json({ ...r, ...view(Number(req.params.id)) });
  }));

  app.delete('/api/command/jobs/:id/pairing', requireInternal, (req, res) => handle(res, () => {
    const r = unpairJobs(db, Number(req.params.id), req.internal.id);
    res.json({ ...r, ...view(Number(req.params.id)) });
  }));
}
