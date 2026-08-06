import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Field, TextInput, Select, PrimaryButton, GhostButton, ErrorNote } from '../../components/admin/ui';
import { cardStyle } from '../../components/admin/theme';

// Seasons list + creation + inline editing. Seasons anchor roster
// memberships and the season_roster importer, which requires the season
// label to exist before rows can be applied.

const EMPTY_FORM = { label: '', start_date: '', end_date: '', status: 'active' };

function StatusBadge({ status }) {
  const active = status === 'active';
  return (
    <span className="text-xs font-bold" style={{ color: active ? '#4ade80' : '#64748b' }}>
      {active ? 'Active' : 'Archived'}
    </span>
  );
}

export default function AdminSeasonsPage() {
  const [seasons, setSeasons] = useState(null);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [edit, setEdit] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listSeasons().then(d => setSeasons(d.seasons)).catch(err => setError(err.message));
  }, []);

  async function handleCreate(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { season } = await api.createSeason({
        label: form.label.trim(),
        start_date: form.start_date,
        end_date: form.end_date,
        status: form.status,
      });
      setSeasons([season, ...seasons].sort((a, b) => b.start_date.localeCompare(a.start_date)));
      setForm(EMPTY_FORM);
      setShowCreate(false);
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  function startEdit(s) {
    setEditingId(s.id);
    setEdit({ label: s.label, start_date: s.start_date, end_date: s.end_date, status: s.status });
    setError('');
  }

  async function saveEdit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { season } = await api.updateSeason(editingId, {
        label: edit.label.trim(),
        start_date: edit.start_date,
        end_date: edit.end_date,
        status: edit.status,
      });
      setSeasons(seasons.map(s => (s.id === season.id ? season : s)));
      setEditingId(null);
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  async function toggleArchive(s) {
    setBusy(true);
    setError('');
    try {
      const { season } = await api.updateSeason(s.id, { status: s.status === 'active' ? 'archived' : 'active' });
      setSeasons(seasons.map(x => (x.id === season.id ? season : x)));
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Seasons</h1>
          <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>
            Seasons anchor rosters — the season-roster importer needs the season to exist first.
          </p>
        </div>
        <PrimaryButton onClick={() => setShowCreate(v => !v)}>{showCreate ? 'Cancel' : '+ Create Season'}</PrimaryButton>
      </div>

      <ErrorNote>{error}</ErrorNote>

      {showCreate && (
        <form onSubmit={handleCreate} className="rounded-2xl border p-6 mb-6 grid grid-cols-2 md:grid-cols-5 gap-4 items-end" style={cardStyle}>
          <Field label="Season label">
            <TextInput value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} required placeholder="2026 Summer" autoFocus />
          </Field>
          <Field label="Start date">
            <TextInput type="date" value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })} required />
          </Field>
          <Field label="End date">
            <TextInput type="date" value={form.end_date} onChange={e => setForm({ ...form, end_date: e.target.value })} required />
          </Field>
          <Field label="Status">
            <Select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </Select>
          </Field>
          <PrimaryButton type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create season'}</PrimaryButton>
        </form>
      )}

      {seasons === null ? (
        <p style={{ color: '#94a3b8' }}>Loading…</p>
      ) : seasons.length === 0 ? (
        <div className="rounded-2xl border p-10 text-center" style={cardStyle}>
          <p className="text-white font-bold mb-1">No seasons yet</p>
          <p className="text-sm" style={{ color: '#94a3b8' }}>Create a season, then import or build rosters against it.</p>
        </div>
      ) : (
        <div className="rounded-2xl border overflow-hidden" style={cardStyle}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider" style={{ color: '#64748b' }}>
                <th className="px-5 py-3">Label</th>
                <th className="px-5 py-3">Start</th>
                <th className="px-5 py-3">End</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {seasons.map(s => editingId === s.id ? (
                <tr key={s.id} className="border-t" style={{ borderColor: '#1e3a5f', backgroundColor: 'rgba(56, 189, 248, 0.05)' }}>
                  <td className="px-5 py-3">
                    <TextInput value={edit.label} onChange={e => setEdit({ ...edit, label: e.target.value })} required />
                  </td>
                  <td className="px-5 py-3">
                    <TextInput type="date" value={edit.start_date} onChange={e => setEdit({ ...edit, start_date: e.target.value })} required />
                  </td>
                  <td className="px-5 py-3">
                    <TextInput type="date" value={edit.end_date} onChange={e => setEdit({ ...edit, end_date: e.target.value })} required />
                  </td>
                  <td className="px-5 py-3">
                    <Select value={edit.status} onChange={e => setEdit({ ...edit, status: e.target.value })}>
                      <option value="active">Active</option>
                      <option value="archived">Archived</option>
                    </Select>
                  </td>
                  <td className="px-5 py-3 text-right whitespace-nowrap">
                    <PrimaryButton onClick={saveEdit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</PrimaryButton>
                    <span className="inline-block w-2" />
                    <GhostButton onClick={() => setEditingId(null)}>Cancel</GhostButton>
                  </td>
                </tr>
              ) : (
                <tr key={s.id} className="border-t" style={{ borderColor: '#1e3a5f' }}>
                  <td className="px-5 py-3 font-bold text-white">{s.label}</td>
                  <td className="px-5 py-3" style={{ color: '#cfe8ff' }}>{s.start_date}</td>
                  <td className="px-5 py-3" style={{ color: '#cfe8ff' }}>{s.end_date}</td>
                  <td className="px-5 py-3"><StatusBadge status={s.status} /></td>
                  <td className="px-5 py-3 text-right whitespace-nowrap">
                    <GhostButton onClick={() => startEdit(s)}>Edit</GhostButton>
                    <span className="inline-block w-2" />
                    <GhostButton onClick={() => toggleArchive(s)} disabled={busy}>
                      {s.status === 'active' ? 'Archive' : 'Unarchive'}
                    </GhostButton>
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
