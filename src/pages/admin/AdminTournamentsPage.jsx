import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { Field, TextInput, PrimaryButton, ErrorNote } from '../../components/admin/ui';
import { cardStyle } from '../../components/admin/theme';

export default function AdminTournamentsPage() {
  const [tournaments, setTournaments] = useState(null);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', start_date: '', end_date: '', location: '', organizer: '' });
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    api.listTournaments().then(t => setTournaments(t.tournaments)).catch(err => setError(err.message));
  }, []);

  async function handleCreate(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { tournament } = await api.createTournament(form);
      navigate(`/admin/tournaments/${tournament.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Tournaments</h1>
          <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>Events, divisions, entries, and games.</p>
        </div>
        <PrimaryButton onClick={() => setShowCreate(v => !v)}>{showCreate ? 'Cancel' : '+ New Tournament'}</PrimaryButton>
      </div>

      <ErrorNote>{error}</ErrorNote>

      {showCreate && (
        <form onSubmit={handleCreate} className="rounded-2xl border p-6 mb-6 grid grid-cols-2 md:grid-cols-5 gap-4 items-end" style={cardStyle}>
          <Field label="Name"><TextInput value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required placeholder="Salt Lake Summer Classic" /></Field>
          <Field label="Start date"><TextInput type="date" value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })} required /></Field>
          <Field label="End date"><TextInput type="date" value={form.end_date} onChange={e => setForm({ ...form, end_date: e.target.value })} required /></Field>
          <Field label="Location"><TextInput value={form.location} onChange={e => setForm({ ...form, location: e.target.value })} /></Field>
          <PrimaryButton type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create'}</PrimaryButton>
        </form>
      )}

      {tournaments === null ? (
        <p style={{ color: '#94a3b8' }}>Loading…</p>
      ) : tournaments.length === 0 ? (
        <div className="rounded-2xl border p-10 text-center" style={cardStyle}>
          <p className="text-white font-bold mb-1">No tournaments yet</p>
          <p className="text-sm" style={{ color: '#94a3b8' }}>Create an event to start adding divisions, teams, and games.</p>
        </div>
      ) : (
        <div className="rounded-2xl border overflow-hidden" style={cardStyle}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider" style={{ color: '#64748b' }}>
                <th className="px-5 py-3">Tournament</th>
                <th className="px-5 py-3">Dates</th>
                <th className="px-5 py-3">Divisions</th>
                <th className="px-5 py-3">Teams</th>
                <th className="px-5 py-3">Games</th>
                <th className="px-5 py-3">Visibility</th>
              </tr>
            </thead>
            <tbody>
              {tournaments.map(t => (
                <tr key={t.id} className="border-t cursor-pointer hover:bg-slate-800/40" style={{ borderColor: '#1e3a5f' }}
                  onClick={() => navigate(`/admin/tournaments/${t.id}`)}>
                  <td className="px-5 py-3 font-bold text-white">{t.name}</td>
                  <td className="px-5 py-3" style={{ color: '#94a3b8' }}>{t.start_date} → {t.end_date}</td>
                  <td className="px-5 py-3" style={{ color: '#cfe8ff' }}>{t.division_count}</td>
                  <td className="px-5 py-3" style={{ color: '#cfe8ff' }}>{t.entry_count}</td>
                  <td className="px-5 py-3" style={{ color: '#cfe8ff' }}>{t.game_count}</td>
                  <td className="px-5 py-3">
                    <span className="text-xs font-bold" style={{ color: t.published ? '#4ade80' : '#64748b' }}>
                      {t.published ? 'Published' : 'Private'}
                    </span>
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
