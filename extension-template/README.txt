AniCal Browser Extension
========================

1. Unzip this file.
2. Open chrome://extensions in Chrome (or any Chromium browser: Edge, Brave, Arc, Opera).
3. Toggle "Developer mode" on (top right).
4. Click "Load unpacked" and pick the unzipped folder.
5. Pin the AniCal icon to your toolbar.

What's inside
-------------
- A fully self-contained version of AniCal. No external server required.
- The popup loads the bundled SPA directly (`index.html`).
- A background service worker (`background.js`) checks every minute for
  favourited anime that are about to air and fires native browser
  notifications — even when the popup is closed.

The first time you open the popup, accept the notification permission prompt
in the "My List" tab to enable airing alerts.

Hosted copy: https://anical.lovable.app
