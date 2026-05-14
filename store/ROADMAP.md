# AniCal — Improvement Roadmap

## v1.1 — Polish & UX (next)

### Pull-to-refresh
Swipe down on the schedule list to force a refresh without hunting for the ↻ button.
- Implementation: touch event listener on the scroll container, or `@capacitor/motion`

### Swipe between days
Swipe left/right on the schedule to move to the previous/next day — much more natural on mobile.
- Implementation: touch start/end delta, update `selectedDay` state

### Haptic feedback
Short vibration when toggling a favorite (★ / ☆).
- Implementation: `@capacitor/haptics` — one line: `Haptics.impact({ style: ImpactStyle.Light })`

### Genre filter chip bar
A horizontal row of genre chips above the schedule (Action, Romance, Fantasy…). Tap to filter.
- No new data needed — genres already come from the API

### Sort options in schedule
Currently sorted by airtime. Add toggle: **Time** / **Score** / **Title (A–Z)**

### Better empty state on My List
When the watchlist is empty, show a card from today's schedule as a suggestion ("You might like…")

---

## v1.2 — Episode Tracking

### Mark episodes as watched
Each anime in My List gets an episode counter: `[3 / 12]` with + / – buttons.
Stored in localStorage. Shows a completion badge when finished.

### Completed shelf
A "Completed" bucket at the bottom of My List for finished shows.

---

## v1.3 — Social & Share

### Share anime
On native: tap a share icon in the detail sheet → triggers Android/iOS native share sheet with:
`"Attack on Titan airs Saturdays at 00:10 JST (7:10 PM your time) — https://myanimelist.net/..."`
- Implementation: `@capacitor/share` plugin

### Share watchlist
Generate a simple text list of your favorites to paste anywhere.

---

## v1.4 — Deeper Native Integration

### Android home screen widget
Shows the next airing favorite with a live countdown.
- Requires native Android XML widget layout + Capacitor plugin bridge
- Medium complexity — needs a Kotlin widget class

### Android notification badge
Show unread/upcoming count on the app icon badge.
- Implementation: `@capawesome/capacitor-badge`

### Lock screen / notification controls (iOS)
Show "now airing" notification with expandable info card.

---

## v2.0 — Account & Sync (optional, post-launch)

### MAL / AniList OAuth sync
Log in with your MyAnimeList or AniList account and import your existing list.
- Requires OAuth flow and a small backend proxy (Cloudflare Worker) to handle tokens securely

### Cloud sync across devices
Sync favorites across phone, tablet, and browser extension via a lightweight backend.
- Option: use Supabase (free tier) with anonymous sessions keyed to a device-generated UUID

---

## Bugs to fix (known)

| Bug | Impact | Fix |
|-----|--------|-----|
| Genre "Top genre" stat tile truncates without tooltip | Low | Add `title` attr |
| Timezone selector flickers on first render | Low | Init from localStorage before first paint |
| Month view dots capped at 6 — no quick drill-down tap | Medium | Tap dot opens day sheet |
| Search doesn't highlight matched text in results | Low | Wrap match in `<mark>` |
| Notification re-enable flow unclear when denied | Medium | Add deep-link to app settings |
