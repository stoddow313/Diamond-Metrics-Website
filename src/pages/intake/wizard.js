// The guided intake sequence (customer footage submission §5): which steps a
// submission has, what each step needs before moving on, and where each
// server-side readiness item is fixed. Mirrors submitReadiness() on the API.

const STEPS = [
  { key: 'role', label: 'About you' },
  { key: 'service', label: 'Service' },
  { key: 'game', label: 'Game' },
  { key: 'athletes', label: 'Athletes' },
  { key: 'footage', label: 'Footage' },
  { key: 'terms', label: 'Guide & terms' },
  { key: 'upload', label: 'Upload' },
  { key: 'review', label: 'Review' },
];

// Hall of Fame is a consultation: no footage, terms or upload steps.
export function stepsFor(form) {
  if (form?.service?.package_key === 'hall_of_fame') {
    return STEPS.filter(s => !['footage', 'terms', 'upload'].includes(s.key)).map(s => (s.key === 'game' ? { ...s, label: 'Event' } : s));
  }
  return STEPS;
}

export const RELATIONSHIP_FOR_ROLE = { parent: 'parent', guardian: 'guardian', athlete: 'self', coach: 'coach', team_rep: 'team_rep', director: 'director' };
export const groupOf = (config, role) => config?.roles.find(r => r.key === role)?.group || '';

export function blankAthlete(form) {
  return {
    player_id: null, first_name: '', last_name: '', birth_year: null,
    age_band: form.game?.level || '', team_label: form.game?.team_label || '', jersey: '',
    relationship: RELATIONSHIP_FOR_ROLE[form.role] || '',
  };
}

const blank = v => !String(v ?? '').trim();

// What the customer must fix before leaving a step. `rightsOk` is whether
// the current terms were accepted for the current role.
export function stepProblems(step, form, { config, profile, rightsOk }) {
  const p = [];
  const group = groupOf(config, form.role);
  const inquiry = form.service.package_key === 'hall_of_fame';
  const thisYear = new Date().getFullYear();
  if (step === 'role') {
    if (!form.role) p.push('Choose who you are submitting as.');
    if (blank(profile?.first_name) || blank(profile?.last_name)) p.push('Add your first and last name.');
  } else if (step === 'service') {
    if (!form.service.package_key) p.push('Choose a service option.');
    if (form.service.package_key === 'custom' && blank(form.service.requested_metrics)) p.push('Tell us what you would like measured.');
  } else if (step === 'game' && !inquiry) {
    if (!form.game.date) p.push('Add the game date.');
    if (blank(form.game.team_label) && !form.game.team_id) p.push('Add your team.');
    if (blank(form.game.event_label) && !form.game.no_event) p.push('Add the event or tournament, or tick “regular-season game”.');
    if (blank(form.game.level)) p.push('Add the age group or level.');
  } else if (step === 'athletes') {
    if (group === 'family' && !inquiry && form.athletes.length === 0) p.push('Add the athlete this footage is for.');
    form.athletes.forEach((a, i) => {
      if (a.player_id) return;
      const n = form.athletes.length > 1 ? `Athlete ${i + 1}: ` : '';
      if (blank(a.first_name) || blank(a.last_name)) p.push(`${n}Add a first and last name.`);
      if (!a.birth_year && blank(a.age_band)) p.push(`${n}Add a birth year or age group.`);
      if (!a.relationship) p.push(`${n}Add your relationship to the athlete.`);
      if (form.role === 'athlete' && a.relationship === 'self' && a.birth_year && thisYear - a.birth_year <= 17) {
        p.push('Athletes under 18 need a parent or legal guardian to submit for them.');
      }
    });
  } else if (step === 'footage') {
    if (!form.footage.coverage) p.push('Tell us whether this is the full game or clips.');
  } else if (step === 'terms') {
    if (!rightsOk) p.push('Read the filming guide and accept the footage terms.');
  }
  return p;
}

// Server readiness code → the step that fixes it (null: not a form step).
export function stepForReadiness(code) {
  if (code === 'role') return 'role';
  if (code === 'package') return 'service';
  if (['game_date', 'team', 'event', 'level'].includes(code)) return 'game';
  if (String(code).startsWith('athlete')) return 'athletes';
  if (code === 'coverage') return 'footage';
  if (code === 'rights') return 'terms';
  if (['video', 'uploads', 'camera_view', 'file_action'].includes(code)) return 'upload';
  return null;
}

export const LEVELS = ['8U', '9U', '10U', '11U', '12U', '13U', '14U', '15U', '16U', '17U', '18U', 'High school JV', 'High school varsity', 'College', 'Adult'];
