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
    // Intake responses explain themselves: a code to branch on and the list
    // of what is still missing before a submission can be sent.
    if (data?.code) err.code = data.code;
    if (data?.missing) err.missing = data.missing;
    throw err;
  }
  return data;
}

// Raw bytes to a local-storage part endpoint (dev and tests only — in
// production parts go straight to R2 on presigned URLs).
async function postRawPart(path, blob) {
  const res = await fetch(path, {
    method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/octet-stream' }, body: blob,
  });
  if (!res.ok) {
    let message = '';
    try { message = (await res.json())?.error || ''; } catch { /* non-JSON */ }
    const err = new Error(message || `Part upload failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const query = (params = {}) => {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  return qs ? `?${qs}` : '';
};

export const api = {
  // auth
  login: (email, password) => request('/api/auth/login', { method: 'POST', body: { email, password }, auth: false }),
  me: () => request('/api/auth/me'),
  logout: () => request('/api/auth/logout', { method: 'POST' }),

  // catalog
  catalog: () => request('/api/metrics/catalog', { auth: false }),

  // Field Live. The viewer page needs only these two; everything that touches a
  // stream key is staff-only and lives in Command.
  liveStream: (id) => request(`/api/live/streams/${id}/public`),
  livePlayback: (id) => request(`/api/live/streams/${id}/playback`),

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

  // Diamond Metrics Command (internal analyst platform)
  commandBootstrap: () => request('/api/command/bootstrap'),
  commandCreateJob: (job) => request('/api/command/jobs', { method: 'POST', body: job }),
  commandJobs: (params = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
    return request(`/api/command/jobs${qs ? `?${qs}` : ''}`);
  },
  commandJob: (id) => request(`/api/command/jobs/${id}`),
  commandSetSynthetic: (id, synthetic) => request(`/api/command/jobs/${id}`, { method: 'PUT', body: { synthetic } }),
  commandUpdateJob: (id, fields) => request(`/api/command/jobs/${id}`, { method: 'PUT', body: fields }),
  commandJobStatus: (id, kind, to, note = '') => request(`/api/command/jobs/${id}/status`, { method: 'POST', body: { kind, to, note } }),
  commandToggleRequirement: (id, enabled) => request(`/api/command/requirements/${id}`, { method: 'PUT', body: { enabled } }),
  commandAttachGameRecordSource: (jobId, source) => request(`/api/command/jobs/${jobId}/game-record-sources`, { method: 'POST', body: source }),
  commandRegisterFeed: (jobId, meta) => request(`/api/command/jobs/${jobId}/feeds`, { method: 'POST', body: meta }),
  commandPresignPart: (feedId, uploadId, partNumber) => request(`/api/command/feeds/${feedId}/parts/presign`, { method: 'POST', body: { uploadId, partNumber } }),
  commandUploadLocalPart: (feedId, partNumber, blob) => postRawPart(`/api/command/feeds/${feedId}/parts/${partNumber}`, blob),
  commandCompleteFeed: (feedId, uploadId, parts) => request(`/api/command/feeds/${feedId}/complete`, { method: 'POST', body: { uploadId, parts } }),
  commandAbortFeed: (feedId, uploadId) => request(`/api/command/feeds/${feedId}/abort`, { method: 'POST', body: { uploadId } }),
  commandFeed: (feedId) => request(`/api/command/feeds/${feedId}`),
  commandJobFeeds: (jobId) => request(`/api/command/jobs/${jobId}/feeds`),
  commandRetryFeed: (feedId) => request(`/api/command/feeds/${feedId}/retry`, { method: 'POST' }),
  commandAddGuest: (jobId, guest) => request(`/api/command/jobs/${jobId}/guests`, { method: 'POST', body: guest }),
  commandReassignAttempt: (attemptId, playerId) => request(`/api/command/attempts/${attemptId}`, { method: 'PUT', body: { player_id: playerId } }),
  commandTournamentFootage: (tournamentId) => request(`/api/command/tournaments/${tournamentId}/footage`),
  commandValidateGameRecordSource: (sourceId, resolutions) => request(`/api/command/game-record-sources/${sourceId}/validate`, { method: 'POST', body: { resolutions } }),
  commandGameRecordPlan: (jobId) => request(`/api/command/jobs/${jobId}/game-record`),
  commandScorebook: (jobId) => request(`/api/command/jobs/${jobId}/scorebook`),
  commandScorebookEvent: (jobId, event) => request(`/api/command/jobs/${jobId}/scorebook/events`, { method: 'POST', body: event }),
  commandScorebookPlateAppearance: (jobId, body) => request(`/api/command/jobs/${jobId}/scorebook/plate-appearance`, { method: 'POST', body }),
  commandScorebookCorrect: (eventId, payload, note) => request(`/api/command/scorebook/events/${eventId}`, { method: 'PUT', body: { payload, note } }),
  commandScorebookVoid: (eventId, note) => request(`/api/command/scorebook/events/${eventId}/void`, { method: 'POST', body: { note } }),
  commandScorebookDispute: (eventId, note) => request(`/api/command/scorebook/events/${eventId}/dispute`, { method: 'POST', body: { note } }),
  commandScorebookResolve: (eventId, note) => request(`/api/command/scorebook/events/${eventId}/resolve`, { method: 'POST', body: { note } }),
  commandScorebookClip: (eventId, body) => request(`/api/command/scorebook/events/${eventId}/clip`, { method: 'PUT', body }),
  commandScorebookStartingPitcher: (jobId, body) => request(`/api/command/jobs/${jobId}/scorebook/starting-pitcher`, { method: 'POST', body }),
  commandEmailTest: (to) => request('/api/command/email/test', { method: 'POST', body: { to } }),
  commandBackupVerify: () => request('/api/command/backups/verify', { method: 'POST' }),
  commandRadarQueue: (jobId) => request(`/api/command/jobs/${jobId}/radar`),
  commandRadarImport: (jobId, filename, content) => request(`/api/command/jobs/${jobId}/radar-imports`, { method: 'POST', body: { filename, content } }),
  commandManualReading: (jobId, reading) => request(`/api/command/jobs/${jobId}/radar-readings`, { method: 'POST', body: reading }),
  commandClassifyReading: (readingId, fields) => request(`/api/command/radar-readings/${readingId}`, { method: 'PUT', body: fields }),
  commandAttempts: (jobId) => request(`/api/command/jobs/${jobId}/attempts`),
  commandCreateAttempt: (jobId, attempt) => request(`/api/command/jobs/${jobId}/attempts`, { method: 'POST', body: attempt }),
  commandMeasureAttempt: (attemptId, marks) => request(`/api/command/attempts/${attemptId}/measure`, { method: 'POST', body: marks }),
  commandAttemptUnavailable: (attemptId, fields) => request(`/api/command/attempts/${attemptId}/unavailable`, { method: 'POST', body: fields }),
  commandReview: (jobId) => request(`/api/command/jobs/${jobId}/review`),
  commandDecideResult: (resultId, decision, note = '') => request(`/api/command/results/${resultId}/decision`, { method: 'POST', body: { decision, note } }),
  commandCaptureOverride: (jobId, metric_code, note) => request(`/api/command/jobs/${jobId}/capture-overrides`, { method: 'POST', body: { metric_code, note } }),
  commandRemoveCaptureOverride: (jobId, code) => request(`/api/command/jobs/${jobId}/capture-overrides/${code}`, { method: 'DELETE' }),
  commandTelemetry: (days = 30) => request(`/api/command/telemetry?days=${days}`),
  commandOps: () => request('/api/command/ops'),
  commandRunBackup: () => request('/api/command/backups/run', { method: 'POST' }),
  commandStorageCheck: () => request('/api/command/storage/check', { method: 'POST' }),
  commandBulkJobs: (body) => request('/api/command/jobs/bulk', { method: 'POST', body }),

  // Customer footage intake (docs/COMMAND_TDR.md §8). One config call says
  // whether intake is switched on and carries the packages, guides and labels.
  intakeConfig: () => request('/api/intake/config', { auth: false }),
  customerSignup: (fields) => request('/api/customer/signup', { method: 'POST', body: fields, auth: false }),
  customerVerify: (token) => request('/api/customer/verify', { method: 'POST', body: { token }, auth: false }),
  customerResendVerification: () => request('/api/customer/resend-verification', { method: 'POST' }),
  customerForgotPassword: (email) => request('/api/customer/forgot-password', { method: 'POST', body: { email }, auth: false }),
  customerResetPassword: (token, password) => request('/api/customer/reset-password', { method: 'POST', body: { token, password }, auth: false }),
  customerMe: () => request('/api/customer/me'),
  customerUpdateMe: (fields) => request('/api/customer/me', { method: 'PUT', body: fields }),
  intakeSubmissions: () => request('/api/intake/submissions'),
  intakeCreateDraft: (params) => request('/api/intake/submissions', { method: 'POST', body: params }),
  intakeSubmission: (pid) => request(`/api/intake/submissions/${pid}`),
  intakeSaveDraft: (pid, step, form) => request(`/api/intake/submissions/${pid}`, { method: 'PUT', body: { step, form } }),
  intakeTerms: (pid) => request(`/api/intake/submissions/${pid}/terms`),
  intakeAcceptRights: (pid, body) => request(`/api/intake/submissions/${pid}/rights`, { method: 'POST', body }),
  intakeRegisterFile: (pid, meta) => request(`/api/intake/submissions/${pid}/files`, { method: 'POST', body: meta }),
  intakePresignPart: (fileId, uploadId, partNumber) => request(`/api/intake/files/${fileId}/parts/presign`, { method: 'POST', body: { uploadId, partNumber } }),
  intakeUploadLocalPart: (fileId, partNumber, blob) => postRawPart(`/api/intake/files/${fileId}/parts/${partNumber}`, blob),
  intakeCompleteFile: (fileId, uploadId, parts) => request(`/api/intake/files/${fileId}/complete`, { method: 'POST', body: { uploadId, parts } }),
  intakePauseFile: (fileId) => request(`/api/intake/files/${fileId}/pause`, { method: 'POST' }),
  intakeRemoveFile: (fileId) => request(`/api/intake/files/${fileId}`, { method: 'DELETE' }),
  intakeSubmit: (pid) => request(`/api/intake/submissions/${pid}/submit`, { method: 'POST' }),
  intakeDiscard: (pid) => request(`/api/intake/submissions/${pid}/discard`, { method: 'POST' }),
  intakeReply: (pid, message) => request(`/api/intake/submissions/${pid}/reply`, { method: 'POST', body: { message } }),
  intakeRequestDeletion: (pid, note) => request(`/api/intake/submissions/${pid}/deletion-request`, { method: 'POST', body: { note } }),
  intakeRequestAccountDeletion: (note) => request('/api/intake/account/deletion-request', { method: 'POST', body: { note } }),

  // Will's intake queue (Command)
  commandIntakeQueue: (params = {}) => request(`/api/command/intake${query(params)}`),
  commandIntakeRecord: (id) => request(`/api/command/intake/${id}`),
  commandIntakeUpdate: (id, fields) => request(`/api/command/intake/${id}`, { method: 'PUT', body: fields }),
  commandIntakeNote: (id, message) => request(`/api/command/intake/${id}/notes`, { method: 'POST', body: { message } }),
  commandIntakeMessage: (id, message, requestAction) => request(`/api/command/intake/${id}/messages`, { method: 'POST', body: { message, request_action: !!requestAction } }),
  commandIntakeEscalate: (id, note) => request(`/api/command/intake/${id}/escalate`, { method: 'POST', body: { note } }),
  commandIntakeResolveAthlete: (id, athleteId, body) => request(`/api/command/intake/${id}/athletes/${athleteId}/resolve`, { method: 'POST', body }),
  commandIntakeCreateJob: (id, body) => request(`/api/command/intake/${id}/create-job`, { method: 'POST', body }),
  commandIntakeLinkJob: (id, jobId) => request(`/api/command/intake/${id}/link-job`, { method: 'POST', body: { job_id: jobId } }),
  commandIntakeAttachFiles: (id) => request(`/api/command/intake/${id}/attach-files`, { method: 'POST' }),
  commandIntakeSendToJob: (id, fileId) => request(`/api/command/intake/${id}/files/${fileId}/send-to-job`, { method: 'POST' }),
  commandIntakeDownload: (id, fileId) => request(`/api/command/intake/${id}/files/${fileId}/download`),
  commandIntakeClose: (id, body) => request(`/api/command/intake/${id}/close`, { method: 'POST', body }),
  commandIntakeReopen: (id, note) => request(`/api/command/intake/${id}/reopen`, { method: 'POST', body: { note } }),
  commandIntakeVerifyEmail: (accountId, note) => request(`/api/command/intake/accounts/${accountId}/verify-email`, { method: 'POST', body: { note } }),
  commandIntakeSetTestAccount: (accountId, isTest) => request(`/api/command/intake/accounts/${accountId}`, { method: 'PUT', body: { is_test: !!isTest } }),
  commandIntakeDeletions: () => request('/api/command/intake-deletions'),
  commandIntakeOpenDeletion: (body) => request('/api/command/intake-deletions', { method: 'POST', body }),
  commandIntakeDeletion: (id) => request(`/api/command/intake-deletions/${id}`),
  commandIntakeExecuteDeletion: (id, actions, note) => request(`/api/command/intake-deletions/${id}/execute`, { method: 'POST', body: { actions, note } }),
  commandIntakeDeclineDeletion: (id, note) => request(`/api/command/intake-deletions/${id}/decline`, { method: 'POST', body: { note } }),
  commandIntakeSettings: () => request('/api/command/intake-settings'),
  commandIntakeUpdateSettings: (fields) => request('/api/command/intake-settings', { method: 'PUT', body: fields }),
  commandTeam: () => request('/api/command/team'),
  commandTeamCreate: (member) => request('/api/command/team', { method: 'POST', body: member }),
  commandTeamUpdate: (id, fields) => request(`/api/command/team/${id}`, { method: 'PUT', body: fields }),

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
