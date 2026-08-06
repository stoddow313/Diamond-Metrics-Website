import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { Field, TextInput, Select, PrimaryButton, ErrorNote } from '../../components/admin/ui';
import { cardStyle } from '../../components/admin/theme';

// Teams list + creation. Teams belong to an organization (school/club/program);
// creating one inline keeps the flow to a single form.
export default function AdminTeamsPage() {
  const [teams, setTeams] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ organization_id: '', new_org_name: '', name: '', age_group: '', level: '' });
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([api.listTeams(), api.listOrgs()])
      .then(([t, o]) => { setTeams(t.teams); setOrgs(o.organizations); })
      .catch(err => setError(err.message));
  }, []);

  async function handleCreate(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      let orgId = form.organization_id;
      if (orgId === '__new__') {
        if (!form.new_org_name.trim()) throw new Error('Enter a name for the new organization');
        const { organization } = await api.createOrg({ name: form.new_org_name.trim() });
        orgId = organization.id;
      }
      if (!orgId) throw new Error('Pick an organization');
      const { team } = await api.createTeam({
        organization_id: Number(orgId), name: form.name.trim(),
        age_group: form.age_group.trim(), level: form.level.trim(),
      });
      navigate(`/admin/teams/${team.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Teams</h1>
          <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>Organizations, rosters, and tournament participation.</p>
        </div>
        <PrimaryButton onClick={() => setShowCreate(v => !v)}>{showCreate ? 'Cancel' : '+ New Team'}</PrimaryButton>
      </div>

      <ErrorNote>{error}</ErrorNote>

      {showCreate && (
        <form onSubmit={handleCreate} className="rounded-2xl border p-6 mb-6 grid grid-cols-2 md:grid-cols-5 gap-4 items-end" style={cardStyle}>
          <Field label="Organization">
            <Select value={form.organization_id} onChange={e => setForm({ ...form, organization_id: e.target.value })} required>
              <option value="">—</option>
              {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              <option value="__new__">+ New organization…</option>
            </Select>
          </Field>
          {form.organization_id === '__new__' && (
            <Field label="New organization name">
              <TextInput value={form.new_org_name} onChange={e => setForm({ ...form, new_org_name: e.target.value })} required autoFocus />
            </Field>
          )}
          <Field label="Team name">
            <TextInput value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required placeholder="Bingham Miners" />
          </Field>
          <Field label="Age group">
            <TextInput value={form.age_group} onChange={e => setForm({ ...form, age_group: e.target.value })} placeholder="16U" />
          </Field>
          <Field label="Level">
            <TextInput value={form.level} onChange={e => setForm({ ...form, level: e.target.value })} placeholder="Gold" />
          </Field>
          <PrimaryButton type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create team'}</PrimaryButton>
        </form>
      )}

      {teams === null ? (
        <p style={{ color: '#94a3b8' }}>Loading…</p>
      ) : teams.length === 0 ? (
        <div className="rounded-2xl border p-10 text-center" style={cardStyle}>
          <p className="text-white font-bold mb-1">No teams yet</p>
          <p className="text-sm" style={{ color: '#94a3b8' }}>Create your first team to start building rosters.</p>
        </div>
      ) : (
        <div className="rounded-2xl border overflow-hidden" style={cardStyle}>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider" style={{ color: '#64748b' }}>
                <th className="px-5 py-3">Team</th>
                <th className="px-5 py-3">Organization</th>
                <th className="px-5 py-3">Age / Level</th>
                <th className="px-5 py-3">Active roster</th>
                <th className="px-5 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {teams.map(t => (
                <tr key={t.id} className="border-t cursor-pointer hover:bg-slate-800/40" style={{ borderColor: '#1e3a5f' }}
                  onClick={() => navigate(`/admin/teams/${t.id}`)}>
                  <td className="px-5 py-3 font-bold text-white">{t.name}</td>
                  <td className="px-5 py-3" style={{ color: '#94a3b8' }}>{t.organization_name}</td>
                  <td className="px-5 py-3" style={{ color: '#cfe8ff' }}>{[t.age_group, t.level].filter(Boolean).join(' · ')}</td>
                  <td className="px-5 py-3" style={{ color: '#94a3b8' }}>{t.roster_count}</td>
                  <td className="px-5 py-3">
                    <span className="text-xs font-bold" style={{ color: t.active ? '#4ade80' : '#64748b' }}>
                      {t.active ? 'Active' : 'Inactive'}
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
