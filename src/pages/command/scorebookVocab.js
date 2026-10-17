// Shared scorebook vocabulary and player choices (ScorebookPage, ScorebookReview).
export const LABELS = {
  single: '1B', double: '2B', triple: '3B', home_run: 'HR', walk: 'BB', intentional_walk: 'IBB', hit_by_pitch: 'HBP', catcher_interference: 'CI',
  strikeout: 'K', strikeout_looking: 'Kc', groundout: 'GO', flyout: 'FO', lineout: 'LO', popout: 'PO', sacrifice_fly: 'SF', sacrifice_bunt: 'SAC',
  fielders_choice: 'FC', reach_on_error: 'E', double_play: 'DP', triple_play: 'TP', strikeout_reached: 'K·1B',
};
export const POSITIONS = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH', 'EH'];
export const refName = r => (r ? (r.name || r.label || (r.player_id ? `#${r.player_id}` : '—')) : '—');

// Who can be named on a side: our roster; the paired team's roster; or, for
// an unpaired opponent, the labels already in their lineup.
export function playerChoices(data, side) {
  const people = side === 'us' ? data.roster : (data.partner_roster || []);
  if (people.length) {
    return people.map(p => ({ key: `p:${p.id}`, player_id: p.id, label: `${p.first_name} ${p.last_name}`, text: `${p.jersey ? `#${p.jersey} ` : ''}${p.first_name} ${p.last_name}${p.is_guest ? ' · guest' : ''}` }));
  }
  const labels = new Set();
  for (const s of data.state.lineups[side]?.slots || []) for (const r of [s.current, s.starter]) if (r?.label) labels.add(r.label);
  return [...labels].map(l => ({ key: `l:${l}`, player_id: null, label: l, text: l }));
}

// Which side bats in a half: the away team bats in the top.
export const battingIn = (half, usIsHome) => ((half === 'top') === !usIsHome ? 'us' : 'them');
export const halfLabel = (h, inning) => `${h === 'top' ? 'T' : 'B'}${inning}`;
