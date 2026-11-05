/**
 * Google Apps Script receiver for the Diamond Metrics Card Station.
 * Attach this script to the designated Google Sheet and deploy as a web app.
 * The sheet should be private to Diamond Metrics staff.
 */
const SHEET_TAB = 'Card Station Leads';

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_TAB);
    if (!sheet) throw new Error('Missing sheet tab: ' + SHEET_TAB);

    const clean = (value) => {
      const text = String(value == null ? '' : value).trim().slice(0, 500);
      return /^[=+@]/.test(text) ? "'" + text : text;
    };
    sheet.appendRow([
      new Date(),
      clean(payload.parentName),
      clean(payload.email),
      clean(payload.phone),
      payload.marketingOptIn === true,
      clean(payload.playerName),
      clean(payload.team),
      clean(payload.event || 'Gobbler Last Chance'),
      clean(payload.createdAt),
    ]);
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}
