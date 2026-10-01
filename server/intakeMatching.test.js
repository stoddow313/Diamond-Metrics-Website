// Identity and duplicate signals (customer footage submission §8). They only
// ever suggest; these tests pin what counts as a reasonable match.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TEST_DB = `/tmp/dm-intake-match-${process.pid}.db`;
process.env.DM_DB_PATH = TEST_DB;
process.env.DM_LOG_SILENT = '1';

const { db } = await import('./db.js');
const { loadPlayerIndex, scorePlayerCandidates, isAmbiguous, teamCandidates, jobCandidates, contactDuplicates } = await import('./intakeMatching.js');

let team, other, william, wiliam, will2010;
before(() => {
  const org = db.prepare("INSERT INTO organizations (name) VALUES ('Riverton Baseball Club')").run().lastInsertRowid;
  team = db.prepare("INSERT INTO teams (organization_id, name, slug, age_group) VALUES (?, 'Riverton Silverwolves', 'rsw', '12U')").run(org).lastInsertRowid;
  other = db.prepare("INSERT INTO teams (organization_id, name, slug, age_group) VALUES (?, 'Herriman Hawks', 'hh', '12U')").run(org).lastInsertRowid;
  william = db.prepare("INSERT INTO players (first_name, last_name, slug, date_of_birth) VALUES ('William', 'Stoddard', 'ws', '2014-04-04')").run().lastInsertRowid;
  wiliam = db.prepare("INSERT INTO players (first_name, last_name, slug, date_of_birth) VALUES ('William', 'Stodard', 'ws2', '2009-01-01')").run().lastInsertRowid;
  will2010 = db.prepare("INSERT INTO players (first_name, last_name, slug, grad_year) VALUES ('Will', 'Stoddard', 'ws3', 2028)").run().lastInsertRowid;
  db.prepare("INSERT INTO roster_memberships (team_id, player_id, start_date, end_date) VALUES (?, ?, '2026-01-01', '2026-12-31')").run(team, william);
});
after(() => {
  db.close();
  for (const f of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) fs.rmSync(f, { force: true });
});

test('a short form, a one-letter typo and a birth-year conflict each score differently, with reasons', () => {
  const index = loadPlayerIndex(db);
  const c = scorePlayerCandidates(db, index, { first_name: 'Will', last_name: 'Stoddard', birth_year: 2014 }, { teamIds: [team], gameDate: '2026-09-20' });
  const byId = Object.fromEntries(c.map(x => [x.player_id, x]));
  assert.equal(c[0].player_id, william, 'roster + birth year + short form wins');
  assert.equal(byId[william].confidence, 'high');
  assert.ok(byId[william].reasons.includes('first name is a short form of the other'));
  assert.ok(byId[william].reasons.some(r => /roster for this game date/.test(r)));
  assert.ok(byId[will2010].reasons.some(r => /class of 2028 does not fit/.test(r)), 'a grad year that cannot fit counts against');
  assert.ok(!byId[wiliam] || byId[wiliam].score < byId[william].score, 'a typo with a conflicting birth year ranks lower');
});

test('no match on last name alone, and nothing for a different first name', () => {
  const index = loadPlayerIndex(db);
  assert.deepEqual(scorePlayerCandidates(db, index, { first_name: 'Harper', last_name: 'Stoddard' }), []);
  assert.deepEqual(scorePlayerCandidates(db, index, { first_name: '', last_name: '' }), []);
});

test('ambiguity: more than one reasonable match, or a best match that is not high', () => {
  assert.equal(isAmbiguous([{ confidence: 'high' }]), false);
  assert.equal(isAmbiguous([{ confidence: 'high' }, { confidence: 'medium' }]), true);
  assert.equal(isAmbiguous([{ confidence: 'medium' }]), true);
  assert.equal(isAmbiguous([]), false);
});

test('team suggestions use the name, the age group and the account’s verified links', () => {
  const c = teamCandidates(db, { label: 'Silverwolves', level: '12U' });
  assert.equal(c[0].team_id, team);
  assert.ok(c[0].reasons.includes('same age group (12U)'));
  const acct = db.prepare("INSERT INTO customer_accounts (email, first_name, last_name, role) VALUES ('c@x.test', 'C', 'Coach', 'coach')").run().lastInsertRowid;
  db.prepare("INSERT INTO customer_team_links (account_id, team_id, relationship) VALUES (?, ?, 'coach')").run(acct, other);
  const linked = teamCandidates(db, { label: '', accountId: acct });
  assert.equal(linked[0].team_id, other);
  assert.ok(linked[0].reasons.includes('this account is linked to the team'));
});

test('a job is suggested only for the same team; the opponent’s job for the same game is flagged, not linkable', () => {
  const sport = db.prepare("SELECT id FROM sports WHERE key = 'baseball'").get().id;
  const order = db.prepare("INSERT INTO cmd_orders (package_key) VALUES ('rookie')").run().lastInsertRowid;
  // Herriman's job for Herriman v Riverton on the 20th.
  const job = db.prepare("INSERT INTO cmd_jobs (sport_id, team_id, game_date, order_id, opponent_label) VALUES (?, ?, '2026-09-20', ?, 'Riverton Silverwolves')").run(sport, other, order).lastInsertRowid;
  const mine = jobCandidates(db, { teamIds: [other], gameDate: '2026-09-20', opponent: 'Riverton' });
  assert.deepEqual(mine.map(j => j.id), [job]);
  assert.deepEqual(mine[0].reasons, ['same team', 'same date', 'same opponent']);
  assert.deepEqual(jobCandidates(db, { teamIds: [other], gameDate: '2026-09-21' }).map(j => j.id), [job], 'a day apart still surfaces');
  assert.deepEqual(jobCandidates(db, { teamIds: [team], gameDate: '2026-09-20', opponent: 'Herriman Hawks', event: 'Fall Classic' }), [],
    'another team on the same day is a different game, even against the same opponent');
  const theirs = jobCandidates(db, { teamIds: [team], opponentTeamIds: [other], teamLabel: 'Riverton Silverwolves', gameDate: '2026-09-20' });
  assert.equal(theirs[0].other_side, true, 'a Riverton parent sees that Herriman already has a job for this game');
});

test('contact duplicates: same phone, same name, and linked logins by email', () => {
  const a = db.prepare("INSERT INTO customer_accounts (email, first_name, last_name, phone_normalized) VALUES ('a@x.test', 'Pat', 'Lee', '18015550100')").run().lastInsertRowid;
  db.prepare("INSERT INTO customer_accounts (email, first_name, last_name, phone_normalized) VALUES ('b@x.test', 'Sam', 'Ray', '18015550100')").run();
  db.prepare("INSERT INTO customer_accounts (email, first_name, last_name) VALUES ('c2@x.test', 'Pat', 'Lee')").run();
  const d = contactDuplicates(db, db.prepare('SELECT * FROM customer_accounts WHERE id = ?').get(a));
  assert.deepEqual(d.map(x => x.reason).sort(), ['same name', 'same phone number']);
});
