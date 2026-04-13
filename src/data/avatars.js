const STYLE = 'adventurer';

export function getPlayerAvatarUrl(player) {
  const seed = `${player.firstName}-${player.lastName}-${player.jersey}`;
  return `https://api.dicebear.com/9.x/${STYLE}/svg?seed=${encodeURIComponent(seed)}&backgroundColor=0f172a&radius=50`;
}
