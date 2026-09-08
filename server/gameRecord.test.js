// Game-record track (roadmap §6, §7.9 second half): a GameChanger export is
// parsed tolerantly, rows resolve to roster players by jersey then name, the
// analyst resolves the rest, and a validated record releases box-score
// statistics into the profile independently of the metric release.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-gamerecord-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_STORAGE = 'local';
process.env.DM_MEDIA_DIR = `/tmp/dm-gamerecord-${process.pid}-store`;
process.env.DM_LOG_SILENT = '1';

const { db } = await import('./db.js');
const { PACKAGES } = await import('./commandLogic.js');
const { parseBoxScoreCsv, resolveBoxScoreRows, validateGameRecordSource, releaseGameRecord, gameRecordPlan } = await import('./gameRecord.js');
const { classifyReading } = await import('./radarImport.js');
const { decideResult, releaseMetrics } = await import('./releaseLogic.js');

let admin, team, baseball, jobId, ace, slugger, glove;

// A GameChanger-shaped export: batting and pitching tables in one file,
// derived columns we ignore, a Totals row, and a name the roster spells differently.
const GC_CSV = `Number,Last,First,GP,PA,AB,AVG,OBP,OPS,SLG,H,1B,2B,3B,HR,RBI,R,BB,SO,K-L,HBP,SAC,SF,ROE,FC,SB,SB%,CS,PIK,QAB
7,Arm,Ace,1,4,3,.333,.500,1.167,.667,1,0,1,0,0,2,1,1,1,0,0,0,0,0,0,1,100%,0,0,3
21,Bat,Sammy,1,3,3,.667,.667,1.667,1.000,2,1,0,1,0,0,2,0,0,0,0,0,0,0,0,0,-,0,0,2
3,Glove,Gil,1,3,2,.000,.333,.333,.000,0,0,0,0,0,0,0,1,2,1,0,0,0,0,0,0,-,0,0,0
,Totals,,,10,8,.375,.500,1.125,.625,3,1,1,1,0,2,3,2,3,1,0,0,0,0,0,1,100%,0,0,5

Number,Last,First,IP,GP,GS,W,L,SV,ERA,WHIP,BF,#P,TS,TB,H,R,ER,BB,SO,HBP,HR
7,Arm,Ace,4.2,1,1,1,0,0,1.93,1.29,20,72,45,27,5,2,1,1,6,0,0

Number,Last,First,TC,A,PO,FPCT,E,DP
3,Glove,Gil,5,3,1,.800,1,0
`;

before(() => {
  const org = db.prepare("INSERT INTO organizations (name) VALUES ('Org')").run().lastInsertRowid;
  team = db.prepare("INSERT INTO teams (organization_id, name, slug) VALUES (?, 'Canyon', 'canyon')").run(org).lastInsertRowid;
  baseball = db.prepare("SELECT id FROM sports WHERE key='baseball'").get().id;
  admin = db.prepare('SELECT id FROM admins ORDER BY id LIMIT 1').get().id;
  ace = db.prepare("INSERT INTO players (first_name, last_name, slug) VALUES ('Ace', 'Arm', 'ace-arm')").run().lastInsertRowid;
  slugger = db.prepare("INSERT INTO players (first_name, last_name, slug) VALUES ('Sam', 'Bat', 'sam-bat')").run().lastInsertRowid;   // roster says Sam, GC says Sammy
  glove = db.prepare("INSERT INTO players (first_name, last_name, slug) VALUES ('Gil', 'Glove', 'gil-glove')").run().lastInsertRowid;
  db.prepare("INSERT INTO roster_memberships (team_id, player_id, jersey, start_date, end_date) VALUES (?, ?, '7', '2026-01-01', '2026-12-31')").run(team, ace);
  db.prepare("INSERT INTO roster_memberships (team_id, player_id, jersey, start_date, end_date) VALUES (?, ?, '', '2026-01-01', '2026-12-31')").run(team, slugger);   // no jersey on file
  db.prepare("INSERT INTO roster_memberships (team_id, player_id, jersey, start_date, end_date) VALUES (?, ?, '3', '2026-01-01', '2026-12-31')").run(team, glove);
  const order = db.prepare("INSERT INTO cmd_orders (package_key, label) VALUES ('rookie', 'Rookie')").run().lastInsertRowid;
  for (const code of PACKAGES.rookie.metric_codes) db.prepare("INSERT INTO cmd_metric_requirements (order_id, metric_code, priority, capture_requirement, enabled) VALUES (?, ?, 10, '', 1)").run(order, code);
  jobId = db.prepare("INSERT INTO cmd_jobs (sport_id, team_id, game_date, order_id, opponent_label) VALUES (?, ?, '2026-09-06', ?, 'Rivals')").run(baseball, team, order).lastInsertRowid;
  db.prepare('INSERT INTO cmd_consent (job_id, media_consent, sharing_scope, recorded_by) VALUES (?, 1, ?, ?)').run(jobId, 'customer', admin);
});

after(() => {
  db.close();
  fs.rmSync(process.env.DM_MEDIA_DIR, { recursive: true, force: true });
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

const entry = (playerId, key) => db.prepare(
  'SELECT s.* FROM stat_entries s JOIN games g ON g.id = s.game_id WHERE g.command_job_id = ? AND g.player_id = ? AND s.metric_key = ?'
).get(jobId, playerId, key);

test('parser: batting, pitching and fielding blocks map to box-score keys; derived columns and Totals are ignored; unknown columns are reported', () => {
  const parsed = parseBoxScoreCsv(GC_CSV);
  assert.deepEqual(parsed.blocks.map(b => b.group), ['batting', 'pitching', 'fielding']);
  assert.equal(parsed.row_count, 5, 'three batters, one pitcher, one fielder — no Totals row');
  const aceBat = parsed.blocks[0].rows.find(r => r.jersey === '7');
  assert.deepEqual(aceBat.stats, { bs_pa: 4, bs_ab: 3, bs_h: 1, bs_1b: 0, bs_2b: 1, bs_3b: 0, bs_hr: 0, bs_rbi: 2, bs_r: 1, bs_bb: 1, bs_k: 1, bs_hbp: 0, bs_sh: 0, bs_sf: 0, bs_roe: 0, bs_fc: 0, bs_sb: 1, bs_cs: 0, bs_pk: 0 }, 'every appendix count the export carries is kept');
  const acePitch = parsed.blocks[1].rows[0];
  assert.deepEqual(acePitch.stats, { bs_outs: 14, bs_gs: 1, bs_bf: 20, bs_pitches: 72, bs_ha: 5, bs_ra: 2, bs_er: 1, bs_bba: 1, bs_kp: 6, bs_hbpa: 0, bs_hra: 0 }, '4.2 innings are fourteen outs');
  assert.deepEqual(parsed.blocks[2].rows[0].stats, { bs_a: 3, bs_po: 1, bs_e: 1, bs_dp: 0 });
  assert.ok(parsed.blocks[0].unknown_columns.length === 0, `batting columns all placed or deliberately ignored: ${parsed.blocks[0].unknown_columns}`);
  assert.equal(parsed.blocks[0].rows.find(r => r.jersey === '21').name, 'Sammy Bat');
});

test('resolver: jersey first, then exact name; a nickname with no jersey on file is left for the analyst, never guessed', () => {
  const parsed = parseBoxScoreCsv(GC_CSV);
  const res = resolveBoxScoreRows(db, jobId, parsed);
  const byKey = Object.fromEntries(res.rows.map(r => [r.key, r]));
  assert.equal(byKey['batting:2'].player_id, ace);
  assert.equal(byKey['batting:2'].resolved_by, 'jersey');
  assert.equal(byKey['batting:4'].player_id, glove);
  assert.equal(byKey['pitching:8'].player_id, ace);
  assert.equal(byKey['fielding:11'].player_id, glove);
  // "Sammy Bat" #21: no jersey on the roster and the first name differs — but the last name is unique on the roster.
  assert.equal(byKey['batting:3'].player_id, slugger);
  assert.equal(byKey['batting:3'].resolved_by, 'last_name');
  assert.equal(res.unresolved.length, 0);
});

test('resolver: two players wearing the same number resolve by name agreement, and a jersey that contradicts the name never wins', () => {
  // A second #7 on the roster (an event guest), plus a stale jersey for Glove.
  const twin = db.prepare("INSERT INTO players (first_name, last_name, slug) VALUES ('Tia', 'Twin', 'tia-twin')").run().lastInsertRowid;
  db.prepare("INSERT INTO cmd_job_guests (job_id, player_id, jersey, label) VALUES (?, ?, '7', 'event guest')").run(jobId, twin);
  const parsed = parseBoxScoreCsv('Number,Last,First,PA,AB,H\n7,Arm,Ace,4,4,1\n7,Twin,Tia,2,2,0\n7,Nobody,Ned,1,1,0\n3,Bat,Sammy,3,3,1\n');
  const res = resolveBoxScoreRows(db, jobId, parsed);
  const by = Object.fromEntries(res.rows.map(r => [r.name, r]));
  assert.equal(by['Ace Arm'].player_id, ace);
  assert.equal(by['Ace Arm'].resolved_by, 'jersey+name');
  assert.equal(by['Tia Twin'].player_id, twin);
  assert.equal(by['Ned Nobody'].player_id, null, 'two #7s and neither name matches: left for the analyst');
  // Sammy Bat listed as #3, but #3 on file is Gil Glove: the jersey contradicts the name, so the name decides.
  assert.equal(by['Sammy Bat'].player_id, slugger);
  assert.equal(by['Sammy Bat'].resolved_by, 'last_name');
  db.prepare('DELETE FROM cmd_job_guests WHERE player_id = ?').run(twin);
});

test('validation: an unresolvable row keeps the source in validating until the analyst resolves or skips it; everything is audited', () => {
  const csv = GC_CSV + '\nNumber,Last,First,PA,AB,H,R\n99,Mystery,Max,1,1,0,0\n';
  const sourceId = db.prepare(
    "INSERT INTO cmd_game_record_sources (job_id, source_kind, label, raw_import, created_by) VALUES (?, 'gamechanger_export', 'GC export', ?, ?)"
  ).run(jobId, csv, admin).lastInsertRowid;
  let out = validateGameRecordSource(db, sourceId, {}, admin);
  assert.equal(out.status, 'validating');
  assert.equal(out.report.unresolved.length, 1);
  assert.equal(out.report.unresolved[0].name, 'Max Mystery');
  const rowKey = out.report.unresolved[0].key;
  // Skip the unknown row (a player from the other team's sheet, say).
  out = validateGameRecordSource(db, sourceId, { resolutions: { [rowKey]: null } }, admin);
  assert.equal(out.status, 'validated');
  const src = db.prepare('SELECT * FROM cmd_game_record_sources WHERE id = ?').get(sourceId);
  assert.equal(src.validation_status, 'validated');
  assert.ok(src.validated_at);
  assert.equal(src.raw_import, csv, 'raw import preserved verbatim');
  assert.ok(db.prepare("SELECT COUNT(*) c FROM cmd_review_actions WHERE target_table='cmd_jobs' AND target_id=? AND action='game_record_source_validated'").get(jobId).c >= 2);
});

test('two releases: metrics publish first; the validated game record later publishes box-score stats labelled scorebook_derived, without touching the metric rollups', () => {
  // Metric release first (radar).
  const reading = db.prepare("INSERT INTO cmd_radar_readings (job_id, source, velocity, status, created_by) VALUES (?, 'manual', 79, 'unmatched', ?)").run(jobId, admin).lastInsertRowid;
  classifyReading(db, reading, { player_id: ace, pitch_or_exit: 'pitch', status: 'matched' }, admin);
  for (const r of db.prepare("SELECT id FROM cmd_metric_results WHERE job_id=? AND status='draft'").all(jobId)) decideResult(db, r.id, { decision: 'approved' }, admin);
  releaseMetrics(db, jobId, admin);
  assert.equal(entry(ace, 'max_velo').value, 79);
  assert.equal(entry(ace, 'bs_pa'), undefined, 'no box score before the game record releases');

  const out = releaseGameRecord(db, jobId, admin);
  assert.equal(out.sources, 1);
  assert.equal(out.players, 3);
  assert.equal(entry(ace, 'bs_pa').value, 4);
  assert.equal(entry(ace, 'bs_pa').method, 'scorebook_derived');
  assert.equal(entry(ace, 'bs_outs').value, 14, 'pitching line lands on the same player, innings stored as outs');
  assert.equal(entry(ace, 'bs_kp').value, 6);
  assert.equal(entry(slugger, 'bs_h').value, 2);
  assert.equal(entry(glove, 'bs_e').value, 1);
  assert.equal(entry(ace, 'max_velo').value, 79, 'metric rollups untouched');
  assert.equal(entry(ace, 'max_velo').method, 'radar_verified');
  assert.ok(entry(ace, 'bs_pa').game_record_source_id, 'provenance points at the source');
  assert.ok(db.prepare("SELECT 1 FROM cmd_review_actions WHERE target_table='cmd_jobs' AND target_id=? AND action='game_record_released'").get(jobId));
});

test('re-release: a corrected record updates in place and removes stale scorebook keys; measured metrics survive', () => {
  const src = db.prepare("SELECT id FROM cmd_game_record_sources WHERE job_id = ? ORDER BY id LIMIT 1").get(jobId);
  // Correction: Ace's RBI count was 1, and the fielding table is gone from the corrected export.
  const corrected = GC_CSV.replace('7,Arm,Ace,1,4,3,.333,.500,1.167,.667,1,0,1,0,0,2,1', '7,Arm,Ace,1,4,3,.333,.500,1.167,.667,1,0,1,0,0,1,1').split('\nNumber,Last,First,TC')[0] + '\n';
  db.prepare('UPDATE cmd_game_record_sources SET raw_import = ? WHERE id = ?').run(corrected, src.id);
  const out = validateGameRecordSource(db, src.id, {}, admin);
  assert.equal(out.status, 'validated');
  releaseGameRecord(db, jobId, admin);
  assert.equal(entry(ace, 'bs_rbi').value, 1, 'corrected in place');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM stat_entries s JOIN games g ON g.id = s.game_id WHERE g.command_job_id = ? AND g.player_id = ? AND s.metric_key = 'bs_rbi'").get(jobId, ace).c, 1, 'no duplicate entry');
  assert.equal(entry(glove, 'bs_e'), undefined, 'stale scorebook key removed');
  assert.equal(entry(ace, 'max_velo').value, 79, 'measured metric untouched by the scorebook correction');
  assert.deepEqual(gameRecordPlan(db, jobId).players.map(p => p.player_id).sort(), [ace, slugger, glove].sort());
});

test('a synthetic job runs the record workflow but writes nothing to profiles; a job with no validated source cannot release', () => {
  const order = db.prepare("INSERT INTO cmd_orders (package_key, label, synthetic) VALUES ('rookie', 'Rookie', 1)").run().lastInsertRowid;
  const sJob = db.prepare("INSERT INTO cmd_jobs (sport_id, team_id, game_date, order_id) VALUES (?, ?, '2026-09-07', ?)").run(baseball, team, order).lastInsertRowid;
  assert.throws(() => releaseGameRecord(db, sJob, admin), /No validated game-record source/);
  const sid = db.prepare("INSERT INTO cmd_game_record_sources (job_id, source_kind, raw_import, created_by) VALUES (?, 'postgame_manual', ?, ?)").run(sJob, 'Number,Last,First,PA,AB,H,R\n7,Arm,Ace,2,2,1,1\n', admin).lastInsertRowid;
  assert.equal(validateGameRecordSource(db, sid, {}, admin).status, 'validated');
  const out = releaseGameRecord(db, sJob, admin);
  assert.equal(out.synthetic, true);
  assert.ok(out.written.every(w => w.withheld === 'synthetic'));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM games WHERE command_job_id = ?').get(sJob).c, 0);
});
