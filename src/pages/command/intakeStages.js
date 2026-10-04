// Intake queue stages for Will's pages: a short chip label, and what the
// stage means (shown as its tooltip).
export const STAGES = {
  new: { label: 'New', tone: '#38bdf8', tip: 'Submitted and not reviewed yet.' },
  needs_identity_review: { label: 'Identity review', tone: '#fbbf24', tip: 'An athlete needs a link, a new player or a guest placeholder.' },
  needs_customer_action: { label: 'Waiting on customer', tone: '#fbbf24', tip: 'We asked the customer for something and are waiting on their reply.' },
  ready_for_job: { label: 'Ready for job', tone: '#4ade80', tip: 'Identity is settled — create or link the Command job.' },
  in_analysis: { label: 'In analysis', tone: '#c4b5fd', tip: 'On a Command job; metrics are not released yet.' },
  metrics_released: { label: 'Metrics released', tone: '#4ade80', tip: 'Metrics are out; the box score has not been started.' },
  game_record_pending: { label: 'Box score pending', tone: '#38bdf8', tip: 'Metrics are out; the box score is in progress.' },
  complete: { label: 'Complete', tone: '#4ade80', tip: 'Metrics and the full game record are released.' },
  closed: { label: 'Closed', tone: '#64748b', tip: 'Closed or declined. Nothing was deleted.' },
  draft: { label: 'Draft', tone: '#64748b', tip: 'Started but not sent — often waiting on email verification.' },
};
