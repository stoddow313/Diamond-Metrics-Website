import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { Field, TextInput, PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import { cardStyle } from '../../components/admin/theme';

export default function AdminPlayersPage() {
  const [players, setPlayers] = useState(null);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    api.listPlayers()
      .then(({ players }) => setPlayers(players))
      .catch(err => setError(err.message));
  }, []);

  async function handleCreate(e) {
    e.preventDefault();
    setCreating(true);
    setError('');
    try {
      const { player } = await api.createPlayer({ first_name: firstName.trim(), last_name: lastName.trim() });
      navigate(`/admin/players/${player.id}`);
    } catch (err) {
      setError(err.message);
      setCreating(false);
    }
  }

  function toggle(id) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(prev => (prev.size === players.length ? new Set() : new Set(players.map(p => p.id))));
  }

  async function handleBulkDelete() {
    const names = players.filter(p => selected.has(p.id)).map(p => `${p.first_name} ${p.last_name}`);
    const preview = names.slice(0, 8).join(', ') + (names.length > 8 ? `, … (+${names.length - 8} more)` : '');
    const ok = window.confirm(
      `Permanently delete ${names.length} player${names.length === 1 ? '' : 's'} and ALL their data ` +
      `(games, stats, ratings, roster spots, event rosters, accounts)?\n\n${preview}\n\nThis cannot be undone.`
    );
    if (!ok) return;
    setDeleting(true);
    setError('');
    try {
      await api.bulkDeletePlayers([...selected]);
      setPlayers(players.filter(p => !selected.has(p.id)));
      setSelected(new Set());
    } catch (err) {
      setError(err.message);
    }
    setDeleting(false);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Players</h1>
          <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>Create player profiles and log game-by-game stats.</p>
        </div>
        <div className="flex items-center gap-3">
          {selected.size > 0 && (
            <GhostButton onClick={handleBulkDelete} disabled={deleting} style={{ borderColor: '#7f1d1d', color: '#f87171' }}>
              {deleting ? 'Deleting…' : `Delete selected (${selected.size})`}
            </GhostButton>
          )}
          <PrimaryButton onClick={() => setShowCreate(v => !v)}>
            {showCreate ? 'Cancel' : '+ New Player'}
          </PrimaryButton>
        </div>
      </div>

      <ErrorNote>{error}</ErrorNote>

      {showCreate && (
        <form onSubmit={handleCreate} className="rounded-2xl border p-6 mb-6 flex items-end gap-4" style={cardStyle}>
          <div className="flex-1">
            <Field label="First name">
              <TextInput value={firstName} onChange={e => setFirstName(e.target.value)} required autoFocus />
            </Field>
          </div>
          <div className="flex-1">
            <Field label="Last name">
              <TextInput value={lastName} onChange={e => setLastName(e.target.value)} required />
            </Field>
          </div>
          <PrimaryButton type="submit" disabled={creating}>
            {creating ? 'Creating…' : 'Create profile'}
          </PrimaryButton>
        </form>
      )}

      {players === null ? (
        <p style={{ color: '#94a3b8' }}>Loading…</p>
      ) : players.length === 0 ? (
        <div className="rounded-2xl border p-10 text-center" style={cardStyle}>
          <p className="text-white font-bold mb-1">No players yet</p>
          <p className="text-sm" style={{ color: '#94a3b8' }}>Create your first player profile to start logging stats.</p>
        </div>
      ) : (
        <div className="rounded-2xl border overflow-hidden" style={cardStyle}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider" style={{ color: '#64748b' }}>
                <th className="px-4 py-3 w-10">
                  <input
                    type="checkbox"
                    aria-label="Select all players"
                    checked={selected.size === players.length && players.length > 0}
                    onChange={toggleAll}
                    className="cursor-pointer accent-sky-400"
                  />
                </th>
                <th className="px-5 py-3">Player</th>
                <th className="px-5 py-3">Position</th>
                <th className="px-5 py-3">School</th>
                <th className="px-5 py-3">Class</th>
                <th className="px-5 py-3">Games logged</th>
                <th className="px-5 py-3">Public link</th>
              </tr>
            </thead>
            <tbody>
              {players.map(p => (
                <tr
                  key={p.id}
                  className="border-t cursor-pointer hover:bg-slate-800/40"
                  style={{ borderColor: '#1e3a5f', backgroundColor: selected.has(p.id) ? 'rgba(56, 189, 248, 0.06)' : undefined }}
                  onClick={() => navigate(`/admin/players/${p.id}`)}
                >
                  <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${p.first_name} ${p.last_name}`}
                      checked={selected.has(p.id)}
                      onChange={() => toggle(p.id)}
                      className="cursor-pointer accent-sky-400"
                    />
                  </td>
                  <td className="px-5 py-3 font-bold text-white">{p.first_name} {p.last_name}</td>
                  <td className="px-5 py-3" style={{ color: '#cfe8ff' }}>
                    {p.primary_position}{p.secondary_position ? ` / ${p.secondary_position}` : ''}
                  </td>
                  <td className="px-5 py-3" style={{ color: '#94a3b8' }}>{p.school}</td>
                  <td className="px-5 py-3" style={{ color: '#94a3b8' }}>{p.grad_year || ''}</td>
                  <td className="px-5 py-3" style={{ color: '#94a3b8' }}>{p.game_count}</td>
                  <td className="px-5 py-3" onClick={e => e.stopPropagation()}>
                    <Link to={`/p/${p.slug}`} target="_blank" className="hover:underline" style={{ color: '#38bdf8' }}>
                      /p/{p.slug}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
