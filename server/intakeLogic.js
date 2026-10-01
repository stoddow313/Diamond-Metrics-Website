// Customer footage intake — pure domain logic (no DB access here).
// Requirements: "Customer Footage Submission Developer Requirements" (doc
// sections cited as §n). Decision record: docs/COMMAND_TDR.md §8.
import { createHash, randomInt } from 'node:crypto';

// ── Who is submitting (§2) ───────────────────────────────────────────────
export const ROLES = {
  parent:   { label: 'Parent', group: 'family' },
  guardian: { label: 'Legal guardian', group: 'family' },
  athlete:  { label: 'Athlete (18 or older)', group: 'family' },
  coach:    { label: 'Coach', group: 'team' },
  team_rep: { label: 'Team representative', group: 'team' },
  director: { label: 'Director or organizer', group: 'event' },
};
export const ROLE_KEYS = Object.keys(ROLES);

// The submitter's relationship to one athlete. Only parent, guardian and self
// can ever become account ownership of an athlete (§2: a coach cannot claim an
// athlete without guardian verification).
export const RELATIONSHIPS = {
  parent: 'Parent', guardian: 'Legal guardian', self: 'This is me (18+)',
  coach: 'Coach', team_rep: 'Team representative', director: 'Event organizer', other: 'Other',
};
// invite_claim: the athlete's own portal login (an admin issued that invite for
// that player), linked when its holder submits footage.
export const OWNERSHIP_RELATIONSHIPS = ['parent', 'guardian', 'self', 'invite_claim'];

export const CAMERA_VIEWS = {
  behind_home: 'Behind home plate',
  center_field: 'Center field',
  side_first_base: 'Side — first-base line',
  side_third_base: 'Side — third-base line',
  other: 'Other angle',
};
export const SIDE_VIEWS = ['side_first_base', 'side_third_base'];

export const FILE_KINDS = {
  video: { label: 'Game video', extensions: ['.mp4', '.mov', '.m4v', '.mts', '.m2ts'], maxBytes: 128 * 1024 ** 3 },
  radar_csv: { label: 'Pocket Radar export', extensions: ['.csv'], maxBytes: 10 * 1024 ** 2 },
  scorecard: { label: 'Scorecard / GameChanger export', extensions: ['.csv', '.pdf', '.xlsx', '.xls'], maxBytes: 25 * 1024 ** 2 },
  roster: { label: 'Roster', extensions: ['.csv', '.pdf', '.xlsx', '.xls'], maxBytes: 25 * 1024 ** 2 },
};

// ── Service options (§5, §7, §13) ────────────────────────────────────────
// command_package is what a job is created with. Pro is accepted but
// fulfilled as Rookie until its modules ship (owner decision 2026-10-01);
// Hall of Fame is a consultation, never a self-serve upload.
export const INTAKE_PACKAGES = {
  rookie: {
    label: 'Rookie',
    best_for: 'A simple game submission',
    upload: 'One stable behind-home game feed',
    delivers: 'Basic box score plus selected timing and counting metrics, with radar readings when you provide them',
    expectation: '1080p at 30 FPS minimum; 60 FPS preferred',
    self_serve: true,
    command_package: 'rookie',
  },
  pro: {
    label: 'Pro',
    best_for: 'Deeper video analysis',
    upload: 'A Rookie-quality primary feed plus a recommended side or high-quality angle',
    delivers: 'The Rookie foundation plus eligible advanced video-estimated metrics such as exit velocity, launch angle, or hit direction',
    expectation: '4K at 120 FPS preferred for advanced estimates',
    self_serve: true,
    command_package: 'rookie',
    customer_note: 'Advanced video metrics are still rolling out. Until they are available for your footage, Pro submissions are analyzed with the Rookie foundation, and we confirm what is included before analysis starts.',
    fulfillment_note: 'Customer requested Pro. Advanced modules are not orderable yet — fulfilled as Rookie; advanced metrics release only when their modules ship and the capture qualifies.',
  },
  hall_of_fame: {
    label: 'Hall of Fame',
    best_for: 'The fullest hardware-informed view',
    upload: 'A consultation and an approved hardware or data-capture setup',
    delivers: 'Advanced hardware-derived metrics such as spin, movement, and biometrics where supported',
    expectation: 'Not a standard self-serve upload — our team plans it with you',
    self_serve: false,
    command_package: null,
  },
  custom: {
    label: 'Custom request',
    best_for: 'Something specific we should scope with you',
    upload: 'Usually one stable behind-home game feed — we confirm with you',
    delivers: 'Scoped by our team before any analysis starts',
    expectation: 'Follow the Rookie filming guide unless we agree otherwise',
    self_serve: true,
    command_package: null,
  },
};
export const PACKAGE_KEYS = Object.keys(INTAKE_PACKAGES);

// ── Filming guide (§7) ───────────────────────────────────────────────────
// Plain language for customers; Command keeps the detailed QA decision.
export const GUIDE_VERSION = '2026-10-v1';
export const FILMING_GUIDES = {
  rookie: {
    title: 'Rookie filming guide',
    summary: 'One stable, continuous behind-home view — like a GameChanger stream.',
    points: [
      'Set the camera on a tripod behind home plate. Raised and a little off-center is best, so the umpire does not hide the catcher’s glove.',
      'Keep the pitcher, home plate, the batter and the base path to first base in frame for the whole game.',
      'Record horizontally (landscape) and do not zoom, pan or stop between innings if you can avoid it.',
      'Use at least 1080p at 30 frames per second. 60 frames per second is better for timing.',
      'Upload the original file from the camera or phone — not a trimmed, edited or screen-recorded copy.',
    ],
    insufficient: 'We can still review footage that misses these. Any metric the footage cannot support is marked unavailable with the reason — never shown as zero.',
    images: ['primary-behind-home-plate-setup.svg', 'filming-behind-home-plate.png'],
  },
  pro: {
    title: 'Pro filming guide',
    summary: 'A Rookie-quality behind-home feed, plus a fixed side angle for advanced metrics.',
    points: [
      'Film the primary behind-home view exactly as the Rookie guide describes.',
      'Add a second camera fixed on the first- or third-base line, level with the plate, covering the batter and the first few feet of a batted ball.',
      'Record the side camera at the highest frame rate it offers — 4K at 120 frames per second is preferred.',
      'Keep both cameras still and running for the whole game; upload each file separately and label which angle it is.',
    ],
    insufficient: 'If an angle or its quality cannot support an advanced metric, that metric is marked unavailable with the reason. We do not estimate advanced results from footage that does not qualify.',
    images: ['primary-behind-home-plate-setup.svg', 'optional-second-camera-setup.svg'],
  },
  hall_of_fame: {
    title: 'Hall of Fame',
    summary: 'Hall of Fame uses an approved hardware and data-capture setup that our team plans with you.',
    points: [
      'There is nothing to film yet — tell us about the athlete and the event and we will contact you to plan the capture.',
      'Uploading ordinary footage alone does not produce hardware-grade metrics.',
    ],
    insufficient: '',
    images: [],
  },
  custom: {
    title: 'Filming guide',
    summary: 'Unless we agree something different with you, film the way the Rookie guide describes.',
    points: [],
    insufficient: '',
    images: ['primary-behind-home-plate-setup.svg'],
  },
};
FILMING_GUIDES.custom.points = FILMING_GUIDES.rookie.points;

// ── Rights and consent (§4 step 4, §5, §10) ──────────────────────────────
// Placeholder wording until legal approves it (doc §14). Every acceptance
// stores the version, a hash of the exact text shown, and pending_legal, so
// records made under the draft are identifiable after the final text ships.
export const RIGHTS_POLICY = { key: 'footage_rights', version: '2026-10-draft-1', pending_legal: true };

export const DEFAULT_RETENTION_DAYS = 180;
export function retentionDays(env = process.env) {
  const n = Number(env.DM_INTAKE_RETENTION_DAYS);
  return Number.isInteger(n) && n >= 30 && n <= 3650 ? n : DEFAULT_RETENTION_DAYS;
}

const AUTHORITY = {
  parent: 'I am the parent of each minor athlete I identified in this submission.',
  guardian: 'I am the legal guardian of each minor athlete I identified in this submission.',
  athlete: 'I am 18 or older and I am the athlete identified in this submission.',
  coach: 'I am a coach for the team in this footage and I am authorized by the team or organization to submit it. Submitting does not give me ownership of any athlete’s account.',
  team_rep: 'I am authorized by the team or organization in this footage to submit it. Submitting does not give me ownership of any athlete’s account.',
  director: 'I represent the event or organization in this footage and I am authorized to submit it. Submitting does not give me ownership of any athlete’s account.',
};

export function rightsTerms({ role, retention = DEFAULT_RETENTION_DAYS }) {
  if (!AUTHORITY[role]) throw Object.assign(new Error('Choose your role before accepting the terms'), { status: 400 });
  return {
    key: RIGHTS_POLICY.key,
    version: RIGHTS_POLICY.version,
    pending_legal: RIGHTS_POLICY.pending_legal,
    attestation: `${AUTHORITY[role]} I recorded this footage or I have the right to share it with Diamond Metrics.`,
    uses: [
      { key: 'analysis', required: true, text: 'Diamond Metrics may review and analyze this footage to produce the metrics and game record I requested.' },
      { key: 'results', required: true, text: 'Approved results may be shared with me and with verified account holders for the athletes involved, and may appear on each athlete’s Diamond Metrics profile, which stays private unless its account holder makes it public.' },
      { key: 'improvement', required: false, text: 'Diamond Metrics may also use this footage to test and improve its measurement tools.' },
    ],
    contact: 'Diamond Metrics may email or text me about this submission.',
    retention: `Diamond Metrics keeps uploaded footage for ${retention} days after upload, and I can ask for it to be deleted sooner at any time.`,
    guide: `I have read the filming guide (version ${GUIDE_VERSION}).`,
  };
}

export function policyHash(terms) {
  return createHash('sha256').update(JSON.stringify(terms)).digest('hex');
}

// ── Normalization (§8 duplicate prevention) ──────────────────────────────
export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || ''));
}

// Digits only, with a country code; 10-digit numbers are taken as North
// American. Used to detect duplicates, never to dial.
export function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return digits;
  return digits.length >= 8 ? digits : '';
}

// Phones type curly apostrophes (O’Neil); they must match the straight kind.
export function normalizeName(value) {
  return String(value || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’ʼ`]/g, "'")
    .toLowerCase().replace(/[^a-z0-9' -]/g, ' ').replace(/['-]/g, '')
    .replace(/\s+/g, ' ').trim();
}

// DM-XXXX-XXXX from an alphabet without 0/O/1/I/L/U so it can be read aloud.
const ID_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newPublicId(rand = randomInt) {
  const pick = () => ID_ALPHABET[rand(ID_ALPHABET.length)];
  const block = () => Array.from({ length: 4 }, pick).join('');
  return `DM-${block()}-${block()}`;
}

export const addDays = (iso, days) => {
  const d = new Date(`${String(iso).replace(' ', 'T')}${/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? '' : 'Z'}`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};

export const isoDate = value => {
  const s = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
};

// ── Status model (§3 step 7, §8 Will's queue) ────────────────────────────
// status is the intake stage. Once a job is linked, the fulfillment stage is
// derived from the job's two release tracks, so the queue can never disagree
// with Command.
export const SUBMISSION_STATUSES = ['draft', 'new', 'needs_identity_review', 'needs_customer_action', 'ready_for_job', 'linked', 'closed', 'declined'];
export const STAFF_SETTABLE_STATUSES = ['new', 'needs_identity_review', 'needs_customer_action', 'ready_for_job'];

export const QUEUE_STAGES = [
  { key: 'new', label: 'New' },
  { key: 'needs_identity_review', label: 'Needs identity review' },
  { key: 'needs_customer_action', label: 'Needs customer action' },
  { key: 'ready_for_job', label: 'Ready to create Command job' },
  { key: 'in_analysis', label: 'In analysis' },
  { key: 'metrics_released', label: 'Metrics released', hint: 'Metrics are out; the box score has not been started.' },
  { key: 'game_record_pending', label: 'Game record pending', hint: 'Metrics are out; the box score is in progress.' },
  { key: 'complete', label: 'Complete' },
  { key: 'closed', label: 'Closed or declined' },
];

const recordDone = job => ['released', 'not_ordered'].includes(job.game_record_status);

export function queueStage(sub, job = null) {
  if (sub.status === 'draft') return 'draft';
  if (sub.status === 'closed' || sub.status === 'declined') return 'closed';
  if (sub.status === 'needs_customer_action') return 'needs_customer_action';
  if (sub.job_id && job) {
    const metrics = job.metric_release_status === 'released';
    if (metrics && recordDone(job)) return 'complete';
    if (metrics) return job.game_record_status === 'pending' ? 'metrics_released' : 'game_record_pending';
    return 'in_analysis';
  }
  return sub.status === 'linked' ? 'ready_for_job' : sub.status;
}

const VIDEO_IN_FLIGHT = ['uploading', 'paused', 'uploaded', 'processing'];

// What the customer sees (§3 step 7): received, processing, action required,
// analysis, metrics ready, and the game-record state — never identity review,
// match confidence or internal notes.
export function customerStatus({ sub, job = null, files = [] }) {
  const gameRecord = !job ? null
    : job.game_record_status === 'released' ? 'complete'
      : job.game_record_status === 'not_ordered' ? 'not_ordered'
        : job.game_record_status === 'pending' ? 'not_started' : 'in_progress';
  const out = (key, label, detail) => ({ key, label, detail, game_record: gameRecord });
  if (sub.status === 'draft') return out('draft', 'Draft', 'Finish and submit when you’re ready.');
  if (sub.status === 'declined') return out('declined', 'Declined', sub.customer_message || 'We are not able to take on this submission.');
  if (sub.status === 'closed') return out('closed', 'Closed', sub.customer_message || 'This submission is closed.');
  const live = files.filter(f => f.status !== 'deleted' && f.status !== 'archived');
  if (sub.status === 'needs_customer_action' || live.some(f => f.status === 'needs_customer_action')) {
    return out('action_required', 'Action required', sub.customer_message || 'We need something from you — see the details below.');
  }
  if (job) {
    const metrics = job.metric_release_status === 'released';
    if (metrics && recordDone(job)) return out('complete', 'Complete', 'Your verified metrics and full game record are ready.');
    if (metrics) return out('metrics_ready', 'Metrics ready', 'Your verified metrics are ready. The full game record is still in progress.');
    return out('analysis', 'In analysis', 'Our analysts are working on your game.');
  }
  if (live.some(f => f.kind === 'video' && VIDEO_IN_FLIGHT.includes(f.status))) {
    return out('processing', 'Processing', 'We are checking your footage.');
  }
  if (sub.kind === 'inquiry') return out('received', 'Received', 'Our team will contact you to plan your capture.');
  return out('received', 'Received', 'We have your submission and will contact you with next steps.');
}

export const CUSTOMER_FILE_STATUS = {
  uploading: 'Uploading',
  paused: 'Paused — choose the same file again to resume',
  uploaded: 'Checking the file',
  processing: 'Checking the file',
  ready: 'Received',
  needs_customer_action: 'Action needed',
  rejected: 'Not accepted',
  archived: 'Archived',
  deleted: 'Deleted',
};

// ── Capture findings (§6 technical validation, §7 capture QA) ───────────
// Only what a customer can act on. VFR, codec detail and probe errors stay in
// internal diagnostics; Command makes the per-metric QA decision later.
const NTSC = 0.15;

export function captureIssues(file, { packageKey = 'rookie', fullGame = null } = {}) {
  const issues = [];
  const add = (code, severity, text) => issues.push({ code, severity, text });
  if (!file.width || !file.height || !(file.duration_s > 0)) {
    add('unreadable', 'action', 'We could not read this video. Please export the original file from the camera or phone and upload it again.');
    return issues;
  }
  const quarter = Math.abs(Number(file.rotation) || 0) % 180 === 90;
  const w = quarter ? file.height : file.width;
  const h = quarter ? file.width : file.height;
  const shortSide = Math.min(w, h);
  const fps = Number(file.effective_fps || file.nominal_fps || 0);
  const side = SIDE_VIEWS.includes(file.camera_view);

  if (h > w) add('portrait', 'warning', 'This video was recorded vertically. A horizontal (landscape) view keeps the whole field in frame.');
  if (shortSide < 1080) add('resolution_below_minimum', 'warning', `This video is ${shortSide}p. Timing metrics need 1080p or higher, so some may be unavailable.`);
  if (fps && fps < 30 - NTSC) add('frame_rate_below_minimum', 'warning', `This video is ${fps.toFixed(fps % 1 ? 2 : 0)} frames per second. Timing metrics need at least 30, so some may be unavailable.`);
  else if (fps && fps < 60 - NTSC && !side) add('frame_rate_below_preferred', 'tip', '60 frames per second gives more precise timing; 30 works.');
  if (packageKey === 'pro' && side && fps && fps < 120 - NTSC) {
    add('side_frame_rate_below_preferred', 'warning', `Advanced video estimates need about 120 frames per second; this side-angle video is ${fps.toFixed(0)}, so those metrics may be unavailable.`);
  }
  if (fullGame === true && file.duration_s < 20 * 60) {
    add('short_for_full_game', 'tip', 'This looks like a short clip. If you meant to send the full game, add the rest of the recording.');
  }
  return issues;
}

// Submission-level notes that depend on the set of files, not one file.
export function submissionCaptureNotes({ packageKey, files }) {
  const videos = files.filter(f => f.kind === 'video' && !['deleted', 'archived', 'rejected'].includes(f.status));
  const notes = [];
  if (packageKey === 'pro' && !videos.some(f => SIDE_VIEWS.includes(f.camera_view))) {
    notes.push({ code: 'pro_without_side_angle', severity: 'warning', text: 'Advanced metrics need a side-angle video. Without one, they will be marked unavailable.' });
  }
  if (videos.length && !videos.some(f => ['behind_home', 'center_field'].includes(f.camera_view))) {
    notes.push({ code: 'no_primary_view', severity: 'warning', text: 'We need a behind-home (or center-field) view for timing and the game record.' });
  }
  return notes;
}

// ── Results language (§7 capture QA rule, §9 unavailable results) ───────
export const TRUST_LABELS = {
  radar_verified: 'Radar verified',
  frame_timed: 'Video measured',
  video_estimated: 'Video estimated',
  video_classified: 'Video classified',
  scorebook_derived: 'Scorebook',
  manual: 'Manual entry',
};

const PLAIN_REASONS = {
  base_not_visible: 'The part of the field this measurement needs was not visible on camera.',
  runner_or_ball_obscured: 'The play was blocked from the camera’s view.',
  camera_stopped: 'The recording did not cover this play.',
  insufficient_frame_rate: 'The video’s frame rate was too low for this measurement.',
  insufficient_capture_quality: 'The video quality was not sufficient for this measurement.',
  no_valid_attempt: 'No qualifying play for this measurement happened in this game.',
  plate_not_visible: 'Home plate was not visible on camera.',
  ball_not_visible: 'The ball was not visible on camera.',
  catch_or_contact_obscured: 'The catch or contact was blocked from the camera’s view.',
  camera_moved: 'The camera moved during the game.',
  no_qualified_capture: 'The required camera view was not available.',
  missing_radar: 'No radar readings were provided for this game.',
  athlete_not_identifiable: 'We could not identify the athlete in the footage.',
};
export function plainReason(code) {
  return PLAIN_REASONS[code] || 'We could not verify this measurement from the footage.';
}

// ── Submit readiness (§5: required fields identified before upload/submit) ─
export function submitReadiness({ sub, account, athletes = [], files = [], rights = null }) {
  const missing = [];
  const need = (code, text) => missing.push({ code, text });
  if (!account?.email_verified_at) need('email_unverified', 'Verify your email address.');
  if (!ROLES[sub.submitter_role]) need('role', 'Tell us your role.');
  const pkg = INTAKE_PACKAGES[sub.package_key];
  if (!pkg) need('package', 'Choose a service option.');
  if (sub.kind === 'inquiry') return missing;

  if (!isoDate(sub.game_date)) need('game_date', 'Add the game date.');
  if (!String(sub.team_label || '').trim() && !sub.team_id) need('team', 'Add the team.');
  const ctx = safeJson(sub.footage_context);
  if (!String(sub.event_label || '').trim() && !ctx.no_event) need('event', 'Add the event or tournament, or mark it as a regular-season game.');
  if (!String(sub.level || '').trim()) need('level', 'Add the age group or level.');

  const family = ROLES[sub.submitter_role]?.group === 'family';
  if (family && athletes.length === 0) need('athlete', 'Add the athlete this footage is for.');
  if (!family && athletes.length === 0 && !files.some(f => f.kind === 'roster' && f.status !== 'deleted')) {
    need('athlete', 'Add the participating athletes, or attach a roster file.');
  }
  athletes.forEach((a, i) => {
    if (a.player_id) return;   // a staff-verified link already identifies the athlete
    if (!String(a.first_name || '').trim() || !String(a.last_name || '').trim()) need(`athlete_${i}_name`, `Athlete ${i + 1}: add a first and last name.`);
    if (!a.birth_year && !String(a.age_band || '').trim()) need(`athlete_${i}_age`, `Athlete ${i + 1}: add a birth year or age group.`);
    if (!a.relationship) need(`athlete_${i}_relationship`, `Athlete ${i + 1}: add your relationship to the athlete.`);
  });

  if (!rights || rights.action !== 'grant') need('rights', 'Read the filming guide and accept the footage terms.');

  const live = files.filter(f => !['deleted', 'archived'].includes(f.status));
  const videos = live.filter(f => f.kind === 'video');
  if (videos.length === 0) need('video', 'Upload at least one game video.');
  if (live.some(f => ['uploading', 'paused'].includes(f.status))) need('uploads', 'Wait for every upload to finish (or remove the unfinished one).');
  if (videos.some(f => !CAMERA_VIEWS[f.camera_view])) need('camera_view', 'Tell us which angle each video was filmed from.');
  if (!['full', 'clips'].includes(ctx.coverage)) need('coverage', 'Tell us whether this is the full game or clips.');
  return missing;
}

export function safeJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || ''); } catch { return fallback; }
}
