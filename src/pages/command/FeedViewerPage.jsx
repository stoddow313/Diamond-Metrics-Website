import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import FeedPlayer from './FeedPlayer';
import { cardStyle } from '../../components/admin/theme';

// Feed viewer (M2): frame-accurate review surface. The player itself is the
// shared FeedPlayer component (also used by the M4 running queue); its
// stepping math is validated by the frame-accuracy gate.

export default function FeedViewerPage() {
  const { feedId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.commandFeed(feedId).then(setData).catch(err => setError(err.message));
  }, [feedId]);

  if (error) return <p style={{ color: '#f87171' }}>{error}</p>;
  if (!data) return <p style={{ color: '#94a3b8' }}>Loading feed…</p>;
  const { feed } = data;
  const proxy = data.renditions.find(r => r.kind === 'proxy');
  const fps = proxy?.fps || feed.effective_fps || 30;

  return (
    <div>
      <Link to={`/command/jobs/${feed.job_id}`} className="text-xs hover:underline" style={{ color: '#64748b' }}>← Job</Link>
      <div className="mt-1 mb-4">
        <h1 className="text-2xl font-bold text-white">{feed.label} · {feed.team_name} {feed.game_date}</h1>
        <p className="text-sm" style={{ color: '#94a3b8' }}>
          {feed.width}×{feed.height} · source {feed.effective_fps?.toFixed(2)} fps
          {feed.vfr ? ' · VFR normalized in proxy' : ' · CFR'}
          {proxy ? ` · proxy ${proxy.fps?.toFixed(2)} fps` : ''}
        </p>
      </div>

      {!proxy ? (
        <div className="rounded-2xl border p-10 text-center" style={cardStyle}>
          <p className="text-white font-bold">Proxy not ready</p>
          <p className="text-sm mt-1" style={{ color: '#94a3b8' }}>Feed status: {feed.status}{feed.error ? ` — ${feed.error}` : ''}</p>
        </div>
      ) : (
        <>
          <FeedPlayer src={proxy.url} fps={fps} />
          <p className="text-xs mt-2" style={{ color: '#64748b' }}>← / → step 1 · shift+← / → step 10 · space play/pause</p>
        </>
      )}
    </div>
  );
}
