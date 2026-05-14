// Cross-platform notifications layer.
//   - On Capacitor (Android APK): schedule real OS-level notifications via
//     @capacitor/local-notifications. These fire even when the app is closed.
//   - On the web (PWA / browser): fall back to the Web Notification API,
//     scheduled with setTimeout while the page is open. Closing the tab
//     cancels pending web notifications — that's a browser limitation, not ours.

type Capacitor = {
  isNativePlatform: () => boolean;
  getPlatform: () => string;
};

type LocalNotificationsPlugin = {
  requestPermissions: () => Promise<{ display: string }>;
  checkPermissions: () => Promise<{ display: string }>;
  schedule: (opts: { notifications: ScheduledNotification[] }) => Promise<unknown>;
  cancel: (opts: { notifications: { id: number }[] }) => Promise<unknown>;
  getPending: () => Promise<{ notifications: { id: number }[] }>;
};

type ScheduledNotification = {
  id: number;
  title: string;
  body: string;
  schedule: { at: Date };
  smallIcon?: string;
  largeIcon?: string;
  extra?: Record<string, unknown>;
};

let nativeCache: { Capacitor: Capacitor; LocalNotifications: LocalNotificationsPlugin } | null | undefined;

async function getNative() {
  if (nativeCache !== undefined) return nativeCache;
  try {
    const { Capacitor } = await import("@capacitor/core");
    if (!Capacitor.isNativePlatform()) {
      nativeCache = null;
      return null;
    }
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    nativeCache = {
      Capacitor: Capacitor as Capacitor,
      LocalNotifications: LocalNotifications as LocalNotificationsPlugin,
    };
    return nativeCache;
  } catch {
    nativeCache = null;
    return null;
  }
}

export type NotifySupport = "native" | "web" | "unsupported";

export async function getSupport(): Promise<NotifySupport> {
  const n = await getNative();
  if (n) return "native";
  if (typeof window !== "undefined" && "Notification" in window) return "web";
  return "unsupported";
}

export async function getPermission(): Promise<"granted" | "denied" | "default" | "unsupported"> {
  const n = await getNative();
  if (n) {
    const res = await n.LocalNotifications.checkPermissions();
    if (res.display === "granted") return "granted";
    if (res.display === "denied") return "denied";
    return "default";
  }
  if (typeof window !== "undefined" && "Notification" in window) {
    return Notification.permission as "granted" | "denied" | "default";
  }
  return "unsupported";
}

export async function requestPermission(): Promise<"granted" | "denied" | "default"> {
  const n = await getNative();
  if (n) {
    const res = await n.LocalNotifications.requestPermissions();
    return (res.display === "granted" ? "granted" : "denied") as "granted" | "denied";
  }
  if (typeof window !== "undefined" && "Notification" in window) {
    const res = await Notification.requestPermission();
    return res as "granted" | "denied" | "default";
  }
  return "denied";
}

// Web fallback: track timeouts so we can cancel them.
const webTimers = new Map<number, number>();

export type ScheduleEntry = {
  id: number;          // stable id per anime
  title: string;       // anime title
  body: string;        // notification body, e.g. "Airing now on Crunchyroll"
  fireAt: Date;        // absolute time to fire
  url?: string;        // optional deep-link URL to open
};

export async function schedule(entries: ScheduleEntry[]): Promise<void> {
  // Filter out anything in the past.
  const now = Date.now();
  const future = entries.filter((e) => e.fireAt.getTime() > now + 1000);

  // Clear existing first to avoid duplicates.
  await cancelAll();

  const n = await getNative();
  if (n) {
    if (future.length === 0) return;
    await n.LocalNotifications.schedule({
      notifications: future.map((e) => ({
        id: e.id,
        title: e.title,
        body: e.body,
        schedule: { at: e.fireAt },
        smallIcon: "ic_stat_anical",
        extra: { url: e.url },
      })),
    });
    return;
  }

  // Web fallback: setTimeout. Browsers cap timeout to ~24.8 days; we only schedule
  // notifications within the next 7 days anyway, so we're fine.
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  for (const e of future) {
    const delay = Math.max(0, e.fireAt.getTime() - Date.now());
    const handle = window.setTimeout(() => {
      try {
        const n = new Notification(e.title, {
          body: e.body,
          icon: "/icon-512.png",
          badge: "/icon-512.png",
          tag: `anical-${e.id}`,
        });
        if (e.url) n.onclick = () => window.open(e.url, "_blank");
      } catch {
        // Some browsers throw if window is unfocused / permission was revoked mid-session.
      }
      webTimers.delete(e.id);
    }, delay);
    webTimers.set(e.id, handle);
  }
}

export async function cancelAll(): Promise<void> {
  const n = await getNative();
  if (n) {
    const pending = await n.LocalNotifications.getPending();
    if (pending.notifications.length > 0) {
      await n.LocalNotifications.cancel({
        notifications: pending.notifications.map((p) => ({ id: p.id })),
      });
    }
    return;
  }
  for (const handle of webTimers.values()) window.clearTimeout(handle);
  webTimers.clear();
}

export async function testFire(title = "AniCal", body = "Notifications are working ✓"): Promise<void> {
  const n = await getNative();
  const fireAt = new Date(Date.now() + 1500);
  if (n) {
    await n.LocalNotifications.schedule({
      notifications: [{ id: 999_999, title, body, schedule: { at: fireAt } }],
    });
    return;
  }
  if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
    setTimeout(() => new Notification(title, { body, icon: "/icon-512.png" }), 1200);
  }
}
