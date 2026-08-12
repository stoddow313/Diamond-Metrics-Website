import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { Field, TextInput, Select, PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import { cardStyle } from '../../components/admin/theme';
import AccessPanel from '../../components/admin/AccessPanel';

// Tournament editor: divisions → entries → event rosters (with guests) →
// games with scores. Event rosters override season rosters and never touch
// the permanent team roster.
export default function AdminTournamentEditorPage() {
  const { tournamentId } = useParams();
  const [tournament, setTournament] = useState(null);
  const [divisions, setDivisions] = useState([]);
  const [entries, setEntries] = useState([]);
  const [games, setGames] = useState([]);
  const [teams, setTeams] = useState([]);
  const [error, setError] = useState('');

  const [tick, setTick] = useState(0);
  const load = () => setTick(t => t + 1);

  useEffect(() => {
    Promise.all([api.getTournament(tournamentId), api.listTeams()])
      .then(([detail, teamList]) => {
        setTournament(detail.tournament);
        setDivisions(detail.divisions);
        setEntries(detail.entries);
        setGames(detail.games);
        setTeams(teamList.teams);
      })
      .catch(err => setError(err.message));
  }, [tournamentId, tick]);

  if (error && !tournament) return <ErrorNote>{error}</ErrorNote>;
  if (!tournament) return <p style={{ color: '#94a3b8' }}>Loading…</p>;

  return (
    <div>
      <div className="flex items-start justify-between mb-6">
        <div>
          <Link to="/admin/tournaments" className="text-xs hover:underline" style={{ color: '#64748b' }}>← All tournaments</Link>
          <h1 className="text-2xl font-bold text-white mt-1">{tournament.name}</h1>
          <p className="text-sm" style={{ color: '#94a3b8' }}>
            {tournament.start_date} → {tournament.end_date}{tournament.location ? ` · ${tournament.location}` : ''}
            {' · '}
            <a href={`/tournaments/${tournament.slug}`} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: '#38bdf8' }}>
              View dashboard ↗
            </a>
          </p>
        </div>
        <GhostButton
          type="button"
          onClick={async () => {
            const { tournament: t } = await api.updateTournament(tournament.id, { published: tournament.published ? 0 : 1 });
            setTournament(t);
          }}
          style={tournament.published ? { borderColor: '#166534', color: '#4ade80' } : {}}
        >
          {tournament.published ? 'Published ✓ (click to unpublish)' : 'Private — publish'}
        </GhostButton>
      </div>

      <ErrorNote>{error}</ErrorNote>

      <AccessPanel
        kind="tournaments"
        id={tournamentId}
        title="Director access"
        subtitle="Directors see this tournament's divisions, teams, and games. Send the invite link so they can claim their account."
        onError={setError}
      />

      <DivisionsSection tournament={tournament} divisions={divisions} onChange={load} onError={setError} />
      <EntriesSection tournament={tournament} divisions={divisions} entries={entries} teams={teams} onChange={load} onError={setError} />
      <GamesSection tournament={tournament} divisions={divisions} entries={entries} games={games} onChange={load} onError={setError} />
    </div>
  );
}

function DivisionsSection({ tournament, divisions, onChange, onError }) {
  const [form, setForm] = useState({ name: '', age_group: '' });

  async function add(e) {
    e.preventDefault();
    try {
      await api.createDivision(tournament.id, form);
      setForm({ name: '', age_group: '' });
      await onChange();
    } catch (err) { onError(err.message); }
  }

  return (
    <section className="rounded-2xl border p-6 mb-6" style={cardStyle}>
      <h2 className="text-lg font-bold text-white mb-4">Divisions</h2>
      <form onSubmit={add} className="flex flex-wrap gap-3 items-end mb-4">
        <Field label="Name"><TextInput value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required placeholder="16U Gold" /></Field>
        <Field label="Age group"><TextInput value={form.age_group} onChange={e => setForm({ ...form, age_group: e.target.value })} placeholder="16U" /></Field>
        <PrimaryButton type="submit">+ Add division</PrimaryButton>
      </form>
      {divisions.length === 0 ? (
        <p className="text-sm" style={{ color: '#94a3b8' }}>No divisions yet — entries and games need one.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {divisions.map(d => (
            <span key={d.id} className="px-3 py-1.5 rounded-lg border text-sm font-bold" style={{ borderColor: '#1e3a5f', color: '#cfe8ff' }}>
              {d.name}
              <button
                className="ml-2 cursor-pointer"
                style={{ color: '#64748b' }}
                title="Delete (only when empty)"
                onClick={async () => {
                  try { await api.deleteDivision(d.id); await onChange(); }
                  catch (err) { onError(err.message); }
                }}
              >×</button>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function EntriesSection({ tournament, divisions, entries, teams, onChange, onError }) {
  const [form, setForm] = useState({ division_id: '', team_id: '', seed: '' });
  const [openEntryId, setOpenEntryId] = useState(null);

  async function add(e) {
    e.preventDefault();
    try {
      await api.createEntry(tournament.id, {
        division_id: Number(form.division_id), team_id: Number(form.team_id),
        seed: form.seed ? Number(form.seed) : null,
      });
      setForm({ division_id: '', team_id: '', seed: '' });
      await onChange();
    } catch (err) { onError(err.message); }
  }

  return (
    <section className="rounded-2xl border p-6 mb-6" style={cardStyle}>
      <h2 className="text-lg font-bold text-white mb-1">Participating teams</h2>
      <p className="text-xs mb-4" style={{ color: '#94a3b8' }}>
        Each entry has its own event roster — season players plus guests, without changing the permanent roster.
      </p>

      <form onSubmit={add} className="flex flex-wrap gap-3 items-end mb-4">
        <Field label="Division">
          <Select value={form.division_id} onChange={e => setForm({ ...form, division_id: e.target.value })} required>
            <option value="">—</option>
            {divisions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </Field>
        <Field label="Team">
          <Select value={form.team_id} onChange={e => setForm({ ...form, team_id: e.target.value })} required>
            <option value="">—</option>
            {teams.map(t => <option key={t.id} value={t.id}>{t.name}{t.age_group ? ` (${t.age_group})` : ''}</option>)}
          </Select>
        </Field>
        <Field label="Seed"><TextInput type="number" value={form.seed} onChange={e => setForm({ ...form, seed: e.target.value })} style={{ width: 80 }} /></Field>
        <PrimaryButton type="submit">+ Enter team</PrimaryButton>
      </form>

      {entries.length === 0 ? (
        <p className="text-sm" style={{ color: '#94a3b8' }}>No teams entered yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {entries.map(e => (
            <div key={e.id} className="rounded-xl border" style={{ borderColor: '#1e3a5f' }}>
              <button type="button" onClick={() => setOpenEntryId(openEntryId === e.id ? null : e.id)}
                className="w-full flex items-center justify-between px-4 py-3 cursor-pointer text-left">
                <span className="font-bold text-white text-sm">
                  {e.team_name} <span className="font-normal" style={{ color: '#94a3b8' }}>· {e.division_name}{e.seed ? ` · seed ${e.seed}` : ''}</span>
                </span>
                <span className="text-xs" style={{ color: '#64748b' }}>
                  {e.event_roster_count > 0 ? `${e.event_roster_count} on event roster` : 'season roster'} {openEntryId === e.id ? '▾' : '▸'}
                </span>
              </button>
              {openEntryId === e.id && <EventRosterEditor entryId={e.id} onError={onError} onChanged={onChange} />}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function EventRosterEditor({ entryId, onError, onChanged }) {
  const [data, setData] = useState(null);
  const [players, setPlayers] = useState([]);
  const [form, setForm] = useState({ player_id: '', is_guest: false, jersey: '' });

  const [tick, setTick] = useState(0);
  const load = () => setTick(t => t + 1);

  useEffect(() => {
    Promise.all([api.getEntryRoster(entryId), api.listPlayers()])
      .then(([rosterData, playerList]) => {
        setData(rosterData);
        setPlayers(playerList.players);
      })
      .catch(err => onError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId, tick]);

  async function add(e) {
    e.preventDefault();
    try {
      await api.addEventRosterRow(entryId, { player_id: Number(form.player_id), is_guest: form.is_guest ? 1 : 0, jersey: form.jersey });
      setForm({ player_id: '', is_guest: false, jersey: '' });
      await load();
      await onChanged();
    } catch (err) { onError(err.message); }
  }

  if (!data) return <p className="px-4 pb-4 text-sm" style={{ color: '#94a3b8' }}>Loading roster…</p>;

  return (
    <div className="px-4 pb-4 border-t pt-3" style={{ borderColor: '#1e3a5f' }}>
      <p className="text-xs mb-3" style={{ color: '#64748b' }}>
        {data.source === 'season'
          ? 'Showing the season roster as of the event date — add players to lock an explicit event roster.'
          : 'Explicit event roster (overrides the season roster for this event).'}
      </p>

      <form onSubmit={add} className="flex flex-wrap gap-3 items-end mb-3">
        <Field label="Player">
          <Select value={form.player_id} onChange={e => setForm({ ...form, player_id: e.target.value })} required>
            <option value="">—</option>
            {players.map(p => <option key={p.id} value={p.id}>{p.first_name} {p.last_name}</option>)}
          </Select>
        </Field>
        <Field label="Jersey"><TextInput value={form.jersey} onChange={e => setForm({ ...form, jersey: e.target.value })} style={{ width: 80 }} /></Field>
        <label className="flex items-center gap-2 text-sm pb-2" style={{ color: '#cfe8ff' }}>
          <input type="checkbox" checked={form.is_guest} onChange={e => setForm({ ...form, is_guest: e.target.checked })} />
          Guest player
        </label>
        <PrimaryButton type="submit">+ Add</PrimaryButton>
      </form>

      {data.roster.length === 0 ? (
        <p className="text-sm" style={{ color: '#94a3b8' }}>Nobody on this roster yet.</p>
      ) : (
        <div className="flex flex-col gap-1 text-sm">
          {data.roster.map(r => (
            <div key={r.player_id} className="flex items-center gap-3">
              <span className="font-bold text-white">{r.player ? `${r.player.first_name} ${r.player.last_name}` : `#${r.player_id}`}</span>
              {r.jersey && <span style={{ color: '#94a3b8' }}>#{r.jersey}</span>}
              {r.isGuest && (
                <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(251,191,36,0.15)', color: '#fbbf24' }}>Guest</span>
              )}
              <span className="text-xs" style={{ color: '#475569' }}>{r.source === 'season' ? 'season roster' : ''}</span>
              {r.event_roster_id && (
                <button className="text-xs cursor-pointer hover:underline" style={{ color: '#64748b' }}
                  onClick={async () => { await api.removeEventRosterRow(r.event_roster_id); await load(); await onChanged(); }}>
                  remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GamesSection({ tournament, divisions, entries, games, onChange, onError }) {
  const [form, setForm] = useState({ division_id: '', home_entry_id: '', away_entry_id: '', game_date: '', game_time: '', field: '' });

  const entriesForDivision = form.division_id
    ? entries.filter(e => e.division_id === Number(form.division_id))
    : entries;

  async function add(e) {
    e.preventDefault();
    try {
      await api.createTournamentGame(tournament.id, {
        division_id: Number(form.division_id),
        home_entry_id: Number(form.home_entry_id),
        away_entry_id: Number(form.away_entry_id),
        game_date: form.game_date, game_time: form.game_time, field: form.field,
      });
      setForm({ division_id: '', home_entry_id: '', away_entry_id: '', game_date: '', game_time: '', field: '' });
      await onChange();
    } catch (err) { onError(err.message); }
  }

  async function saveScore(game, home, away) {
    try {
      await api.updateTournamentGame(game.id, {
        home_score: home === '' ? null : Number(home),
        away_score: away === '' ? null : Number(away),
        status: home !== '' && away !== '' ? 'final' : game.status,
      });
      await onChange();
    } catch (err) { onError(err.message); }
  }

  return (
    <section className="rounded-2xl border p-6" style={cardStyle}>
      <h2 className="text-lg font-bold text-white mb-4">Games</h2>

      <form onSubmit={add} className="grid grid-cols-2 md:grid-cols-7 gap-3 items-end mb-4 p-4 rounded-xl" style={{ backgroundColor: 'rgba(30, 41, 59, 0.5)' }}>
        <Field label="Division">
          <Select value={form.division_id} onChange={e => setForm({ ...form, division_id: e.target.value, home_entry_id: '', away_entry_id: '' })} required>
            <option value="">—</option>
            {divisions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </Field>
        <Field label="Home">
          <Select value={form.home_entry_id} onChange={e => setForm({ ...form, home_entry_id: e.target.value })} required>
            <option value="">—</option>
            {entriesForDivision.map(en => <option key={en.id} value={en.id}>{en.team_name}</option>)}
          </Select>
        </Field>
        <Field label="Away">
          <Select value={form.away_entry_id} onChange={e => setForm({ ...form, away_entry_id: e.target.value })} required>
            <option value="">—</option>
            {entriesForDivision.filter(en => en.id !== Number(form.home_entry_id)).map(en => <option key={en.id} value={en.id}>{en.team_name}</option>)}
          </Select>
        </Field>
        <Field label="Date"><TextInput type="date" value={form.game_date} onChange={e => setForm({ ...form, game_date: e.target.value })} required /></Field>
        <Field label="Time"><TextInput type="time" value={form.game_time} onChange={e => setForm({ ...form, game_time: e.target.value })} /></Field>
        <Field label="Field"><TextInput value={form.field} onChange={e => setForm({ ...form, field: e.target.value })} /></Field>
        <PrimaryButton type="submit">+ Add game</PrimaryButton>
      </form>

      {games.length === 0 ? (
        <p className="text-sm" style={{ color: '#94a3b8' }}>No games scheduled.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {games.map(g => <GameRow key={g.id} game={g} onSave={saveScore} />)}
        </div>
      )}
    </section>
  );
}

function GameRow({ game, onSave }) {
  const [home, setHome] = useState(game.home_score ?? '');
  const [away, setAway] = useState(game.away_score ?? '');

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border px-4 py-2.5 text-sm" style={{ borderColor: '#1e3a5f' }}>
      <span style={{ color: '#94a3b8' }}>{game.game_date}{game.game_time ? ` ${game.game_time}` : ''}</span>
      <span className="text-xs px-2 py-0.5 rounded uppercase" style={{ backgroundColor: 'rgba(56,189,248,0.12)', color: '#38bdf8' }}>{game.division_name}</span>
      <span className="font-bold text-white flex-1 min-w-[200px]">{game.home_team_name} vs {game.away_team_name}</span>
      <span className="flex items-center gap-1.5">
        <TextInput type="number" value={home} onChange={e => setHome(e.target.value)} style={{ width: 56, padding: '4px 8px' }} aria-label="Home score" />
        <span style={{ color: '#64748b' }}>–</span>
        <TextInput type="number" value={away} onChange={e => setAway(e.target.value)} style={{ width: 56, padding: '4px 8px' }} aria-label="Away score" />
      </span>
      <GhostButton type="button" onClick={() => onSave(game, home, away)} style={{ padding: '4px 12px', fontSize: 12 }}>Save</GhostButton>
      <span className="text-xs font-bold uppercase" style={{ color: game.status === 'final' ? '#4ade80' : '#64748b' }}>{game.status}</span>
    </div>
  );
}
