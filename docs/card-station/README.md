# Diamond Metrics Card Station

This package adds the card station at `/card-station/` as a standalone static app in the Diamond Metrics Vite site. It is not linked from the main navigation and has `noindex, nofollow` metadata. It is configured for the Gobbler Last Chance event.

## Add the page to the website repository

Copy `public/card-station/` into the website repository's `public/card-station/` directory. Vite serves the folder at `https://www.diamondmetrics.ai/card-station/` (use the site's canonical domain as configured).

The app must be served over HTTPS for camera access. Keep its relative asset paths intact. The original generator's camera and download flow is hosted as a standalone page rather than an iframe.

## Connect lead collection to Google Sheets

The generator's parent form currently does not send data because `leadEndpoint` in `public/card-station/app.js` is blank. Do not advertise the form as collecting entries until the endpoint is connected and a submission is confirmed in the sheet.

1. Create a private Google Sheet named `Diamond Metrics Card Station Leads`.
2. Add a tab named `Card Station Leads` with these headers in row 1: `Received At`, `Parent / Guardian`, `Email`, `Phone`, `Marketing Opt-In`, `Player`, `Team`, `Event`, `Submitted At`.
3. In that Sheet, open **Extensions → Apps Script**, replace the editor contents with `lead-capture/Code.gs`, and save.
4. Choose **Deploy → New deployment → Web app**. Set **Execute as** to your account and access to **Anyone** so the public event page can submit. Deploy and copy the web app URL ending in `/exec`.
5. Replace the empty `leadEndpoint` value in `public/card-station/app.js` with that URL, then publish the website change.
6. Submit one test entry on the live page and verify the row appears in the private Sheet.

The page sends only the parent form fields, player name, team, event and submission time. Photo and player-card details stay in the visitor's browser. The form uses a cross-origin `no-cors` request, so the page cannot display a reliable delivery error; verify receipt in the Sheet before relying on it at the event.

The current UI requires parent name, email and phone to generate a card. The email/text marketing checkbox is optional. Only use the marketing opt-in field for the consent scope shown to the visitor.
