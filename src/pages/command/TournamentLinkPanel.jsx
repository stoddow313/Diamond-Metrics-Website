// The tournament game this job analyzed. A job created as a standalone game
// can be linked afterwards, with nothing re-done: its published player games
// then count for the team's entry on the tournament and team dashboards, and
// the released final can go on a game that has no score yet
// (server/tournamentLink.js).
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Select, PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import { InfoTip } from '../../components/Tooltip';
import { cardStyle } from '../../components/admin/theme';

const scoreOf = g => (g.home_score != null && g.away_score != null ? `${g.home_team_name} ${g.home_score} – ${g.away_team_name} ${g.away_score}` : null);
const describe = g => `${g.tournament_name} · ${g.division_name}${g.stage ? ` · ${g.stage}` : ''} · ${g.is_home ? 'vs' : 'at'} ${g.opponent}${g.game_time ? ` · ${g.game_time}` : ''}`;

export default function TournamentLinkPanel({ job, onChanged }) {
  const [data, setData] = useState(null);
  const [choice, setChoice] = useState('');
  const [recordScore, setRecordScore] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    api.commandTournamentLink(job.id).then(d => {
      setData(d);
      setChoice(String(d.candidates.find(c => !c.linked_job_id)?.id || ''));
    }).catch(err => setError(err.message));
  }, [job.id, tick]);

  async function act(fn) {
    setBusy(true); setError('');
    try { await fn(); setTick(t => t + 1); onChanged?.(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  const picked = data?.candidates.find(c => String(c.id) === choice);
  const canScore = !!(data?.result && picked && picked.status !== 'final' && picked.home_score == null && picked.away_score == null);
  const finalText = r => (r ? `${r.us_runs}–${r.them_runs}` : '');

  return (
    <section className="rounded-2xl border p-6" style={cardStyle} data-testid="tournament-link">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-lg font-bold text-white" style={{ fontSize: '1.125rem', marginBottom: 0 }}>Tournament game</h2>
        <InfoTip label="About linking a tournament game">
          Link the tournament game this job analyzed. Nothing is re-done: the player games it published count for the team’s entry on the tournament and team dashboards, and a paired job links with it. If the game has no score yet, this job’s released final can be recorded on it.
        </InfoTip>
      </div>
      <ErrorNote>{error}</ErrorNote>
      {!data ? <p className="text-sm" style={{ color: '#94a3b8' }}>Loading…</p> : data.linked ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-bold" style={{ color: '#cfe8ff' }} data-testid="tournament-linked">{describe(data.linked)}</span>
          <span className="text-xs" style={{ color: '#94a3b8' }}>{scoreOf(data.linked) || 'no score yet'}</span>
          <GhostButton type="button" disabled={busy} style={{ padding: '3px 12px', fontSize: 12 }}
            onClick={() => window.confirm('Make this a standalone game again? Its player games stop counting for the tournament entry; a score already recorded on the tournament game stays.') && act(() => api.commandTournamentUnlink(job.id))}>
            Unlink
          </GhostButton>
        </div>
      ) : data.candidates.length === 0 ? (
        <p className="text-sm" style={{ color: '#94a3b8' }}>
          Standalone game — no tournament game for this team on {data.game_date}.
          {data.nearby.length > 0 && <> Nearby: {data.nearby.map(g => `${g.game_date} ${g.is_home ? 'vs' : 'at'} ${g.opponent}`).join(' · ')} — fix the date that’s wrong, then link.</>}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={choice} onChange={e => setChoice(e.target.value)} aria-label="Tournament game" style={{ width: 'auto', minWidth: 260 }} data-testid="tournament-choice">
              {data.candidates.map(c => (
                <option key={c.id} value={c.id} disabled={!!c.linked_job_id}>
                  {describe(c)}{c.linked_job_id ? ` · job #${c.linked_job_id} has it` : ''}{scoreOf(c) ? ` · ${scoreOf(c)}` : ''}
                </option>
              ))}
            </Select>
            <PrimaryButton type="button" disabled={busy || !choice} data-testid="tournament-link-save"
              onClick={() => act(() => api.commandTournamentLinkSet(job.id, { tournament_game_id: Number(choice), record_score: canScore && recordScore }))}>
              Link
            </PrimaryButton>
          </div>
          {canScore && (
            <label className="flex items-center gap-2 text-xs" style={{ color: '#cfe8ff' }}>
              <input type="checkbox" checked={recordScore} onChange={e => setRecordScore(e.target.checked)} data-testid="tournament-record-score" />
              Record this job’s final ({finalText(data.result)}) as the game’s score
            </label>
          )}
        </div>
      )}
    </section>
  );
}
