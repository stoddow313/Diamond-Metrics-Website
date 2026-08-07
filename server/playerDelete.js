// Full player deletion. Must clear every dependent table explicitly: the
// team/tournament tables (roster_memberships, event_rosters,
// player_game_appearances) have no ON DELETE CASCADE, so deleting the
// players row alone aborts on their foreign keys.
//
// Order: leaf tables first (stat_entries via games, sessions via accounts),
// then the direct player_id references, then the player. One transaction for
// the whole id list — a failure on any id rolls back everything.
export function deletePlayers(db, ids) {
  const run = db.transaction(list => {
    let deleted = 0;
    for (const id of list) {
      db.prepare('DELETE FROM stat_entries WHERE game_id IN (SELECT id FROM games WHERE player_id = ?)').run(id);
      db.prepare('DELETE FROM games WHERE player_id = ?').run(id);
      db.prepare('DELETE FROM player_game_appearances WHERE player_id = ?').run(id);
      db.prepare('DELETE FROM event_rosters WHERE player_id = ?').run(id);
      db.prepare('DELETE FROM roster_memberships WHERE player_id = ?').run(id);
      db.prepare('DELETE FROM player_ratings WHERE player_id = ?').run(id);
      db.prepare('DELETE FROM invites WHERE player_id = ?').run(id);
      db.prepare('DELETE FROM player_sessions WHERE player_user_id IN (SELECT id FROM player_users WHERE player_id = ?)').run(id);
      db.prepare('DELETE FROM player_users WHERE player_id = ?').run(id);
      deleted += db.prepare('DELETE FROM players WHERE id = ?').run(id).changes;
    }
    return deleted;
  });
  return run(ids);
}
