const PLAYER_MEDIA_SLUGS = new Set([
  'berto-archuleta',
  'camden-jakobson',
  'clark-yerka',
  'cody-jones',
  'cohen-smith',
  'cole-hansgen',
  'dane-anderson',
  'daniel-zarate',
  'dayne-price',
  'eli-smith',
  'franklyn-semu',
  'gavin-odell',
  'gavin-uriarte',
  'graysen-merkley',
  'harvey-tomsick',
  'isaac-rasmussen',
  'jacob-seager',
  'james-burton',
  'jameson-butterbaugh',
  'jase-headrick',
  'jax-cline',
  'jake-bell',
  'kallman-berry',
  'kaysen-monty',
  'keeton-keele',
  'knox-williams',
  'kolven-clark',
  'luke-child',
  'madden-berni',
  'mckay-green',
  'miles-miller',
  'nicholas-dalton',
  'noah-miller',
  'oliver-thorne',
  'paxton-larsen',
  'reagan-bess',
  'saxon-steele',
  'tatum-brown',
  'will-mabey',
]);

function playerMediaSlug(player) {
  return `${player.first_name}-${player.last_name}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function playerMediaUrl(player, directory, extension) {
  const slug = playerMediaSlug(player);
  return PLAYER_MEDIA_SLUGS.has(slug) ? `/${directory}/${slug}.${extension}` : null;
}

export function getPlayerIntroUrl(player) {
  return playerMediaUrl(player, 'player-intros', 'mp4');
}

export function getPlayerCardStillUrl(player) {
  return playerMediaUrl(player, 'player-card-stills', 'webp');
}
