// Paired game jobs: one game, a job per team (Huskers and Vice), sharing one
// set of footage and one scorebook. Each job sees its own team as "us",
// releases only its own players, and gets the timing attempts and radar
// readings of its own players — from one round of setup and processing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { once } from 'node:events';

const TEST_DB = `/tmp/dm-pairing-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_STORAGE = 'local';
process.env.DM_MEDIA_DIR = `/tmp/dm-pairing-${process.pid}-store`;
process.env.DM_LOG_SILENT = '1';

const { db } = await import('./db.js');
const { PACKAGES } = await import('./commandLogic.js');
const { appendEvent, appendPlateAppearance, replayJob, liveRecordReport, setStartingPitcher, linkOpponentPlayers, correctEvent } = await import('./scorebook.js');
const { pairJobs, unpairJobs, pairingOf, pairingCandidates, footageJobIds } = await import('./gamePairing.js');
const { createAttempt } = await import('./measurementLogic.js');
const { mountCommandRadarRoutes } = await import('./commandRadarRoutes.js');
const { mountGamePairingRoutes } = await import('./gamePairingRoutes.js');

let admin, baseball, huskers, vice, server, base;
const H = {}, V = {};
const DATE = '2026-10-10';

function team(name) {
  const org = db.prepare('INSERT INTO organizations (name) VALUES (?)').run(name).lastInsertRowid;
  return db.prepare('INSERT INTO teams (organization_id, name, slug) VALUES (?, ?, ?)').run(org, name, name.toLowerCase()).lastInsertRowid;
}
function player(teamId, first, last, jersey) {
  const id = db.prepare('INSERT INTO players (first_name, last_name, slug) VALUES (?, ?, ?)').run(first, last, `${first}-${last}-${teamId}`.toLowerCase()).lastInsertRowid;
  db.prepare("INSERT INTO roster_memberships (team_id, player_id, jersey, start_date, end_date) VALUES (?, ?, ?, '2026-01-01', '2026-12-31')").run(teamId, id, jersey);
  return id;
}
function job(teamId, opponent) {
  const order = db.prepare("INSERT INTO cmd_orders (package_key, label) VALUES ('rookie', 'Rookie')").run().lastInsertRowid;
  for (const code of PACKAGES.rookie.metric_codes) db.prepare("INSERT INTO cmd_metric_requirements (order_id, metric_code, priority, capture_requirement, enabled) VALUES (?, ?, 10, '', 1)").run(order, code);
  const id = db.prepare('INSERT INTO cmd_jobs (sport_id, team_id, game_date, order_id, opponent_label) VALUES (?, ?, ?, ?, ?)').run(baseball, teamId, DATE, order, opponent).lastInsertRowid;
  db.prepare("INSERT INTO cmd_consent (job_id, media_consent, sharing_scope, recorded_by) VALUES (?, 1, 'customer', ?)").run(id, admin);
  return id;
}
const feed = (jobId, label) => db.prepare(
  "INSERT INTO cmd_video_feeds (job_id, label, storage_key, original_name, status, width, height, effective_fps, nominal_fps, duration_s) VALUES (?, ?, ?, 'game.mp4', 'ready', 1920, 1080, 60, 60, 3600)"
).run(jobId, label, `originals/${jobId}/${label}.mp4`).lastInsertRowid;
const lineup = (jobId, side, ids, extra = {}) => appendEvent(db, jobId, { event_type: 'lineup', payload: {
  side, ...extra, slots: ids.map(([id, pos], i) => ({ slot: i + 1, player_id: id, label: '', position: pos })),
} }, admin);
const stat = (rp, playerId, k) => rp.tallies.find(t => t.player_id === playerId)?.stats[k];
const reportIds = jobId => liveRecordReport(db, jobId).report.rows.map(r => r.player_id);

before(async () => {
  baseball = db.prepare("SELECT id FROM sports WHERE key='baseball'").get().id;
  admin = db.prepare('SELECT id FROM admins ORDER BY id LIMIT 1').get().id;
  huskers = team('Huskers');
  vice = team('Vice');
  Object.assign(H, { bess: player(huskers, 'Reagan', 'Bess', '11'), clark: player(huskers, 'Sam', 'Clark', '22'), lead: player(huskers, 'Lee', 'Lead', '1'), two: player(huskers, 'Tom', 'Two', '2') });
  Object.assign(V, { west: player(vice, 'Jo', 'West', '12'), halford: player(vice, 'Al', 'Halford', '30'), carter: player(vice, 'Cy', 'Carter', '7'), top: player(vice, 'Ty', 'Top', '4') });
  const app = express();
  app.use(express.json());
  const requireInternal = (req, _res, next) => { req.internal = { id: admin, role: 'admin' }; next(); };
  mountCommandRadarRoutes(app, { db, requireInternal });
  mountGamePairingRoutes(app, { db, requireInternal });
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.close();
  db.close();
  fs.rmSync(process.env.DM_MEDIA_DIR, { recursive: true, force: true });
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

test('pairing rules: the other team, same date; the job with the scorebook hosts; both scored is refused', async () => {
  const a = job(huskers, 'Vice');
  const b = job(vice, 'Huskers');
  const sameTeam = job(huskers, 'Vice');
  const otherDay = db.prepare("UPDATE cmd_jobs SET game_date = '2026-10-11' WHERE id = ?").run(job(vice, 'Huskers')) && db.prepare('SELECT MAX(id) id FROM cmd_jobs').get().id;
  assert.throws(() => pairJobs(db, a, sameTeam, admin), /same team/);
  assert.throws(() => pairJobs(db, a, otherDay, admin), /different dates/);
  assert.ok(pairingCandidates(db, db.prepare('SELECT * FROM cmd_jobs WHERE id = ?').get(a)).some(c => c.id === b));

  lineup(a, 'us', [[H.lead, 'SS'], [H.bess, 'P']], { us_is_home: true });
  const r = await call('POST', `/api/command/jobs/${b}/pairing`, { partner_job_id: a });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.host_job_id, r.body.guest_job_id], [a, b], 'the job already scored hosts');
  assert.equal(r.body.role, 'guest');
  assert.equal(pairingOf(db, a).role, 'host');
  assert.throws(() => pairJobs(db, a, job(vice, 'Huskers'), admin), /already paired/);

  const c = job(huskers, 'Vice'); const d = job(vice, 'Huskers');
  lineup(c, 'us', [[H.lead, 'SS']], { us_is_home: true }); lineup(d, 'us', [[V.top, 'SS']], { us_is_home: false });
  assert.throws(() => pairJobs(db, c, d, admin), /Both jobs already have a scorebook/);
  assert.equal((await call('DELETE', `/api/command/jobs/${b}/pairing`)).status, 200);
  assert.equal(pairingOf(db, a).role, null);
});

test('one scorebook, two views: sides swap, home/away inverts, and each job releases only its own players', () => {
  const hj = job(huskers, 'Vice');
  const vj = job(vice, 'Huskers');
  pairJobs(db, vj, hj, admin);   // neither scored yet: the named partner hosts
  assert.equal(pairingOf(db, vj).role, 'guest');

  // Huskers (host) are home; the Vice lineup comes from the Vice job's roster.
  lineup(hj, 'us', [[H.lead, 'SS'], [H.two, '2B'], [H.bess, 'P']], { us_is_home: true });
  lineup(hj, 'them', [[V.top, 'SS'], [V.carter, 'CF'], [V.west, 'P']]);
  // Vice bat first (away). A single by Top, scored from the Vice job's page.
  appendPlateAppearance(db, vj, { pa: { result: 'single' }, pitches: [{ result: 'in_play' }] }, admin);

  const host = replayJob(db, hj);
  const guest = replayJob(db, vj);
  assert.equal(host.state.us_is_home, true);
  assert.equal(guest.state.us_is_home, false, 'the Vice job sees itself as away');
  assert.equal(guest.state.lineups.us.slots[0].current.player_id, V.top, 'Vice is "us" on the Vice job');
  assert.equal(guest.state.lineups.them.slots[0].current.player_id, H.lead);
  assert.equal(stat(host, V.top, 'bs_h'), 1, 'one event, seen by both');
  assert.equal(stat(guest, V.top, 'bs_h'), 1);
  assert.equal(stat(guest, H.bess, 'bs_ha'), 1, 'the Huskers pitcher allowed it');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM cmd_events WHERE job_id = ?').get(vj).c, 0, 'stored once, on the host');

  assert.deepEqual(reportIds(hj).sort(), [H.lead, H.two, H.bess].sort(), 'the Huskers job releases Huskers');
  assert.ok(reportIds(vj).includes(V.top) && !reportIds(vj).includes(H.bess), 'the Vice job releases Vice');

  // The score and the starting pitcher, from the Vice side.
  appendEvent(db, vj, { event_type: 'state_adjustment', payload: { score: { us: 3 }, note: 'run scored off camera' } }, admin);
  assert.equal(replayJob(db, vj).state.score.us, 3);
  assert.equal(replayJob(db, hj).state.score.them, 3);
  const sp = setStartingPitcher(db, vj, { player_id: V.halford }, admin);
  assert.equal(sp.state.pitcher.us.player_id, V.halford);
  assert.equal(replayJob(db, hj).state.pitcher.them.player_id, V.halford);
});

test("the guest can enter its own lineup first; the opponent's players must come from the paired roster", () => {
  const hj = job(huskers, 'Vice');
  const vj = job(vice, 'Huskers');
  assert.throws(() => lineup(hj, 'them', [[V.top, 'SS']]), /only when the other team's job is paired/);
  pairJobs(db, hj, vj, admin);
  assert.throws(() => lineup(hj, 'them', [[H.two, 'SS']]), /not on the other team's job roster/);
  lineup(vj, 'us', [[V.top, 'SS'], [V.west, 'P']], { us_is_home: true });   // Vice home, entered on the Vice job
  const host = replayJob(db, hj);
  assert.equal(host.state.us_is_home, false, 'the host learns home/away from the guest lineup');
  assert.equal(host.state.lineups.them.slots[0].current.player_id, V.top);
  lineup(hj, 'us', [[H.lead, 'SS'], [H.bess, 'P']], { us_is_home: false });
  assert.equal(replayJob(db, vj).state.us_is_home, true);
});

test('typed opponent labels from before pairing are linked to rostered players and credited', () => {
  const hj = job(huskers, 'Vice');
  lineup(hj, 'us', [[H.lead, 'SS'], [H.bess, 'P']], { us_is_home: true });
  appendEvent(db, hj, { event_type: 'lineup', payload: { side: 'them', slots: [{ slot: 1, label: '#4', position: 'SS' }, { slot: 2, label: '#12', position: 'P' }] } }, admin);
  appendPlateAppearance(db, hj, { pa: { result: 'double' }, pitches: [{ result: 'in_play' }] }, admin);
  assert.equal(replayJob(db, hj).tallies.find(t => t.label === '#4')?.stats.bs_2b, 1);

  const vj = job(vice, 'Huskers');
  pairJobs(db, hj, vj, admin);
  const r = linkOpponentPlayers(db, hj, { '#4': V.top, '#12': V.west }, admin);
  assert.equal(r.linked, 1, 'the lineup event carried both labels');
  const guest = replayJob(db, vj);
  assert.equal(stat(guest, V.top, 'bs_2b'), 1, "#4's double is now Top's");
  assert.equal(guest.state.pitcher.us.player_id, V.west);
  assert.ok(reportIds(vj).includes(V.top));
  assert.throws(() => linkOpponentPlayers(db, hj, { '#4': H.two }, admin), /not on the other team's job roster/);
});

test("shared footage: the guest's queue and attempts use the host's processed feeds; a Vice runner's timing lands on the Vice job", () => {
  const hj = job(huskers, 'Vice');
  const vj = job(vice, 'Huskers');
  const f = feed(hj, 'Behind home');
  pairJobs(db, vj, hj, admin);
  assert.deepEqual(footageJobIds(db, vj).sort(), [hj, vj].sort());
  const attempt = createAttempt(db, vj, { attempt_type: 'home_to_first', player_id: V.top, feed_id: f, timecode_s: 12.5 }, admin);
  assert.ok(attempt, 'the guest times on the host feed');

  lineup(hj, 'us', [[H.lead, 'SS'], [H.bess, 'P']], { us_is_home: true });
  lineup(hj, 'them', [[V.top, 'SS'], [V.west, 'P']]);
  appendPlateAppearance(db, hj, { pa: { result: 'single', time_home_to_first: true }, pitches: [{ result: 'in_play' }], selected_feed_id: f, timecode_s: 40 }, admin);
  const queued = db.prepare("SELECT job_id, player_id FROM cmd_events WHERE event_type = 'running_attempt' ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual([queued.job_id, queued.player_id], [vj, V.top], 'scored on the Huskers job, timed on the Vice job');
});

test('positions by stint, a position change without a substitute, and no false "already left the game"', () => {
  const j = job(huskers, 'Vice');
  lineup(j, 'us', [[H.lead, 'SS'], [H.two, '2B'], [H.bess, 'P']], { us_is_home: false });
  appendEvent(db, j, { event_type: 'lineup', payload: { side: 'them', slots: [1, 2, 3].map(n => ({ slot: n, label: `#${n}`, position: n === 1 ? 'P' : '' })) } }, admin);
  const out = () => appendPlateAppearance(db, j, { pa: { result: 'groundout' }, pitches: [{ result: 'in_play' }] }, admin);
  for (let i = 0; i < 6; i++) out();   // top 1 (us), bottom 1 (them)
  appendEvent(db, j, { event_type: 'substitution', payload: { kind: 'defensive', side: 'us', slot: 3, player_in_id: H.clark, position: 'P' } }, admin);
  appendEvent(db, j, { event_type: 'substitution', payload: { kind: 'position_change', side: 'us', slot: 1, position: '2B' } }, admin);
  appendEvent(db, j, { event_type: 'substitution', payload: { kind: 'position_change', side: 'us', slot: 2, position: 'SS' } }, admin);
  appendEvent(db, j, { event_type: 'substitution', payload: { kind: 'defensive', side: 'us', slot: 3, player_in_id: H.clark, position: 'P' } }, admin);
  const rp = replayJob(db, j);
  assert.ok(!rp.issues.some(i => i.code === 'player_reused'), 'a player staying in his own slot is not re-used');
  const lead = rp.state.positions.us.find(r => r.player_id === H.lead);
  assert.deepEqual(lead.stints.map(s => [s.position, s.innings, s.to ? 'closed' : 'current']), [['SS', [1], 'closed'], ['2B', [], 'current']],
    'shortstop for the 1st; moved to second before any play of the 2nd');
  const bess = rp.state.positions.us.find(r => r.player_id === H.bess);
  assert.deepEqual(bess.stints.map(s => [s.position, s.innings]), [['P', [1]]], 'Bess pitched the 1st; Clark took over');
  assert.deepEqual(rp.state.positions.us.find(r => r.player_id === H.clark).stints.map(s => s.position), ['P']);
  assert.equal(rp.state.lineups.us.slots[1].position, 'SS');
});

test('radar: bulk assignment by pitcher; the other team’s pitcher takes the readings to their job', async () => {
  const hj = job(huskers, 'Vice');
  const vj = job(vice, 'Huskers');
  pairJobs(db, vj, hj, admin);
  const imp = db.prepare("INSERT INTO cmd_radar_imports (job_id, filename, file_hash, row_count, raw_content, created_by) VALUES (?, 'gun.csv', ?, 6, '', ?)").run(hj, `h${Date.now()}`, admin).lastInsertRowid;
  const ids = [61, 62, 63, 58, 57, 59].map((v, i) => db.prepare(
    "INSERT INTO cmd_radar_readings (job_id, source, import_id, row_index, velocity, source_timestamp, created_by) VALUES (?, 'csv_import', ?, ?, ?, ?, ?)"
  ).run(hj, imp, i, v, `2026-10-10T15:0${i}:00Z`, admin).lastInsertRowid);

  const bess = await call('POST', `/api/command/jobs/${hj}/radar-readings/assign`, { reading_ids: ids.slice(0, 3), player_id: H.bess });
  assert.equal(bess.status, 200, JSON.stringify(bess.body));
  assert.deepEqual([bess.body.assigned, bess.body.moved, bess.body.job_id], [3, 0, hj]);
  const west = await call('POST', `/api/command/jobs/${hj}/radar-readings/assign`, { reading_ids: ids.slice(3), player_id: V.west, pitch_type: 'fastball' });
  assert.deepEqual([west.body.assigned, west.body.moved, west.body.job_id], [3, 3, vj]);
  const onVice = db.prepare('SELECT COUNT(*) c FROM cmd_radar_readings WHERE job_id = ? AND player_id = ? AND status = ?').get(vj, V.west, 'matched').c;
  assert.equal(onVice, 3);
  const results = db.prepare("SELECT job_id, COUNT(*) c FROM cmd_metric_results WHERE metric_code = 'pitch_velocity_radar' AND evidence_id IN (" + ids.join(',') + ') GROUP BY job_id').all();
  assert.deepEqual(Object.fromEntries(results.map(r => [r.job_id, r.c])), { [hj]: 3, [vj]: 3 }, 'each job reviews its own pitchers');

  const radar = await call('GET', `/api/command/jobs/${hj}/radar`);
  assert.ok(radar.body.partner_roster.some(p => p.id === V.west), 'the Huskers queue offers the Vice pitchers');
  assert.equal((await call('POST', `/api/command/jobs/${hj}/radar-readings/assign`, { reading_ids: [ids[0]], player_id: 999999 })).status, 400);
  const back = await call('POST', `/api/command/jobs/${hj}/radar-readings/assign`, { reading_ids: [ids[0]], status: 'unmatched' });
  assert.equal(back.status, 200);
  assert.equal(db.prepare('SELECT status FROM cmd_radar_readings WHERE id = ?').get(ids[0]).status, 'unmatched');
});

test('unpairing is refused once the guest released from the shared scorebook', () => {
  const hj = job(huskers, 'Vice');
  const vj = job(vice, 'Huskers');
  pairJobs(db, vj, hj, admin);
  db.prepare("UPDATE cmd_jobs SET game_record_status = 'released' WHERE id = ?").run(vj);
  assert.throws(() => unpairJobs(db, hj, admin), /released from the shared scorebook/);
  db.prepare("UPDATE cmd_jobs SET game_record_status = 'pending' WHERE id = ?").run(vj);
  assert.equal(unpairJobs(db, hj, admin).guest_job_id, vj);
  // Corrections from the guest are refused for events of another log.
  const other = job(huskers, 'Someone');
  const ev = lineup(other, 'us', [[H.lead, 'SS']], { us_is_home: true }).event;
  assert.throws(() => correctEvent(db, ev.id, { payload: ev.payload }, admin, 'x', { viewJobId: vj }), /not in this job's scorebook/);
});
