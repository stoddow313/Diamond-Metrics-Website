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
  bulkDeletePlayers: (ids) => request('/api/players/bulk-delete', { method: 'POST', body: { ids } }),

  // games + stats
  createGame: (playerId, game) => request(`/api/players/${playerId}/games`, { method: 'POST', body: game }),
  updateGame: (gameId, game) => request(`/api/games/${gameId}`, { method: 'PUT', body: game }),
  deleteGame: (gameId) => request(`/api/games/${gameId}`, { method: 'DELETE' }),
  saveGameStats: (gameId, stats) => request(`/api/games/${gameId}/stats`, { method: 'PUT', body: { stats } }),

  // team & tournament platform (admin)
  listOrgs: () => request('/api/organizations'),
  createOrg: (org) => request('/api/organizations', { method: 'POST', body: org }),
  listTeams: () => request('/api/teams'),
  createTeam: (team) => request('/api/teams', { method: 'POST', body: team }),
  getTeam: (id) => request(`/api/teams/${id}`),
  updateTeam: (id, team) => request(`/api/teams/${id}`, { method: 'PUT', body: team }),
  listSeasons: () => request('/api/seasons'),
  createSeason: (season) => request('/api/seasons', { method: 'POST', body: season }),
  updateSeason: (id, fields) => request(`/api/seasons/${id}`, { method: 'PUT', body: fields }),
  addRosterMembership: (teamId, m) => request(`/api/teams/${teamId}/roster`, { method: 'POST', body: m }),
  updateRosterMembership: (id, m) => request(`/api/roster/${id}`, { method: 'PUT', body: m }),
  listTournaments: () => request('/api/tournaments'),
  createTournament: (t) => request('/api/tournaments', { method: 'POST', body: t }),
  getTournament: (id) => request(`/api/tournaments/${id}`),
  updateTournament: (id, t) => request(`/api/tournaments/${id}`, { method: 'PUT', body: t }),
  createDivision: (tournamentId, d) => request(`/api/tournaments/${tournamentId}/divisions`, { method: 'POST', body: d }),
  deleteDivision: (id) => request(`/api/divisions/${id}`, { method: 'DELETE' }),
  createEntry: (tournamentId, e) => request(`/api/tournaments/${tournamentId}/entries`, { method: 'POST', body: e }),
  updateEntry: (id, e) => request(`/api/entries/${id}`, { method: 'PUT', body: e }),
  getEntryRoster: (entryId) => request(`/api/entries/${entryId}/roster`),
  addEventRosterRow: (entryId, row) => request(`/api/entries/${entryId}/roster`, { method: 'POST', body: row }),
  removeEventRosterRow: (id) => request(`/api/event-roster/${id}`, { method: 'DELETE' }),
  createTournamentGame: (tournamentId, g) => request(`/api/tournaments/${tournamentId}/games`, { method: 'POST', body: g }),
  updateTournamentGame: (id, g) => request(`/api/tournament-games/${id}`, { method: 'PUT', body: g }),

  // server-side imports
  importKinds: () => request('/api/imports/kinds'),
  importPreview: (kind, rows, resolutions = {}) => request('/api/imports/preview', { method: 'POST', body: { kind, rows, resolutions } }),
  importApply: (kind, rows, resolutions = {}, filename = '') => request('/api/imports/apply', { method: 'POST', body: { kind, rows, resolutions, filename } }),
  importAudits: () => request('/api/imports/audits'),

  // staff (coach/director) access
  getAccess: (kind, id) => request(`/api/${kind}/${id}/access`),           // kind: 'teams' | 'tournaments'
  addAccess: (kind, id, email) => request(`/api/${kind}/${id}/access`, { method: 'POST', body: { email } }),
  removeAccess: (kind, id) => request(`/api/${kind === 'teams' ? 'team' : 'tournament'}-access/${id}`, { method: 'DELETE' }),
  staffInviteInfo: (token) => request(`/api/staff-invites/${token}`, { auth: false }),
  claimStaffInvite: (token, name, password) => request(`/api/staff-invites/${token}/claim`, { method: 'POST', body: { name, password }, auth: false }),
  staffOverview: () => request('/api/staff/overview'),
  staffTeam: (id) => request(`/api/staff/teams/${id}`),
  staffTournament: (id) => request(`/api/staff/tournaments/${id}`),

  // connected views (viewer-aware: token attaches when signed in)
  viewTeam: (slug, params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
    return request(`/api/view/teams/${slug}${qs ? `?${qs}` : ''}`);
  },
  viewTournament: (slug) => request(`/api/view/tournaments/${slug}`),

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
  updatePortalProfile: (fields) => request('/api/portal/profile', { method: 'PUT', body: fields }),
  uploadPortalPhoto: (image) => request('/api/portal/photo', { method: 'POST', body: { image } }),
  deletePortalPhoto: () => request('/api/portal/photo', { method: 'DELETE' }),
};
