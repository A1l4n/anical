# AniCal — Anime Airing Schedule

A clean, fast anime airing calendar with JST→local time conversion, favorites, live countdowns, and airing notifications.

No account. No ads. No tracking. Everything stays on your device.

---

## Features

- **Weekly schedule** — full seasonal lineup by day, sorted by airtime
- **Favorites & countdowns** — watchlist with live "in 2h 15m / AIRING NOW" timers
- **Notifications** — alerts up to 60 min before a favorited show airs
- **Month view** — calendar with dot indicators (orange = favorited)
- **My List tab** — watchlist grouped by Live → Next 12h → Today → This week
- **19 timezone presets** — auto-detect or pick manually
- **Offline cache** — 4-hour schedule cache works without internet
- **Browser extension** — popup version for Chrome/Edge/Brave

Data: [MyAnimeList](https://myanimelist.net) via [Jikan API](https://jikan.moe) (free, no key required).

---

## Downloads

| Platform | Link |
|----------|------|
| Android APK | `AniCal.apk` in this repo (sideload) |
| Browser extension | `dist/anical-extension.zip` — load unpacked in Chrome |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| UI | React 19 + TanStack Router |
| Build | Vite 7 |
| Android | Capacitor 8 |
| Notifications (native) | `@capacitor/local-notifications` |
| Notifications (web/ext) | Web Notification API + Chrome Alarms MV3 |
| Data | Jikan API v4 (`api.jikan.moe`) |

---

## Local Development

```bash
npm install
npm run dev           # web dev server
npm run build         # production web build
npm run build:ext     # browser extension zip (requires build first)
npm run build:all     # web + extension in one go
```

### Android APK / AAB

```bash
npm run build
npx cap sync android
cd android
./gradlew assembleRelease   # APK  → app/build/outputs/apk/release/
./gradlew bundleRelease     # AAB  → app/build/outputs/bundle/release/  (Play Store)
```

Requires JDK 21. Copy `keystore.properties.example` → `keystore.properties` and fill in your signing credentials before building.

---

## Project Structure

```
src/
  components/AniCal.tsx   # entire app UI
  lib/notifications.ts    # cross-platform notification abstraction
  routes/                 # TanStack Router file-based routes
  main.tsx                # SPA entry point

android/                  # Capacitor Android project
extension-template/       # Chrome extension manifest + background service worker
scripts/
  build-extension.mjs     # packages dist/ into a .zip extension
store/
  STORE_LISTING.md        # Play Store / App Store listing copy
  PRIVACY_POLICY.md       # privacy policy
public/
  icon-512.png / icon-192.png / apple-touch-icon.png
  manifest.webmanifest    # PWA manifest
```

---

## Browser Extension

1. Run `npm run build:all`
2. Open `chrome://extensions` → enable **Developer mode**
3. Click **Load unpacked** → select the `extension-build/` folder

---

## Privacy

Favorites, settings, and the schedule cache are stored only in your device's local storage — nothing is sent to any server except schedule fetch requests to `api.jikan.moe`.

Full policy: [`store/PRIVACY_POLICY.md`](store/PRIVACY_POLICY.md)

---

## Credits

- Data: [MyAnimeList](https://myanimelist.net) via [Jikan](https://jikan.moe)
- Built with [Capacitor](https://capacitorjs.com), [TanStack Router](https://tanstack.com/router), [Vite](https://vitejs.dev)

*Fan-made — not affiliated with MyAnimeList.*
