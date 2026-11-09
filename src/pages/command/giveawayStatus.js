// The giveaway's state as Command shows it (GiveawayAdminPage, the Events list card).
export const GIVEAWAY_STATUS = {
  open: { label: 'Open', color: '#4ade80' },
  not_open_yet: { label: 'Not open yet', color: '#fbbf24' },
  ended: { label: 'Ended', color: '#94a3b8' },
};
export const giveawayStatus = g => GIVEAWAY_STATUS[g?.accepting ? 'open' : g?.reason] || GIVEAWAY_STATUS.ended;
