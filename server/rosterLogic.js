// Roster resolution — pure functions, no database access (tested directly).
//
// Rules (docs/PLATFORM_ROADMAP.md §5.1, requirements doc §3):
// - Memberships are dated; overlapping memberships are legal (club + school).
// - An event roster, when present, OVERRIDES the season roster for deciding
//   who represented a team at a tournament — without mutating memberships.
// - Guest players exist only on the event roster.
// - Archived memberships never disappear from history: they still count for
//   the dates they covered.

// A membership covers a date when the date falls inside [start_date, end_date]
// (open-ended when end_date is null). Archived rows still cover their dates —
// archiving stops FUTURE coverage (end_date is set on archive), it does not
// rewrite the past.
export function membershipCoversDate(membership, dateIso) {
  if (!membership || !dateIso) return false;
  if (membership.start_date && dateIso < membership.start_date) return false;
  if (membership.end_date && dateIso > membership.end_date) return false;
  return true;
}

// Players on a team's roster as of a given date (deduped across overlapping
// memberships; the most recent start_date wins for jersey/positions display).
export function rosterOnDate(memberships, teamId, dateIso) {
  const byPlayer = new Map();
  for (const m of memberships) {
    if (m.team_id !== teamId) continue;
    if (!membershipCoversDate(m, dateIso)) continue;
    const existing = byPlayer.get(m.player_id);
    if (!existing || (m.start_date || '') > (existing.start_date || '')) {
      byPlayer.set(m.player_id, m);
    }
  }
  return [...byPlayer.values()];
}

// Who represented an entry at a tournament.
// - With event-roster rows: exactly those players; each is labeled guest or
//   season member (season membership checked against the event date).
// - Without event-roster rows: fall back to the season roster on the event
//   start date (no guests possible in that case).
export function resolveEventRoster({ eventRosterRows = [], memberships = [], teamId, eventDate }) {
  if (eventRosterRows.length > 0) {
    return eventRosterRows.map(row => {
      const seasonMember = memberships.some(
        m => m.team_id === teamId && m.player_id === row.player_id && membershipCoversDate(m, eventDate)
      );
      return {
        player_id: row.player_id,
        jersey: row.jersey || '',
        source: 'event',
        isGuest: !!row.is_guest || !seasonMember,
      };
    });
  }
  return rosterOnDate(memberships, teamId, eventDate).map(m => ({
    player_id: m.player_id,
    jersey: m.jersey || '',
    source: 'season',
    isGuest: false,
  }));
}

// URL slug for teams/tournaments (same conventions as player slugs).
export function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
