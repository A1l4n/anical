// AniCal background service worker.
// Wakes every minute, reads favs + schedule + notification settings from
// chrome.storage.local (mirrored by the popup), and fires native browser
// notifications when a favourited anime is about to air.

const DAYS = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];

function nextJstAiringMs(broadcastDay, broadcastTime) {
  if (!broadcastDay || !broadcastTime) return null;
  const dayIdx = DAYS.indexOf(String(broadcastDay).toLowerCase());
  if (dayIdx < 0) return null;
  const parts = String(broadcastTime).split(":").map(Number);
  const h = parts[0], m = parts[1];
  if (Number.isNaN(h) || Number.isNaN(m)) return null;

  const now = Date.now();
  const jst = new Date(now + 9 * 3600 * 1000);
  const jstY = jst.getUTCFullYear(), jstMo = jst.getUTCMonth(), jstD = jst.getUTCDate();
  const ourDow = (jst.getUTCDay() + 6) % 7;
  const diff = (dayIdx - ourDow + 7) % 7;
  let cand = Date.UTC(jstY, jstMo, jstD + diff, h - 9, m);
  if (cand <= now + 60_000) cand = Date.UTC(jstY, jstMo, jstD + diff + 7, h - 9, m);
  return cand;
}

async function checkAndNotify() {
  const store = await chrome.storage.local.get([
    "anical_favs", "anical_notif", "anical_schedule_cache", "anical_notif_fired"
  ]);
  const favs = store.anical_favs || [];
  const notifCfg = store.anical_notif || { enabled: false, leadMinutes: 10, perAnime: {} };
  const cache = store.anical_schedule_cache;
  const fired = store.anical_notif_fired || {};

  if (!favs.length || !notifCfg.enabled || !cache?.data) return;

  const lead = (notifCfg.leadMinutes || 0) * 60_000;
  const now = Date.now();
  const windowMs = 5 * 60_000;   // fire if we're within 5 min after the trigger
  const dedupeMs = 6 * 3600_000; // don't refire for same anime within 6 hours

  const seen = new Set();
  for (const day of DAYS) {
    for (const a of (cache.data[day] || [])) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      if (!favs.includes(a.id)) continue;
      if (notifCfg.perAnime?.[a.id] === false) continue;

      const airMs = nextJstAiringMs(a.broadcast_day, a.broadcast_time);
      if (!airMs) continue;
      const fireMs = airMs - lead;
      if (fireMs <= now && now < fireMs + windowMs) {
        const lastFired = fired[a.id] || 0;
        if (now - lastFired < dedupeMs) continue;
        chrome.notifications.create(`anical-${a.id}-${airMs}`, {
          type: "basic",
          iconUrl: chrome.runtime.getURL("icon.png"),
          title: a.title || "AniCal",
          message: notifCfg.leadMinutes === 0
            ? "Airing now"
            : `Starts in ${notifCfg.leadMinutes} min · ${a.broadcast_time} JST`,
          priority: 2,
        });
        fired[a.id] = now;
      }
    }
  }

  // Prune entries older than 24h
  for (const id of Object.keys(fired)) {
    if (now - fired[id] > 24 * 3600_000) delete fired[id];
  }
  await chrome.storage.local.set({ anical_notif_fired: fired });
}

function ensureAlarm() {
  chrome.alarms.get("anical-check", (existing) => {
    if (!existing) chrome.alarms.create("anical-check", { periodInMinutes: 1 });
  });
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "anical-check") checkAndNotify().catch((e) => console.error("[AniCal]", e));
});

// Re-check whenever the popup writes new favs / schedule / settings.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.anical_favs || changes.anical_notif || changes.anical_schedule_cache) {
    checkAndNotify().catch(() => {});
  }
});
