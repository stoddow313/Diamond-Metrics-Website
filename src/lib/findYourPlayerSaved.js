// What a parent typed on Find Your Player, kept in this browser tab only, so
// a canceled Stripe checkout comes back filled in (prd.md R8). sessionStorage
// stays in the tab on the parent's own phone and is gone when the tab closes;
// storage that throws (private browsing) behaves as if nothing was saved.
const KEY = 'dm_find_your_player';

export function loadSavedPlayerDetails() {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
}

export function savePlayerDetails(details) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(details));
  } catch {
    // The cancel page then opens empty, without the "still here" notice.
  }
}

export function clearSavedPlayerDetails() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing was saved.
  }
}
