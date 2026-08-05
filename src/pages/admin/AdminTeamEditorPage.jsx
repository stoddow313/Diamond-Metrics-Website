import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { Field, TextInput, Select, PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import { cardStyle } from '../../components/admin/theme';
import AccessPanel from '../../components/admin/AccessPanel';

// Team editor: identity, dated roster memberships (archive keeps history),
// and the team's tournament entries. Memberships never delete — archiving
// closes the window so past results stay attributed correctly.
export default function AdminTeamEditorPage() {
  const { teamId } = useParams();
  const [team, setTeam] = useState(null);
  const [roster, setRoster] = useState([]);
  const [entries, setEntries] = useState([]);
  const [players, setPlayers] = useState([]);
  const [seasons, setSeasons] = useState([]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [addForm, setAddForm] = useState({ player_id: '', season_id: '', start_date: '', jersey: '', positions: '' });

  const [tick, setTick] = useState(0);
  const load = () => setTick(t => t + 1);

  useEffect(() => {
    Promise.all([api.getTeam(teamId), api.listPlayers(), api.listSeasons()])
      .then(([detail, playerList, seasonList]) => {
        setTeam(detail.team);
        setRoster(detail.roster);
        setEntries(detail.entries);
        setPlayers(playerList.players);
        setSeasons(seasonList.seasons);
      })
      .catch(err => setError(err.message));
  }, [teamId, tick]);

  async function saveTeam(e) {
    e.preventDefault();
    try {
      const { team: updated } = await api.updateTeam(teamId, {
        name: team.name, age_group: team.age_group, level: team.level, active: team.active ? 1 : 0,
      });
      setTeam(t => ({ ...t, ...updated }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) { setError(err.message); }
  }

  async function addMember(e) {
    e.preventDefault();
    setError('');
    try {
      await api.addRosterMembership(teamId, {
        player_id: Number(addForm.player_id),
        season_id: addForm.season_id ? Number(addForm.season_id) : null,
        start_date: addForm.start_date,
        jersey: addForm.jersey, positions: addForm.positions,
      });
      setAddForm({ player_id: '', season_id: '', start_date: '', jersey: '', positions: '' });
      await load();
    } catch (err) { setError(err.message); }
  }

  async function archiveMember(id) {
    if (!confirm('Archive this roster membership? History stays intact.')) return;
    await api.updateRosterMembership(id, { status: 'archived' });
    await load();
  }

  if (error && !team) return <ErrorNote>{error}</ErrorNote>;
  if (!team) return <p style={{ color: '#94a3b8' }}>Loading…</p>;

  const rosterActive = roster.filter(r => r.status === 'active');
  const rosterArchived = roster.filter(r => r.status !== 'active');

  return (
    <div>
      <div className="mb-6">
        <Link to="/admin/teams" className="text-xs hover:underline" style={{ color: '#64748b' }}>← All teams</Link>
        <h1 className="text-2xl font-bold text-white mt-1">{team.name}</h1>
        <p className="text-sm" style={{ color: '#94a3b8' }}>{team.organization_name} · /teams/{team.slug}</p>
      </div>

      <ErrorNote>{error}</ErrorNote>

      {/* identity */}
      <form onSubmit={saveTeam} className="rounded-2xl border p-6 mb-6" style={cardStyle}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-white">Team</h2>
          <div className="flex items-center gap-3">
            {saved && <span className="text-xs font-bold" style={{ color: '#4ade80' }}>Saved ✓</span>}
            <PrimaryButton type="submit">Save</PrimaryButton>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Field label="Name"><TextInput value={team.name} onChange={e => setTeam({ ...team, name: e.target.value })} required /></Field>
          <Field label="Age group"><TextInput value={team.age_group || ''} onChange={e => setTeam({ ...team, age_group: e.target.value })} /></Field>
          <Field label="Level"><TextInput value={team.level || ''} onChange={e => setTeam({ ...team, level: e.target.value })} /></Field>
          <Field label="Status">
            <Select value={team.active ? '1' : '0'} onChange={e => setTeam({ ...team, active: e.target.value === '1' })}>
              <option value="1">Active</option>
              <option value="0">Inactive</option>
            </Select>
          </Field>
        </div>
      </form>

      {/* roster */}
      <section className="rounded-2xl border p-6 mb-6" style={cardStyle}>
        <h2 className="text-lg font-bold text-white mb-1">Roster</h2>
        <p className="text-xs mb-4" style={{ color: '#94a3b8' }}>
          Memberships are dated — archiving closes the window without erasing history. Guests join event rosters, not this list.
        </p>

        <form onSubmit={addMember} className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end p-4 rounded-xl mb-4" style={{ backgroundColor: 'rgba(30, 41, 59, 0.5)' }}>
          <Field label="Player">
            <Select value={addForm.player_id} onChange={e => setAddForm({ ...addForm, player_id: e.target.value })} required>
              <option value="">—</option>
              {players.map(p => <option key={p.id} value={p.id}>{p.first_name} {p.last_name}</option>)}
            </Select>
          </Field>
          <Field label="Season">
            <Select value={addForm.season_id} onChange={e => setAddForm({ ...addForm, season_id: e.target.value })}>
              <option value="">—</option>
              {seasons.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </Select>
          </Field>
          <Field label="Start date"><TextInput type="date" value={addForm.start_date} onChange={e => setAddForm({ ...addForm, start_date: e.target.value })} required /></Field>
          <Field label="Jersey"><TextInput value={addForm.jersey} onChange={e => setAddForm({ ...addForm, jersey: e.target.value })} /></Field>
          <Field label="Positions"><TextInput value={addForm.positions} onChange={e => setAddForm({ ...addForm, positions: e.target.value })} placeholder="SS, 2B" /></Field>
          <PrimaryButton type="submit">+ Add to roster</PrimaryButton>
        </form>

        {rosterActive.length === 0 ? (
          <p className="text-sm" style={{ color: '#94a3b8' }}>No active roster members.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider" style={{ color: '#64748b' }}>
                <th className="py-2 pr-3">Player</th><th className="py-2 pr-3">#</th><th className="py-2 pr-3">Positions</th>
                <th className="py-2 pr-3">Season</th><th className="py-2 pr-3">Window</th><th className="py-2 pr-3"></th>
              </tr>
            </thead>
            <tbody>
              {rosterActive.map(r => (
                <tr key={r.id} className="border-t" style={{ borderColor: '#1e3a5f' }}>
                  <td className="py-2 pr-3 font-bold text-white">
                    <Link to={`/admin/players/${r.player_id}`} className="hover:underline">{r.first_name} {r.last_name}</Link>
                  </td>
                  <td className="py-2 pr-3" style={{ color: '#cfe8ff' }}>{r.jersey}</td>
                  <td className="py-2 pr-3" style={{ color: '#cfe8ff' }}>{r.positions}</td>
                  <td className="py-2 pr-3" style={{ color: '#94a3b8' }}>{r.season_label || '—'}</td>
                  <td className="py-2 pr-3" style={{ color: '#94a3b8' }}>{r.start_date} → {r.end_date || 'open'}</td>
                  <td className="py-2 text-right">
                    <GhostButton type="button" onClick={() => archiveMember(r.id)} style={{ padding: '4px 10px', fontSize: 12 }}>Archive</GhostButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {rosterArchived.length > 0 && (
          <details className="mt-4">
            <summary className="text-xs font-bold cursor-pointer" style={{ color: '#64748b' }}>
              Archived memberships ({rosterArchived.length})
            </summary>
            <div className="mt-2 text-sm" style={{ color: '#94a3b8' }}>
              {rosterArchived.map(r => (
                <p key={r.id}>{r.first_name} {r.last_name} · {r.start_date} → {r.end_date || '—'}{r.season_label ? ` · ${r.season_label}` : ''}</p>
              ))}
            </div>
          </details>
        )}
      </section>

      {/* coach access */}
      <AccessPanel
        kind="teams"
        id={teamId}
        title="Coach access"
        subtitle="Coaches see this team's roster and schedule — not full player profiles. Send the invite link so they can claim their account."
        onError={setError}
      />

      {/* tournament participation */}
      <section className="rounded-2xl border p-6" style={cardStyle}>
        <h2 className="text-lg font-bold text-white mb-4">Tournament entries</h2>
        {entries.length === 0 ? (
          <p className="text-sm" style={{ color: '#94a3b8' }}>
            Not entered in any tournaments yet. Add entries from a <Link to="/admin/tournaments" className="hover:underline" style={{ color: '#38bdf8' }}>tournament</Link>.
          </p>
        ) : (
          <div className="flex flex-col gap-2 text-sm">
            {entries.map(e => (
              <Link key={e.id} to={`/admin/tournaments/${e.tournament_id}`} className="hover:underline" style={{ color: '#cfe8ff' }}>
                <b>{e.tournament_name}</b> · {e.division_name} · {e.start_date}
                {e.placement ? ` · finished ${e.placement}` : ''}{e.status !== 'active' ? ` · ${e.status}` : ''}
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
