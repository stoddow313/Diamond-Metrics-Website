// Thin client for the Diamond Metrics API (proxied to the Node server via Vite).

const TOKEN_KEY = 'dm_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = auth ? getToken() : null;
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }

  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  // auth
  login: (email, password) => request('/api/auth/login', { method: 'POST', body: { email, password }, auth: false }),
  me: () => request('/api/auth/me'),
  logout: () => request('/api/auth/logout', { method: 'POST' }),

  // catalog
  catalog: () => request('/api/metrics/catalog', { auth: false }),

  // players
  listPlayers: () => request('/api/players'),
  createPlayer: (player) => request('/api/players', { method: 'POST', body: player }),
  getPlayer: (id) => request(`/api/players/${id}`),
  updatePlayer: (id, player) => request(`/api/players/${id}`, { method: 'PUT', body: player }),
  deletePlayer: (id) => request(`/api/players/${id}`, { method: 'DELETE' }),

  // games + stats
  createGame: (playerId, game) => request(`/api/players/${playerId}/games`, { method: 'POST', body: game }),
  updateGame: (gameId, game) => request(`/api/games/${gameId}`, { method: 'PUT', body: game }),
  deleteGame: (gameId) => request(`/api/games/${gameId}`, { method: 'DELETE' }),
  saveGameStats: (gameId, stats) => request(`/api/games/${gameId}/stats`, { method: 'PUT', body: { stats } }),

  // public
  publicProfile: (slug) => request(`/api/public/players/${slug}`, { auth: false }),
  proDayCard: (slug) => request(`/api/public/players/${slug}/card`, { auth: false }),

  // invites (admin) + claim (public) + player portal
  getInvite: (playerId) => request(`/api/players/${playerId}/invite`),
  createInvite: (playerId) => request(`/api/players/${playerId}/invite`, { method: 'POST' }),
  inviteInfo: (token) => request(`/api/invites/${token}`, { auth: false }),
  claimInvite: (token, email, password) => request(`/api/invites/${token}/claim`, { method: 'POST', body: { email, password }, auth: false }),
  portalProfile: () => request('/api/portal/profile'),
  portalCard: () => request('/api/portal/card'),
};
