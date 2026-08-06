// Roster-history acceptance tests (requirements doc §12): dated memberships,
// overlapping memberships, guest players, archive-preserves-history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { membershipCoversDate, rosterOnDate, resolveEventRoster, slugify } from './rosterLogic.js';

const m = (over = {}) => ({
  id: 1, player_id: 1, team_id: 10, season_id: 1,
  start_date: '2026-03-01', end_date: null, jersey: '7', positions: 'SS',
  roster_role: 'player', status: 'active', ...over,
});

test('membership covers its dated window, open-ended when end_date is null', () => {
  assert.equal(membershipCoversDate(m(), '2026-06-15'), true);
  assert.equal(membershipCoversDate(m(), '2026-02-28'), false);
  assert.equal(membershipCoversDate(m({ end_date: '2026-05-31' }), '2026-06-01'), false);
  assert.equal(membershipCoversDate(m({ end_date: '2026-05-31' }), '2026-05-31'), true);
});

test('a player can represent different teams in different periods with history intact', () => {
  const history = [
    m({ id: 1, team_id: 10, start_date: '2025-03-01', end_date: '2025-08-01' }),
    m({ id: 2, team_id: 20, start_date: '2026-03-01', end_date: null }),
  ];
  assert.equal(rosterOnDate(history, 10, '2025-06-01').length, 1); // old team, old date
  assert.equal(rosterOnDate(history, 10, '2026-06-01').length, 0); // old team, new date
  assert.equal(rosterOnDate(history, 20, '2026-06-01').length, 1); // new team, new date
});

test('overlapping memberships are legal (club + school) and dedupe per team', () => {
  const overlapping = [
    m({ id: 1, team_id: 10, start_date: '2026-01-01' }),          // school
    m({ id: 2, player_id: 1, team_id: 20, start_date: '2026-01-01' }), // club, same window
    m({ id: 3, player_id: 1, team_id: 10, start_date: '2026-04-01', jersey: '12' }), // re-signed, newer row
  ];
  assert.equal(rosterOnDate(overlapping, 10, '2026-06-01').length, 1); // deduped
  assert.equal(rosterOnDate(overlapping, 10, '2026-06-01')[0].jersey, '12'); // newest wins
  assert.equal(rosterOnDate(overlapping, 20, '2026-06-01').length, 1); // both teams simultaneously
});

test('event roster overrides season roster and labels guests', () => {
  const memberships = [
    m({ player_id: 1, team_id: 10 }),
    m({ id: 2, player_id: 2, team_id: 10 }),
  ];
  const eventRosterRows = [
    { player_id: 1, is_guest: 0, jersey: '7' },   // season member attending
    { player_id: 99, is_guest: 1, jersey: '44' }, // declared guest
    { player_id: 50, is_guest: 0, jersey: '3' },  // not on season roster → auto-guest
  ];
  const resolved = resolveEventRoster({ eventRosterRows, memberships, teamId: 10, eventDate: '2026-06-20' });
  const byId = Object.fromEntries(resolved.map(r => [r.player_id, r]));
  assert.equal(resolved.length, 3);
  assert.equal(byId[1].isGuest, false);
  assert.equal(byId[99].isGuest, true);
  assert.equal(byId[50].isGuest, true);          // labeled, not silently blended
  assert.equal(byId[2], undefined);              // season member not at event = not on it
});

test('no event roster → falls back to season roster on the event date', () => {
  const memberships = [m({ player_id: 1 }), m({ id: 2, player_id: 2, end_date: '2026-05-01' })];
  const resolved = resolveEventRoster({ eventRosterRows: [], memberships, teamId: 10, eventDate: '2026-06-20' });
  assert.equal(resolved.length, 1); // player 2's membership ended before the event
  assert.equal(resolved[0].source, 'season');
});

test('guest appearance never mutates the season roster', () => {
  const memberships = [m({ player_id: 1, team_id: 10 })];
  resolveEventRoster({
    eventRosterRows: [{ player_id: 99, is_guest: 1 }],
    memberships, teamId: 10, eventDate: '2026-06-20',
  });
  // memberships array untouched — player 99 still has zero memberships
  assert.equal(memberships.length, 1);
  assert.equal(rosterOnDate(memberships, 10, '2026-06-20').some(r => r.player_id === 99), false);
});

test('slugs are url-safe', () => {
  assert.equal(slugify('Bingham Miners 16U — Gold'), 'bingham-miners-16u-gold');
});
