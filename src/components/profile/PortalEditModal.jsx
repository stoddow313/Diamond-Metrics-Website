import { useState } from 'react';
import { X, Camera, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';

// Self-service profile editing for claimed player accounts: demographics and
// photo only — stats, ratings, and projections stay admin-side.

const POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'OF', 'IF', 'UTIL', 'RHP', 'LHP'];

const FIELD_DEFS = [
  { key: 'first_name', label: 'First name', required: true },
  { key: 'last_name', label: 'Last name', required: true },
  { key: 'school', label: 'High school' },
  { key: 'grad_year', label: 'Grad class', type: 'number', placeholder: '2027' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'height', label: 'Height', placeholder: `6'2"` },
  { key: 'weight_lbs', label: 'Weight (lbs)', type: 'number' },
  { key: 'committed_to', label: 'Committed to', placeholder: 'Undecided' },
];

// Downscale on-device so phone photos upload fast and stay under the API cap.
async function fileToDataUrl(file, max = 1000) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

export default function PortalEditModal({ player, onClose, onSaved }) {
  const [form, setForm] = useState(() => {
    const f = {};
    for (const d of FIELD_DEFS) f[d.key] = player[d.key] ?? '';
    f.primary_position = player.primary_position || '';
    f.bats = player.bats || '';
    f.throws = player.throws || '';
    return f;
  });
  const [secondaries, setSecondaries] = useState(
    (player.secondary_position || '').split(',').map(s => s.trim()).filter(Boolean)
  );
  const [photoPreview, setPhotoPreview] = useState(player.photo_url || '');
  const [newPhoto, setNewPhoto] = useState(null); // data URL pending upload
  const [photoRemoved, setPhotoRemoved] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function set(key, value) {
    setForm(f => ({ ...f, [key]: value }));
  }

  function toggleSecondary(pos) {
    setSecondaries(s => (s.includes(pos) ? s.filter(p => p !== pos) : [...s, pos]));
  }

  async function pickPhoto(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      setNewPhoto(dataUrl);
      setPhotoPreview(dataUrl);
      setPhotoRemoved(false);
    } catch {
      setError('Could not read that image — try a JPEG or PNG.');
    }
  }

  async function save(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (newPhoto) await api.uploadPortalPhoto(newPhoto);
      else if (photoRemoved) await api.deletePortalPhoto();
      const payload = await api.updatePortalProfile({
        ...form,
        secondary_position: secondaries.join(', '),
      });
      onSaved(payload);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const inputClass = 'w-full px-3 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 outline-none focus:border-blue-500 bg-white';
  const labelClass = 'text-xs font-bold text-slate-500';

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', backgroundColor: 'rgba(15, 28, 51, 0.55)', backdropFilter: 'blur(3px)', overflowY: 'auto', padding: 16 }}
    >
      <form onSubmit={save} className="bg-white rounded-2xl border border-slate-200 shadow-xl w-full max-w-lg p-6" style={{ margin: 'auto' }}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-bold text-slate-900">Edit profile</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 cursor-pointer">
            <X size={17} />
          </button>
        </div>
        <p className="text-xs text-slate-400 mb-5">
          Update your info and photo. Stats and ratings are managed by Diamond Metrics.
        </p>

        {error && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-4">{error}</p>}

        {/* photo */}
        <div className="flex items-center gap-4 mb-5">
          <div className="w-20 h-20 rounded-xl bg-slate-100 border border-slate-200 overflow-hidden flex items-center justify-center shrink-0">
            {photoPreview
              ? <img src={photoPreview} alt="Player" className="w-full h-full object-cover" />
              : <Camera size={22} className="text-slate-300" />}
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-bold text-blue-600 cursor-pointer hover:underline">
              {photoPreview ? 'Change photo' : 'Add a photo'}
              <input type="file" accept="image/*" className="hidden" onChange={pickPhoto} />
            </label>
            {photoPreview && (
              <button
                type="button"
                onClick={() => { setPhotoPreview(''); setNewPhoto(null); setPhotoRemoved(true); }}
                className="flex items-center gap-1 text-xs text-slate-400 hover:text-red-500 cursor-pointer"
              >
                <Trash2 size={12} /> Remove photo
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {FIELD_DEFS.map(d => (
            <div key={d.key} className="flex flex-col gap-1">
              <label className={labelClass}>{d.label}</label>
              <input
                type={d.type || 'text'}
                required={d.required}
                placeholder={d.placeholder || ''}
                value={form[d.key] ?? ''}
                onChange={e => set(d.key, e.target.value)}
                className={inputClass}
              />
            </div>
          ))}
          <div className="flex flex-col gap-1">
            <label className={labelClass}>Bats</label>
            <select value={form.bats} onChange={e => set('bats', e.target.value)} className={inputClass}>
              <option value="">—</option><option>R</option><option>L</option><option>S</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className={labelClass}>Throws</label>
            <select value={form.throws} onChange={e => set('throws', e.target.value)} className={inputClass}>
              <option value="">—</option><option>R</option><option>L</option>
            </select>
          </div>
          <div className="flex flex-col gap-1 col-span-2">
            <label className={labelClass}>Primary position</label>
            <select value={form.primary_position} onChange={e => set('primary_position', e.target.value)} className={inputClass}>
              <option value="">—</option>
              {POSITIONS.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div className="col-span-2 flex flex-col gap-1.5">
            <label className={labelClass}>
              Secondary positions{secondaries.length ? ` (${secondaries.join(', ')})` : ''}
            </label>
            <div className="flex flex-wrap gap-1.5">
              {POSITIONS.map(p => {
                const isPrimary = p === form.primary_position;
                const on = secondaries.includes(p);
                return (
                  <button
                    key={p}
                    type="button"
                    disabled={isPrimary}
                    onClick={() => toggleSecondary(p)}
                    title={isPrimary ? 'Already your primary position' : undefined}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-bold border cursor-pointer transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                      on ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-300 text-slate-600 hover:border-blue-400'
                    }`}
                  >
                    {p}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl border border-slate-300 text-sm font-bold text-slate-600 hover:bg-slate-50 cursor-pointer">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-bold cursor-pointer disabled:opacity-60">
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </div>
  );
}
