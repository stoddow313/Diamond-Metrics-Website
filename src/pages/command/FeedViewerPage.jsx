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
  const [notice, setNotice] = useState('');

  useEffect(() => {
    api.commandFeed(feedId).then(setData).catch(err => setError(err.message));
  }, [feedId]);

  // Keep polling while the pipeline is still working so the player appears
  // the moment the proxy lands — and a failure shows up without a reload.
  const pipelineBusy = data && ['queued', 'processing', 'retrying'].includes(data.feed.status);
  useEffect(() => {
    if (!pipelineBusy) return;
    const t = setInterval(() => api.commandFeed(feedId).then(setData).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [pipelineBusy, feedId]);

  async function retry() {
    setNotice('');
    try {
      const { stage } = await api.commandRetryFeed(feedId);
      setNotice(`Processing restarted at the ${stage === 'proxy' ? 'review-proxy encode' : 'media inspection'} step — the original in storage is reused, nothing to re-upload.`);
      setData(await api.commandFeed(feedId));
    } catch (err) {
      setError(err.message);
    }
  }

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
          {feed.width
            ? `${feed.width}×${feed.height} · source ${feed.effective_fps?.toFixed(2)} fps${feed.vfr ? ' · VFR normalized in proxy' : ' · CFR'}`
            : `${feed.original_name || 'original'} · not yet inspected`}
          {proxy ? ` · proxy ${proxy.fps?.toFixed(2)} fps` : ''}
        </p>
      </div>

      {!proxy ? (
        <div className="rounded-2xl border p-10 text-center" style={cardStyle}>
          <p className="text-white font-bold">{feed.status === 'failed' ? 'Failed processing' : 'Review proxy not ready'}</p>
          <p className="text-sm mt-1" style={{ color: feed.status === 'failed' ? '#f87171' : '#94a3b8' }} data-testid="feed-status-line">
            {feed.status === 'failed'
              ? feed.error || 'The media pipeline stopped without a recorded reason.'
              : `Status: ${feed.status.replace(/_/g, ' ')}${feed.processing?.status === 'running' && feed.processing.progress_pct != null ? ` · ${Math.round(feed.processing.progress_pct * 100)}%` : ''}${feed.error ? ` — ${feed.error}` : ''}`}
          </p>
          {feed.processing?.stalled && (
            <p className="text-xs mt-2" style={{ color: '#fbbf24' }}>The encoder has reported no progress for {Math.round(feed.processing.quiet_s)}s — it will be stopped and retried automatically.</p>
          )}
          {['failed', 'retrying', 'processing', 'queued'].includes(feed.status) && (feed.status !== 'processing' || feed.processing?.stalled) && (
            <button onClick={retry} className="mt-4 px-4 py-2 rounded-lg text-sm font-bold cursor-pointer" style={{ backgroundColor: '#38bdf8', color: '#06122b' }}>
              Retry processing
            </button>
          )}
          {notice && <p className="text-xs mt-3" style={{ color: '#fbbf24' }}>{notice}</p>}
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
