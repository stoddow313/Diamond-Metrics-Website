// Choices for the tournament editor; the server enforces the same lists
// (server/tournamentAdminLogic.js).
export const GAME_STAGES = [
  { key: 'pool', label: 'Pool Play' },
  { key: 'gold', label: 'Gold' },
  { key: 'silver', label: 'Silver' },
  { key: 'single', label: 'Single Bracket' },
];
export const GAME_STATUSES = [
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'final', label: 'Final' },
  { key: 'canceled', label: 'Canceled' },
];
export const stageLabel = key => GAME_STAGES.find(s => s.key === key)?.label || '';
export const stageTone = key => (key === 'gold' ? 'gold' : key === 'silver' ? 'silver' : 'accent');

export const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;

// '' → null for the server's number fields.
export const numOrNull = v => (v === '' || v == null ? null : Number(v));
export const fromNull = v => (v == null ? '' : String(v));
