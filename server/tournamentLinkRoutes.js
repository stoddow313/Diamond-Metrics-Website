// A Command job linked to its tournament game after the fact (tournamentLink.js).
import { tournamentLinkOf, linkTournamentGame, unlinkTournamentGame } from './tournamentLink.js';

export function mountTournamentLinkRoutes(app, { db, requireInternal }) {
  const handle = (res, fn) => { try { fn(); } catch (err) { res.status(err.status || 500).json({ error: err.message }); } };

  app.get('/api/command/jobs/:id/tournament-link', requireInternal, (req, res) => {
    const v = tournamentLinkOf(db, Number(req.params.id));
    if (!v) return res.status(404).json({ error: 'Job not found' });
    res.json(v);
  });

  // { tournament_game_id, record_score? }
  app.post('/api/command/jobs/:id/tournament-link', requireInternal, (req, res) => handle(res, () => {
    const b = req.body || {};
    res.status(201).json(linkTournamentGame(db, Number(req.params.id), { tournament_game_id: Number(b.tournament_game_id), record_score: !!b.record_score }, req.internal.id));
  }));

  app.delete('/api/command/jobs/:id/tournament-link', requireInternal, (req, res) => handle(res, () => {
    res.json(unlinkTournamentGame(db, Number(req.params.id), req.internal.id));
  }));
}
