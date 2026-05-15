import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import * as notif from "@/lib/notifications";
import type { ScheduleEntry } from "@/lib/notifications";

const IS_NATIVE = Capacitor.isNativePlatform();

// Bulletproof external URL opener.
// On Capacitor Android, `window.open(intent://..., "_system")` silently fails because the
// WebView passes the raw URI to Intent.ACTION_VIEW which doesn't know how to parse the
// intent: scheme. So we drop intent URLs entirely and use plain HTTPS — Android's
// App Links system routes the URL to the installed app automatically (Crunchyroll,
// Netflix, HIDIVE, Hulu, YouTube all register App Links for their domains).
//
// The anchor-click fallback is needed because some Capacitor versions block window.open
// when popup permission heuristics misfire. Anchor click reliably triggers Capacitor's
// onCreateWindow → startActivity(Intent.ACTION_VIEW) path.
function openUrl(url: string) {
  if (!url) return;
  try {
    const opened = window.open(url, IS_NATIVE ? "_system" : "_blank", "noopener,noreferrer");
    if (opened) return;
  } catch { /* fall through */ }
  // Anchor click fallback — most reliable in Capacitor WebViews
  try {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { try { document.body.removeChild(a); } catch {} }, 0);
  } catch { /* nothing else we can do */ }
}

// Streaming platforms — Android App Links route to the installed app if present.
type StreamingPlatform = { id: string; label: string; emoji: string; color: string };
const PLATFORMS: StreamingPlatform[] = [
  { id: "crunchyroll", label: "Crunchyroll",  emoji: "🍥", color: "#F47521" },
  { id: "netflix",     label: "Netflix",      emoji: "🎬", color: "#E50914" },
  { id: "hidive",      label: "HIDIVE",       emoji: "💎", color: "#00B4E4" },
  { id: "hulu",        label: "Hulu",         emoji: "🟢", color: "#1CE783" },
  { id: "youtube",     label: "Search YT",    emoji: "▶️", color: "#FF0000" },
];

function openStreaming(platformId: string, title: string) {
  const q = encodeURIComponent(title);
  let url = "";
  switch (platformId) {
    case "crunchyroll": url = `https://www.crunchyroll.com/search?q=${q}`; break;
    case "netflix":     url = `https://www.netflix.com/search?q=${q}`;     break;
    case "hidive":      url = `https://www.hidive.com/search?q=${q}`;      break;
    case "hulu":        url = `https://www.hulu.com/search?q=${q}`;        break;
    case "youtube":     url = `https://www.youtube.com/results?search_query=${q}+anime`; break;
    default:            url = `https://www.google.com/search?q=${q}+watch+anime`;
  }
  openUrl(url);
}

// Keep openCrunchyroll alias for compatibility — now uses the same fixed opener
function openCrunchyroll(title: string) { openStreaming("crunchyroll", title); }

async function shareAnime(anime: { title: string; mal_url?: string | null; image_url?: string | null }) {
  const url = anime.mal_url || `https://myanimelist.net/search/all?q=${encodeURIComponent(anime.title)}`;
  const text = `Check out "${anime.title}" — watching it on AniCal`;
  try {
    if (typeof navigator !== "undefined" && (navigator as any).share) {
      await (navigator as any).share({ title: anime.title, text, url });
      return true;
    }
  } catch { /* user cancelled */ }
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      return "copied";
    }
  } catch {}
  return false;
}


// ── Constants ──────────────────────────────────────────────────────────────────
const DAYS = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"] as const;
const DAY_SHORT = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const LEAD_OPTIONS = [0, 5, 10, 15, 30, 60];
const CACHE_TTL = 4 * 3600 * 1000;
const NEWS_TTL     = 30 * 60 * 1000;
const UPCOMING_TTL = 6  * 3600 * 1000;
const PULL_THRESHOLD = 70;
const COMMUNITY_TTL  = 60 * 1000; // 1 min cache for posts

// ── Supabase ───────────────────────────────────────────────────────────────────
const SB_URL  = "https://seopeujrimwxnuvcbfxx.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNlb3BldWpyaW13eG51dmNiZnh4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3NjUzNjEsImV4cCI6MjA5NDM0MTM2MX0.XT8abPOuAygiZEP7HOwbF7Mk8Z7wqC_6cw-0lZK_ClI";
const AVATAR_COLORS = ["#FF6B1A","#E91E8C","#9C27B0","#2196F3","#00BCD4","#4CAF50","#FF5722","#607D8B","#F44336","#FF9800"];

// ── Palette ────────────────────────────────────────────────────────────────────
const OR  = "#FF6B1A";
const OR2 = "rgba(255,107,26,0.13)";
const OR3 = "rgba(255,107,26,0.38)";
// These reference CSS custom properties so they respond to dark/light mode
const BG  = "var(--c-bg)";
const BG2 = "var(--c-bg2)";
const BG3 = "var(--c-bg3)";
const BG4 = "var(--c-bg4)";
const BD  = "var(--c-bd)";
const BD2 = "var(--c-bd2)";
const TX  = "var(--c-tx)";
const MT  = "var(--c-mt)";
const MT2 = "var(--c-mt2)";
const GR  = "var(--c-gr)";

// ── Types ──────────────────────────────────────────────────────────────────────
type Anime = {
  id: number;
  title: string;
  title_english?: string | null;
  image_url?: string | null;
  score?: number | null;
  episodes?: number | null;
  synopsis?: string | null;
  genres?: string[];
  broadcast_time?: string | null;
  broadcast_day?: string | null;
  studios?: string[];
  year?: number | null;
  season?: string | null;
  mal_url?: string | null;
};
type Schedule = Record<string, Anime[]>;
type BootStage = "splash" | "loading" | "ready" | "error";
type NotifSettings = { enabled: boolean; leadMinutes: number; perAnime: Record<number, boolean> };
type NewsItem = {
  id: string;
  title: string;
  date?: string;
  excerpt?: string;
  url: string;
  source: "ANN" | "MAL";
  imageUrl?: string;
  animeTitle?: string;
};
type UpcomingAnime = {
  id: number;
  title: string;
  imageUrl?: string | null;
  season?: string | null;
  year?: number | null;
  genres?: string[];
  episodes?: number | null;
  synopsis?: string | null;
  studios?: string[];
  mal_url?: string | null;
};

type CommunityPost = {
  id: string;
  anime_id: number;
  anime_title: string;
  nickname: string;
  avatar_color: string;
  message: string;
  reactions: Record<string, number>;
  created_at: string;
};

type CommunityThread = {
  anime_id: number;
  anime_title: string;
  post_count: number;
  last_post: string;
};

// Art-sharing types — Instagram-like feed inside Community
type ArtPost = {
  id: string;
  anime_id: number | null;
  anime_title: string | null;
  nickname: string;
  avatar_color: string;
  image_url: string;
  caption: string;
  likes: number;
  comment_count: number;
  status: "pending" | "approved" | "rejected" | "flagged";
  flag_count: number;
  created_at: string;
};

type ArtComment = {
  id: string;
  art_id: string;
  nickname: string;
  avatar_color: string;
  message: string;
  created_at: string;
};

const DEFAULT_NOTIF: NotifSettings = { enabled: false, leadMinutes: 10, perAnime: {} };

// ── Season helpers ─────────────────────────────────────────────────────────────
type Season = "winter" | "spring" | "summer" | "fall";
const SEASON_MONTHS: Record<Season, number> = { winter:0, spring:3, summer:6, fall:9 };
const SEASON_EMOJI:  Record<Season, string>  = { winter:"❄️", spring:"🌸", summer:"☀️", fall:"🍂" };

function monthToSeason(month: number): Season {
  if (month <= 2) return "winter";
  if (month <= 5) return "spring";
  if (month <= 8) return "summer";
  return "fall";
}

function seasonYear(season: Season, year: number): string {
  return `${season.charAt(0).toUpperCase() + season.slice(1)} ${year}`;
}

// Rough countdown to a season — uses the 1st of the start month
function seasonCountdown(season: Season, year: number): string | null {
  const startMonth = SEASON_MONTHS[season];
  const start = new Date(year, startMonth, 1);
  const now = new Date();
  const days = Math.floor((start.getTime() - now.getTime()) / 86_400_000);
  if (days < -90) return null;
  if (days < -7)  return "currently airing";
  if (days < 0)   return "just started";
  if (days === 0) return "starts today";
  if (days === 1) return "starts tomorrow";
  if (days < 14)  return `in ${days} days`;
  if (days < 60)  return `in ${Math.round(days / 7)} weeks`;
  return `in ~${Math.round(days / 30)} months`;
}


// ── Utilities ──────────────────────────────────────────────────────────────────
function getDeviceTz(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

function capitalize(s?: string | null) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }

// MAL/Jikan returns the Japanese TV broadcast time. Crunchyroll, Hidive etc.
// usually release simulcasts 30-90 minutes after. We expose a configurable
// offset (stored in LS) so users can match their preferred platform's delay.
function getStreamOffsetMin(): number {
  return LS.get<number>("anical_stream_offset_min", 0);
}

const STREAM_OFFSET_OPTIONS: { label: string; minutes: number; description: string }[] = [
  { label: "Japan TV",        minutes:  0,  description: "MAL broadcast time as-is" },
  { label: "Crunchyroll ~30", minutes: 30,  description: "Typical Crunchyroll simulcast delay" },
  { label: "Crunchyroll ~60", minutes: 60,  description: "Longer Crunchyroll delay" },
  { label: "Hidive / +90",    minutes: 90,  description: "Hidive & some others" },
  { label: "Next day",        minutes: 1440, description: "When the show drops next day in your region" },
];

function jstToLocal(jstTime?: string | null, tz?: string, offsetMin: number = getStreamOffsetMin()): string | null {
  if (!jstTime) return null;
  try {
    const [h, m] = jstTime.split(":").map(Number);
    const now = new Date();
    const utcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h - 9, m) + offsetMin * 60_000;
    const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: true };
    if (tz && tz !== "auto") opts.timeZone = tz;
    return new Date(utcMs).toLocaleTimeString([], opts);
  } catch { return null; }
}

function nextJstAiringDate(broadcastDay?: string | null, broadcastTime?: string | null, offsetMin: number = getStreamOffsetMin()): Date | null {
  if (!broadcastDay || !broadcastTime) return null;
  const dayIdx = DAYS.indexOf(broadcastDay.toLowerCase() as typeof DAYS[number]);
  if (dayIdx < 0) return null;
  const [h, m] = broadcastTime.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  const now = new Date();
  const jstNow = new Date(now.getTime() + 9 * 3600 * 1000);
  const [jY, jMo, jD] = [jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate()];
  const ourDow = (jstNow.getUTCDay() + 6) % 7;
  const diff = (dayIdx - ourDow + 7) % 7;
  let cand = new Date(Date.UTC(jY, jMo, jD + diff, h - 9, m) + offsetMin * 60_000);
  if (cand.getTime() <= now.getTime() + 60_000) cand = new Date(Date.UTC(jY, jMo, jD + diff + 7, h - 9, m) + offsetMin * 60_000);
  return cand;
}

function formatCountdown(target: Date, now = new Date()): string {
  const diff = target.getTime() - now.getTime();
  if (diff < -30 * 60_000) return "aired";
  if (diff < 0) return "airing now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "in <1m";
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60), rem = mins % 60;
  if (h < 24) return rem > 0 ? `in ${h}h ${rem}m` : `in ${h}h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "tomorrow" : `in ${d} days`;
}

function formatNewsAge(dateStr?: string): string {
  if (!dateStr) return "";
  try {
    const diffH = (Date.now() - new Date(dateStr).getTime()) / 3600_000;
    if (diffH < 1) return "just now";
    if (diffH < 24) return `${Math.floor(diffH)}h ago`;
    const days = Math.floor(diffH / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString([], { month: "short", day: "numeric" });
  } catch { return ""; }
}

async function fetchWithProxy(url: string): Promise<string> {
  const proxies = [
    `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    `https://thingproxy.freeboard.io/fetch/${url}`,
  ];
  for (const proxy of proxies) {
    try {
      const r = await fetch(proxy, { signal: AbortSignal.timeout(8000) });
      if (r.ok) return r.text();
    } catch {}
  }
  throw new Error("All proxies failed");
}

async function fetchAnnNews(): Promise<NewsItem[]> {
  const ann = "https://www.animenewsnetwork.com/news/rss.xml?ann-edition=us";
  const text = await fetchWithProxy(ann);
  const doc = new DOMParser().parseFromString(text, "text/xml");
  return Array.from(doc.querySelectorAll("item")).slice(0, 30).map((el) => {
    const raw = el.querySelector("description")?.textContent || "";
    const link = el.querySelector("link")?.textContent?.trim() || "";
    return {
      id: el.querySelector("guid")?.textContent || link || `ann-${el.querySelector("title")?.textContent?.slice(0,30)}`,
      title: el.querySelector("title")?.textContent?.trim() || "",
      date: el.querySelector("pubDate")?.textContent || undefined,
      excerpt: raw.replace(/<[^>]+>/g, "").trim().slice(0, 500) || undefined,
      url: link,
      source: "ANN" as const,
    };
  }).filter((n) => n.title && n.url);
}

async function fetchUpcoming(): Promise<UpcomingAnime[]> {
  const res = await fetch("https://api.jikan.moe/v4/seasons/upcoming?limit=25");
  if (!res.ok) return [];
  const json = await res.json();
  const seen = new Set<number>();
  return (json.data || []).flatMap((a: any) => {
    if (seen.has(a.mal_id)) return [];
    seen.add(a.mal_id);
    return [{
      id: a.mal_id,
      title: a.title_english || a.title || "Untitled",
      imageUrl: a.images?.webp?.image_url || a.images?.jpg?.image_url || null,
      season: a.season,
      year: a.year,
      genres: (a.genres || []).map((g: any) => g.name),
      episodes: a.episodes,
      synopsis: a.synopsis ? a.synopsis.slice(0, 200) : null,
      studios: (a.studios || []).map((s: any) => s.name),
      mal_url: a.url,
    }];
  });
}

async function fetchCommunityThreads(): Promise<CommunityThread[]> {
  const posts = await sbRequest<{ anime_id: number; anime_title: string; created_at: string }[]>(
    "community_posts?select=anime_id,anime_title,created_at&order=created_at.desc&limit=300"
  );
  const map: Record<number, CommunityThread> = {};
  for (const p of posts) {
    if (!map[p.anime_id]) map[p.anime_id] = { anime_id:p.anime_id, anime_title:p.anime_title, post_count:0, last_post:p.created_at };
    map[p.anime_id].post_count++;
    if (p.created_at > map[p.anime_id].last_post) map[p.anime_id].last_post = p.created_at;
  }
  return Object.values(map).sort((a, b) => b.last_post.localeCompare(a.last_post));
}

async function fetchAnimeNewsItems(anime: Anime): Promise<NewsItem[]> {
  const res = await fetch(`https://api.jikan.moe/v4/anime/${anime.id}/news?limit=4`);
  if (!res.ok) return [];
  const json = await res.json();
  return (json.data || []).map((n: any) => ({
    id: `mal-${n.mal_id}`,
    title: n.title,
    date: n.date,
    excerpt: (n.excerpt || "").replace(/<[^>]+>/g, "").slice(0, 500),
    url: n.url,
    source: "MAL" as const,
    imageUrl: n.images?.jpg?.image_url || null,
    animeTitle: anime.title,
  }));
}

async function fetchDay(day: string): Promise<Anime[]> {
  // Retry up to 3 times; on 429 (rate-limit) wait 3 s before retrying
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt === 1 ? 3000 : 6000));
    let res: Response;
    try {
      res = await fetch(`https://api.jikan.moe/v4/schedules?filter=${day}&limit=25&sfw=false`, { signal: AbortSignal.timeout(12000) });
    } catch {
      if (attempt < 2) continue; // network hiccup — retry
      return [];
    }
    if (res.status === 429) continue; // rate-limited — back off and retry
    if (!res.ok) throw new Error(`Jikan ${res.status}`);
    const json = await res.json();
    const seen = new Set<number>();
    return (json.data || []).flatMap((a: any) => {
      const id: number = a.mal_id;
      if (seen.has(id)) return [];
      seen.add(id);
      return [{
        id,
        title: a.title_english || a.title || "Untitled",
        title_english: a.title_english,
        image_url: a.images?.webp?.image_url || a.images?.jpg?.image_url || null,
        score: a.score,
        episodes: a.episodes,
        synopsis: a.synopsis ? (a.synopsis.length > 200 ? a.synopsis.slice(0, 197) + "…" : a.synopsis) : null,
        genres: (a.genres || []).map((g: any) => g.name),
        broadcast_time: a.broadcast?.time || null,
        broadcast_day: a.broadcast?.day ? a.broadcast.day.toLowerCase().replace(/s$/, "") : day,
        studios: (a.studios || []).map((s: any) => s.name),
        year: a.year,
        season: a.season,
        mal_url: a.url,
      }];
    });
  }
  return [];
}

const LS = {
  get<T>(k: string, fallback: T): T {
    if (typeof window === "undefined") return fallback;
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(k: string, v: unknown) {
    if (typeof window === "undefined") return;
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
    try {
      const cs = (window as any).chrome?.storage?.local;
      if (cs && typeof cs.set === "function") cs.set({ [k]: v });
    } catch {}
  },
};

// ── Avatar & Supabase helpers ──────────────────────────────────────────────────
function getAvatarColor(nickname: string): string {
  const hash = nickname.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

// Only allow colors from our predefined palette to prevent CSS injection from
// hand-edited records in the community DB
function safeAvatarColor(c: string | null | undefined, fallback: string = OR): string {
  if (!c) return fallback;
  return AVATAR_COLORS.includes(c) ? c : fallback;
}

function Avatar({ nickname, color, size = 36 }: { nickname: string; color: string; size?: number }) {
  return (
    <div style={{ width:size, height:size, borderRadius:"50%", background:`linear-gradient(135deg, ${color}, ${color}99)`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:size * 0.42, fontWeight:800, color:"#fff", flexShrink:0, boxShadow:`0 3px 10px ${color}44`, userSelect:"none" } as React.CSSProperties}>
      {nickname[0]?.toUpperCase() || "?"}
    </div>
  );
}

async function sbRequest<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      "apikey": SB_ANON,
      "Authorization": `Bearer ${SB_ANON}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
      ...(opts?.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`SB ${res.status}`);
  return res.json();
}

async function fetchCommunityPosts(animeId: number): Promise<CommunityPost[]> {
  return sbRequest<CommunityPost[]>(
    `community_posts?anime_id=eq.${animeId}&order=created_at.desc&limit=60`
  );
}

async function submitCommunityPost(p: { anime_id: number; anime_title: string; nickname: string; avatar_color: string; message: string }): Promise<CommunityPost> {
  const arr = await sbRequest<CommunityPost[]>("community_posts", {
    method: "POST",
    body: JSON.stringify({ ...p, reactions: { "🔥":0, "❤️":0, "😂":0, "🤯":0 } }),
  });
  return arr[0];
}

async function reactToPost(post: CommunityPost, emoji: string): Promise<void> {
  const updated = { ...post.reactions, [emoji]: (post.reactions[emoji] || 0) + 1 };
  await sbRequest(`community_posts?id=eq.${post.id}`, {
    method: "PATCH",
    body: JSON.stringify({ reactions: updated }),
  });
}

// ── Art-sharing helpers (Supabase) ─────────────────────────────────────────────
// All inserts default to status='pending' on the server (RLS-enforced) so the
// dev can moderate. The client never sees pending posts in the feed.

async function fetchArtPosts(animeId?: number, limit: number = 60): Promise<ArtPost[]> {
  const animeFilter = animeId ? `&anime_id=eq.${animeId}` : "";
  return sbRequest<ArtPost[]>(
    `community_art?status=eq.approved${animeFilter}&order=created_at.desc&limit=${limit}`
  );
}

async function submitArtPost(p: {
  anime_id: number | null;
  anime_title: string | null;
  nickname: string;
  avatar_color: string;
  image_url: string;
  storage_path: string;
  caption: string;
}): Promise<ArtPost> {
  const arr = await sbRequest<ArtPost[]>("community_art", {
    method: "POST",
    body: JSON.stringify({ ...p, likes: 0, comment_count: 0, status: "pending", flag_count: 0 }),
  });
  return arr[0];
}

async function fetchArtComments(artId: string): Promise<ArtComment[]> {
  return sbRequest<ArtComment[]>(
    `community_art_comments?art_id=eq.${artId}&order=created_at.asc&limit=200`
  );
}

async function submitArtComment(p: {
  art_id: string;
  nickname: string;
  avatar_color: string;
  message: string;
}): Promise<ArtComment> {
  const arr = await sbRequest<ArtComment[]>("community_art_comments", {
    method: "POST",
    body: JSON.stringify(p),
  });
  return arr[0];
}

async function likeArtPost(postId: string, currentLikes: number): Promise<void> {
  await sbRequest(`community_art?id=eq.${postId}`, {
    method: "PATCH",
    body: JSON.stringify({ likes: currentLikes + 1 }),
  });
}

async function flagArtPost(postId: string, currentFlags: number): Promise<void> {
  const nextFlags = currentFlags + 1;
  await sbRequest(`community_art?id=eq.${postId}`, {
    method: "PATCH",
    body: JSON.stringify({
      flag_count: nextFlags,
      // Auto-hide after 3 flags so abusive content disappears even before manual review
      status: nextFlags >= 3 ? "flagged" : "approved",
    }),
  });
}

// Client-side image compression: resize to max 1080px and re-encode to JPEG ~85.
// Keeps uploads small (~100-400KB) so Supabase Storage stays within free tier longer
// and post fetches stay snappy.
async function compressImage(file: File, maxDim: number = 1080, quality: number = 0.85): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Couldn't decode image"));
      img.onload = () => {
        const ratio = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * ratio);
        const h = Math.round(img.height * ratio);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Canvas unavailable"));
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          if (!blob) return reject(new Error("Couldn't compress image"));
          resolve(blob);
        }, "image/jpeg", quality);
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

// Upload a Blob to the public Supabase Storage bucket "art" and return the public URL.
async function uploadArtImage(blob: Blob): Promise<{ url: string; path: string }> {
  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.jpg`;
  const path = fileName;
  const res = await fetch(`${SB_URL}/storage/v1/object/art/${path}`, {
    method: "POST",
    headers: {
      "apikey": SB_ANON,
      "Authorization": `Bearer ${SB_ANON}`,
      "Content-Type": "image/jpeg",
      "x-upsert": "false",
    },
    body: blob,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Upload failed (${res.status}) ${text.slice(0, 120)}`);
  }
  const url = `${SB_URL}/storage/v1/object/public/art/${path}`;
  return { url, path };
}

// ── Global CSS ─────────────────────────────────────────────────────────────────
const GLOBAL_CSS = `
  :root{--c-bg:#09090f;--c-bg2:#111119;--c-bg3:#17171f;--c-bg4:#1d1d27;--c-bd:#252533;--c-bd2:#323244;--c-tx:#f2f2fa;--c-mt:#8585a8;--c-mt2:#484862;--c-gr:#22c55e;--c-nav:rgba(9,9,15,.92);--c-hdr:rgba(9,9,15,.82);--c-toast:rgba(17,17,25,.96)}
  :root.light{--c-bg:#f5f5f8;--c-bg2:#ffffff;--c-bg3:#ebebf0;--c-bg4:#e0e0e8;--c-bd:#d5d5e0;--c-bd2:#c0c0ce;--c-tx:#1a1a2e;--c-mt:#4a4a5e;--c-mt2:#6a6a82;--c-gr:#16a34a;--c-nav:rgba(245,245,248,.92);--c-hdr:rgba(245,245,248,.82);--c-toast:rgba(235,235,240,.98)}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  *:focus{outline:none}
  *:focus-visible{outline:2px solid ${OR};outline-offset:2px;border-radius:8px}
  ::-webkit-scrollbar{display:none}
  input::placeholder{color:${MT2}}
  body{margin:0;background:${BG}}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes orbit{from{transform:rotate(0) translateX(56px) rotate(0)}to{transform:rotate(360deg) translateX(56px) rotate(-360deg)}}
  @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
  @keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
  @keyframes barWave{0%,100%{transform:scaleY(.3)}50%{transform:scaleY(1)}}
  @keyframes fadeIn{from{opacity:0}to{opacity:1}}
  @keyframes fadeOut{from{opacity:1}to{opacity:0}}
  @keyframes sheetUp{from{transform:translate(-50%,34px);opacity:0}to{transform:translate(-50%,0);opacity:1}}
  @keyframes sheetUpScale{0%{transform:translate(-50%,42px) scale(.97);opacity:0}65%{opacity:1}100%{transform:translate(-50%,0) scale(1);opacity:1}}
  @keyframes detailEl{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
  @keyframes heroIn{0%{opacity:0;transform:scale(1.08)}100%{opacity:1;transform:scale(1)}}
  @keyframes viewIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
  @keyframes viewInFade{from{opacity:0}to{opacity:1}}
  @keyframes cardIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
  @keyframes ripple{0%{transform:scale(0);opacity:.6}80%{opacity:.15}100%{transform:scale(3);opacity:0}}
  @keyframes logoEnter{0%{transform:scale(2.2);opacity:0;filter:blur(20px)}55%{transform:scale(.92);opacity:1;filter:blur(0)}100%{transform:scale(1);opacity:1;filter:blur(0)}}
  @keyframes logoEnterRing{0%{transform:scale(2.6);opacity:0}55%{opacity:.6}100%{transform:scale(1);opacity:0}}
  @keyframes wordmark{0%{opacity:0;letter-spacing:6px}100%{opacity:1;letter-spacing:-.5px}}
  @keyframes shimmerSkel{0%{background-position:-300px 0}100%{background-position:300px 0}}
  @keyframes splashFadeOut{from{opacity:1}to{opacity:0}}
  @keyframes glowPulse{0%,100%{box-shadow:0 0 6px ${GR}}50%{box-shadow:0 0 16px ${GR}}}
  @keyframes popIn{0%{transform:scale(.82);opacity:0}70%{transform:scale(1.07)}100%{transform:scale(1);opacity:1}}
  .anical-bar{width:5px;border-radius:3px;background:linear-gradient(180deg,${OR},#ff9558);transform-origin:bottom center;animation:barWave 1.1s ease-in-out infinite}
  .anical-skel{background:linear-gradient(90deg,${BG2} 0%,${BG3} 50%,${BG2} 100%);background-size:300px 100%;animation:shimmerSkel 1.4s linear infinite}
  .anical-card:active{transform:scale(.983)}
  .anical-fade-out{animation:splashFadeOut 500ms ease-in forwards}
  .anical-favbtn:active{transform:scale(1.32)!important}
  .anical-pulse{animation:glowPulse 1.8s ease-in-out infinite}
  .anical-bottom-nav{padding-bottom:env(safe-area-inset-bottom,0px)}
  .anical-navbtn:active span{transform:scale(.88)}
`;

// ── Logo ───────────────────────────────────────────────────────────────────────
function StarLogo({ size = 26, color = OR }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" fill="none">
      <circle cx="13" cy="13" r="12" fill={color} opacity=".15"/>
      <path d="M13 3.5l2.2 6.3h6.6l-5.3 3.9 2 6.3L13 16.2l-5.5 3.8 2-6.3L4.2 9.8h6.6L13 3.5z" fill={color}/>
    </svg>
  );
}

// ── Icon library ───────────────────────────────────────────────────────────────
// Clean, crisp 24×24 SVG icons. Use Icon name="schedule" to swap in the right glyph.
type IconName =
  | "schedule" | "upcoming" | "community" | "news" | "mylist"
  | "star" | "starFilled" | "heart" | "heartFilled"
  | "search" | "close" | "back" | "chevronDown" | "chevronUp" | "chevronRight" | "chevronLeft"
  | "share" | "play" | "stop" | "bell" | "bellOff" | "eye" | "eyeOff"
  | "sun" | "moon" | "refresh" | "settings" | "clock" | "calendar"
  | "filter" | "trending" | "live" | "check" | "spoiler" | "external";

function Icon({ name, size = 22, color = "currentColor", strokeWidth = 2 }: { name: IconName; size?: number; color?: string; strokeWidth?: number }) {
  const s = size;
  const sw = strokeWidth;
  const common = { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: color, strokeWidth: sw, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    case "schedule":   // calendar with grid
      return <svg {...common}><rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 3v4M16 3v4"/><circle cx="8" cy="14" r=".8" fill={color} stroke="none"/><circle cx="12" cy="14" r=".8" fill={color} stroke="none"/><circle cx="16" cy="14" r=".8" fill={color} stroke="none"/></svg>;
    case "upcoming":   // sparkle
      return <svg {...common}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/><path d="M18.5 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z"/></svg>;
    case "community":  // bubble with dots
      return <svg {...common}><path d="M21 12a8 8 0 0 1-8 8 8.2 8.2 0 0 1-3.5-.8L4 20l1-4.5A8 8 0 1 1 21 12z"/><circle cx="9" cy="12" r="1" fill={color} stroke="none"/><circle cx="13" cy="12" r="1" fill={color} stroke="none"/><circle cx="17" cy="12" r="1" fill={color} stroke="none"/></svg>;
    case "news":       // newspaper
      return <svg {...common}><path d="M4 5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v14l-2.5-1.3L14 19l-2.5-1.3L9 19l-2.5-1.3L4 19V5z"/><path d="M8 8h7M8 12h7M8 16h4"/></svg>;
    case "mylist":     // bookmark star
      return <svg {...common}><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/><path d="M12 8l1 2.2 2.4.3-1.7 1.7.4 2.4L12 13.5l-2.1 1.1.4-2.4L8.6 10.5l2.4-.3L12 8z" fill={color}/></svg>;
    case "star":
      return <svg {...common}><path d="M12 3.5l2.4 6.3h6.6L15.7 14l2 6.3L12 16.2 6.3 20l2-6.3L3 9.8h6.6L12 3.5z"/></svg>;
    case "starFilled":
      return <svg width={s} height={s} viewBox="0 0 24 24" fill={color}><path d="M12 3.5l2.4 6.3h6.6L15.7 14l2 6.3L12 16.2 6.3 20l2-6.3L3 9.8h6.6L12 3.5z"/></svg>;
    case "heart":
      return <svg {...common}><path d="M20.8 8.6a5.4 5.4 0 0 0-9.3-3.8 5.4 5.4 0 0 0-9.3 3.8c0 4.6 5.7 8 9.3 11.2 3.6-3.2 9.3-6.6 9.3-11.2z"/></svg>;
    case "heartFilled":
      return <svg width={s} height={s} viewBox="0 0 24 24" fill={color}><path d="M20.8 8.6a5.4 5.4 0 0 0-9.3-3.8 5.4 5.4 0 0 0-9.3 3.8c0 4.6 5.7 8 9.3 11.2 3.6-3.2 9.3-6.6 9.3-11.2z"/></svg>;
    case "search":
      return <svg {...common}><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>;
    case "close":
      return <svg {...common}><path d="M6 6l12 12M18 6L6 18"/></svg>;
    case "back":
      return <svg {...common}><path d="M15 5l-7 7 7 7"/></svg>;
    case "chevronDown":
      return <svg {...common}><path d="M6 9l6 6 6-6"/></svg>;
    case "chevronUp":
      return <svg {...common}><path d="M6 15l6-6 6 6"/></svg>;
    case "chevronRight":
      return <svg {...common}><path d="M9 6l6 6-6 6"/></svg>;
    case "chevronLeft":
      return <svg {...common}><path d="M15 6l-6 6 6 6"/></svg>;
    case "share":
      return <svg {...common}><path d="M12 4v12M7 9l5-5 5 5"/><path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></svg>;
    case "play":
      return <svg width={s} height={s} viewBox="0 0 24 24" fill={color}><path d="M7 5l12 7-12 7V5z"/></svg>;
    case "stop":
      return <svg width={s} height={s} viewBox="0 0 24 24" fill={color}><rect x="6" y="6" width="12" height="12" rx="2"/></svg>;
    case "bell":
      return <svg {...common}><path d="M6 8a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7z"/><path d="M10 19a2 2 0 0 0 4 0"/></svg>;
    case "bellOff":
      return <svg {...common}><path d="M3 3l18 18M8.7 5.3A6 6 0 0 1 18 8c0 3 .6 4.9 1.2 6M6 8c0 6-2 7-2 7h13"/><path d="M10 19a2 2 0 0 0 4 0"/></svg>;
    case "eye":
      return <svg {...common}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>;
    case "eyeOff":
      return <svg {...common}><path d="M3 3l18 18M10.6 6.2A10 10 0 0 1 12 6c6.5 0 10 6 10 6s-1 1.8-2.7 3.5M6.6 6.7C3.6 8.6 2 12 2 12s3.5 7 10 7c1.2 0 2.3-.2 3.3-.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>;
    case "spoiler":
      return <svg {...common}><path d="M3 3l18 18M10.5 6.2A10 10 0 0 1 12 6c6.5 0 10 6 10 6a13 13 0 0 1-1.7 2.2M14.1 14a3 3 0 0 1-4.2-4.2"/><path d="M6 7C3.5 8.7 2 12 2 12s3.5 7 10 7a9 9 0 0 0 3.6-.8"/></svg>;
    case "sun":
      return <svg {...common}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>;
    case "moon":
      return <svg {...common}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>;
    case "refresh":
      return <svg {...common}><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 4v4h-4M21 12a9 9 0 0 1-15 6.7L3 16M3 20v-4h4"/></svg>;
    case "settings":
      return <svg {...common}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>;
    case "clock":
      return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>;
    case "calendar":
      return <svg {...common}><rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 3v4M16 3v4"/></svg>;
    case "filter":
      return <svg {...common}><path d="M3 5h18l-7 8v6l-4 2v-8L3 5z"/></svg>;
    case "trending":
      return <svg {...common}><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>;
    case "live":
      return <svg width={s} height={s} viewBox="0 0 24 24" fill={color}><circle cx="12" cy="12" r="6"/></svg>;
    case "check":
      return <svg {...common}><path d="M5 12l5 5L20 7"/></svg>;
    case "external":
      return <svg {...common}><path d="M14 4h6v6M20 4l-9 9M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/></svg>;
    default:
      return null;
  }
}

// ── Splash ─────────────────────────────────────────────────────────────────────
function Splash({ fadingOut }: { fadingOut: boolean }) {
  return (
    <div
      className={fadingOut ? "anical-fade-out" : ""}
      style={{ position:"fixed", inset:0, zIndex:9999, background:BG, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", overflow:"hidden" }}
    >
      <div style={{ position:"absolute", inset:0, background:`radial-gradient(circle at 50% 42%, rgba(255,107,26,.22), transparent 58%)`, pointerEvents:"none" }}/>
      <div style={{ position:"relative", width:160, height:160, display:"flex", alignItems:"center", justifyContent:"center" }}>
        {[0, .3, .6].map((d) => (
          <div key={d} style={{ position:"absolute", inset:20, borderRadius:"50%", border:`2px solid ${OR3}`, animation:`ripple 2.2s ${d}s ease-out infinite` }}/>
        ))}
        <div style={{ position:"absolute", inset:0, borderRadius:"50%", border:`2px solid ${OR}`, animation:"logoEnterRing 1.1s cubic-bezier(.2,.7,.2,1) both" }}/>
        <div style={{ width:96, height:96, borderRadius:"50%", background:`radial-gradient(circle, ${OR} 0%, #b84c0f 100%)`, boxShadow:`0 0 48px ${OR3}, 0 0 96px rgba(255,107,26,.12)`, display:"flex", alignItems:"center", justifyContent:"center", animation:"logoEnter 1.1s cubic-bezier(.2,.8,.2,1) both" }}>
          <svg width="52" height="52" viewBox="0 0 26 26" fill="none">
            <path d="M13 3.5l2.2 6.3h6.6l-5.3 3.9 2 6.3L13 16.2l-5.5 3.8 2-6.3L4.2 9.8h6.6L13 3.5z" fill="#fff"/>
          </svg>
        </div>
      </div>
      <div style={{ marginTop:32, fontSize:30, fontWeight:800, letterSpacing:"-.5px", color:TX, animation:"wordmark .9s .35s cubic-bezier(.2,.7,.2,1) both" }}>
        Ani<span style={{ color:OR }}>Cal</span>
      </div>
      <div style={{ marginTop:8, fontSize:11, color:MT, letterSpacing:"3px", textTransform:"uppercase", animation:"fadeIn .5s .8s both" }}>
        Anime, on your time
      </div>
    </div>
  );
}

// ── Skeleton ───────────────────────────────────────────────────────────────────
function SkeletonCard({ delay = 0 }: { delay?: number }) {
  return (
    <div style={{ display:"flex", gap:12, padding:12, background:BG2, border:`1px solid ${BD}`, borderRadius:14, marginBottom:8, opacity:0, animation:`cardIn .5s ${delay}ms cubic-bezier(.2,.7,.2,1) both` }}>
      <div className="anical-skel" style={{ width:72, height:100, borderRadius:8, flexShrink:0 }}/>
      <div style={{ flex:1, display:"flex", flexDirection:"column", gap:7, justifyContent:"center" }}>
        <div className="anical-skel" style={{ height:14, borderRadius:4, width:"78%" }}/>
        <div className="anical-skel" style={{ height:10, borderRadius:4, width:"50%" }}/>
        <div className="anical-skel" style={{ height:10, borderRadius:4, width:"32%" }}/>
      </div>
    </div>
  );
}

// ── Loading view ───────────────────────────────────────────────────────────────
function LoadingView({ progress, msg }: { progress: number; msg: string }) {
  return (
    <div style={{ minHeight:"100vh", paddingBottom:60, background:BG }}>
      <div style={{ padding:"18px 16px 0", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:40, height:40, borderRadius:"50%", background:`radial-gradient(circle, ${OR}, #b84c0f)`, display:"flex", alignItems:"center", justifyContent:"center", boxShadow:`0 0 28px ${OR3}`, animation:"float 3.5s ease-in-out infinite" }}>
            <svg width="22" height="22" viewBox="0 0 26 26"><path d="M13 3.5l2.2 6.3h6.6l-5.3 3.9 2 6.3L13 16.2l-5.5 3.8 2-6.3L4.2 9.8h6.6L13 3.5z" fill="#fff"/></svg>
          </div>
          <div>
            <div style={{ fontSize:20, fontWeight:800, letterSpacing:"-.5px" }}>Ani<span style={{ color:OR }}>Cal</span></div>
            <div style={{ fontSize:11, color:MT, marginTop:2 }}>{msg}</div>
          </div>
        </div>
        <div style={{ fontSize:11, color:MT2, fontWeight:700 }}>{progress}%</div>
      </div>
      <div style={{ height:3, background:BG3, marginTop:16, position:"relative", overflow:"hidden" }}>
        <div style={{ position:"absolute", inset:0, width:`${progress}%`, background:`linear-gradient(90deg, ${OR}, #ff9558, ${OR})`, backgroundSize:"200% 100%", animation:"shimmer 2s linear infinite", transition:"width .4s cubic-bezier(.4,0,.2,1)", boxShadow:`0 0 14px ${OR3}` }}/>
      </div>
      <div style={{ display:"flex", gap:6, padding:"14px 16px", overflowX:"hidden" }}>
        {DAYS.map((d, i) => {
          const done = (progress / 100) * DAYS.length > i;
          return (
            <div key={d} style={{ flexShrink:0, minWidth:54, height:62, borderRadius:10, border:`1px solid ${done ? OR3 : BD}`, background: done ? OR2 : BG2, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:2, padding:"6px 10px", transition:"all .35s", animation:`cardIn .3s ${i * 40}ms both` }}>
              <div style={{ fontSize:10, fontWeight:700, letterSpacing:".8px", color: done ? OR : MT2 }}>{DAY_SHORT[i]}</div>
              {done
                ? <div style={{ fontSize:16, fontWeight:800, color:OR }}>✓</div>
                : <div className="anical-skel" style={{ height:14, width:24, borderRadius:4 }}/>}
            </div>
          );
        })}
      </div>
      <div style={{ padding:"0 16px" }}>
        <div style={{ display:"flex", alignItems:"center", gap:8, padding:"12px 0 6px" }}>
          <div className="anical-skel" style={{ height:12, width:90, borderRadius:4 }}/>
          <div style={{ flex:1, height:1, background:BD }}/>
        </div>
        {[0,1,2,3,4].map((i) => <SkeletonCard key={i} delay={120 + i * 60}/>)}
      </div>
    </div>
  );
}

// ── Anime card ─────────────────────────────────────────────────────────────────
function AnimeCard({ anime, favorites, onOpen, onToggleFav, tz, animDelay = 0, tick = 0 }: {
  anime: Anime;
  favorites: number[];
  onOpen: (a: Anime) => void;
  onToggleFav: (id: number) => void;
  tz: string;
  animDelay?: number;
  tick?: number;
}) {
  void tick; // reading tick forces a re-render every 30 s so the countdown stays fresh
  const isFav = favorites.includes(anime.id);
  const [imgFailed, setImgFailed] = useState(false);
  const now = new Date();
  const nextDate = nextJstAiringDate(anime.broadcast_day, anime.broadcast_time);
  const countdown = nextDate ? formatCountdown(nextDate, now) : null;
  const diffMs = nextDate ? nextDate.getTime() - now.getTime() : null;
  const isLive = diffMs !== null && diffMs < 0 && diffMs > -30 * 60_000;
  const isSoon = diffMs !== null && diffMs > 0 && diffMs < 3600_000;
  const localTime = jstToLocal(anime.broadcast_time, tz);

  const borderColor = isFav ? OR3 : isLive ? "rgba(34,197,94,.45)" : BD;
  const cardBg = isFav ? `rgba(255,107,26,.06)` : isLive ? "rgba(34,197,94,.05)" : BG2;

  return (
    <div
      className="anical-card"
      style={{
        background: cardBg,
        border:`1px solid ${borderColor}`,
        borderRadius:14, display:"flex", gap:12, padding:12, marginBottom:8,
        cursor:"pointer", position:"relative", overflow:"hidden",
        transition:"transform .15s, box-shadow .2s",
        animation:`cardIn .4s ${animDelay}ms cubic-bezier(.2,.7,.2,1) both`,
        boxShadow: isFav ? `0 4px 20px -6px ${OR3}` : "none",
      }}
      onClick={() => onOpen(anime)}
    >
      {isLive && <div className="anical-pulse" style={{ position:"absolute", top:10, right:40, width:7, height:7, borderRadius:"50%", background:GR }}/>}
      <div style={{ position:"relative", flexShrink:0, width:72, height:100, borderRadius:8, overflow:"hidden", background:BG4 }}>
        {anime.image_url && !imgFailed
          ? <img src={anime.image_url} alt={anime.title} loading="lazy" decoding="async" style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }} onError={() => setImgFailed(true)}/>
          : <div style={{ width:"100%", height:"100%", display:"flex", alignItems:"center", justifyContent:"center", fontSize:26, color:MT2 }}>🎬</div>}
        <div style={{ position:"absolute", inset:0, background:"linear-gradient(180deg, transparent 45%, rgba(0,0,0,.72))" }}/>
        {anime.score && <div style={{ position:"absolute", bottom:4, left:0, right:0, textAlign:"center", fontSize:10, fontWeight:800, color:"#fff", textShadow:"0 1px 4px rgba(0,0,0,.9)" }}>★ {anime.score}</div>}
      </div>
      <div style={{ flex:1, minWidth:0, display:"flex", flexDirection:"column", gap:4, justifyContent:"center" }}>
        <div style={{ fontSize:15, fontWeight:700, lineHeight:1.3, color:TX, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" as const }}>{anime.title}</div>
        <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" as const }}>
          {anime.episodes && <span style={{ fontSize:11, color:MT, background:BG4, padding:"2px 7px", borderRadius:6, fontWeight:600 }}>{anime.episodes} eps</span>}
          {anime.genres?.[0] && <span style={{ fontSize:10, color:MT, background:BG3, padding:"2px 7px", borderRadius:99 }}>{anime.genres[0]}</span>}
        </div>
        {anime.broadcast_time && (
          <div style={{ fontSize:11, color:MT2, display:"flex", alignItems:"center", gap:4, marginTop:1 }}>
            <span>{anime.broadcast_time} JP</span>
            {localTime && <><span style={{ opacity:.4 }}>·</span><span style={{ color:OR, fontWeight:600 }}>{localTime}</span></>}
          </div>
        )}
        {countdown && (
          <div style={{ display:"inline-flex", alignItems:"center", gap:5, marginTop:2 }}>
            <span style={{
              fontSize:11, fontWeight:800, padding:"3px 9px", borderRadius:99,
              background: isLive ? "rgba(34,197,94,.15)" : isSoon ? OR2 : BG3,
              color: isLive ? GR : isSoon ? OR : MT,
              border:`1px solid ${isLive ? "rgba(34,197,94,.3)" : isSoon ? OR3 : BD}`,
              letterSpacing:".2px",
            }}>
              {isLive ? "● LIVE NOW" : countdown}
            </span>
          </div>
        )}
      </div>
      <button
        className="anical-favbtn"
        style={{ flexShrink:0, alignSelf:"flex-start", background:"none", border:"none", cursor:"pointer", fontSize:22, padding:"2px 4px", lineHeight:1, color: isFav ? OR : MT2, fontFamily:"inherit", transition:"color .15s" }}
        onClick={(e) => { e.stopPropagation(); onToggleFav(anime.id); }}
      >
        {isFav ? "★" : "☆"}
      </button>
    </div>
  );
}

// ── Hero cover ─────────────────────────────────────────────────────────────────
// Trailers used to embed an autoplay YouTube iframe but users found that too noisy.
// Now we just show the cover image. If the anime has a known YouTube trailer
// (current/recent season only), we expose a "Watch trailer on YouTube" link via
// useAnimeTrailer that the parent surfaces as a button.
function HeroCover({ imageUrl }: { imageUrl?: string | null }) {
  if (!imageUrl) return null;
  return (
    <div style={{ position:"relative", width:"100%", height:220, borderRadius:14, marginBottom:16, overflow:"hidden", background:BG4 }}>
      <img
        src={imageUrl}
        alt="Cover art"
        loading="lazy"
        decoding="async"
        style={{ width:"100%", height:"100%", objectFit:"cover", objectPosition:"top", display:"block", animation:"heroIn .5s cubic-bezier(.2,.7,.2,1) both" } as React.CSSProperties}
      />
      {/* Subtle vignette to anchor the title underneath */}
      <div style={{ position:"absolute", inset:0, background:"linear-gradient(180deg, transparent 60%, rgba(0,0,0,.18))", pointerEvents:"none" }}/>
    </div>
  );
}

// Hook: fetches Jikan trailer YouTube ID + full synopsis for the anime on demand.
// Single request serves both pieces of data. Trailer is suppressed for older anime
// or when noSpoiler is on; synopsis is always fetched (it's not a spoiler).
type AnimeExtras = { trailerYtId: string | null; fullSynopsis: string | null; loading: boolean };
function useAnimeTrailer(animeId: number, noSpoiler: boolean): AnimeExtras {
  const [extras, setExtras] = useState<AnimeExtras>({ trailerYtId: null, fullSynopsis: null, loading: true });
  useEffect(() => {
    if (!animeId) { setExtras({ trailerYtId: null, fullSynopsis: null, loading: false }); return; }
    let cancelled = false;
    fetch(`https://api.jikan.moe/v4/anime/${animeId}`, { signal: AbortSignal.timeout(8000) })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const fullSynopsis: string | null = j.data?.synopsis ?? null;
        let trailerYtId: string | null = null;
        if (!noSpoiler) {
          const currentYear = new Date().getFullYear();
          const isRelevant =
            j.data?.airing === true ||
            (j.data?.year != null && j.data.year >= currentYear - 1);
          if (isRelevant) {
            trailerYtId =
              j.data?.trailer?.youtube_id ||
              j.data?.trailer?.embed_url?.match(/embed\/([^?&]+)/)?.[1] ||
              null;
          }
        }
        setExtras({ trailerYtId, fullSynopsis, loading: false });
      })
      .catch(() => { if (!cancelled) setExtras((s) => ({ ...s, loading: false })); });
    return () => { cancelled = true; };
  }, [animeId, noSpoiler]);
  return extras;
}

// Hook: fetches Jikan news for an anime. Used in the detail sheet to surface
// "Latest news" without the user having to jump to the News tab.
function useAnimeNews(anime: { id: number; title: string } | null): { news: NewsItem[]; loading: boolean } {
  const [state, setState] = useState<{ news: NewsItem[]; loading: boolean }>({ news: [], loading: true });
  const id = anime?.id;
  useEffect(() => {
    if (!id || !anime) { setState({ news: [], loading: false }); return; }
    let cancelled = false;
    const cacheKey = `anical_news_${id}`;
    const cached = LS.get<{ ts: number; data: NewsItem[] } | null>(cacheKey, null);
    if (cached && Date.now() - cached.ts < NEWS_TTL) {
      setState({ news: cached.data, loading: false });
      return;
    }
    fetchAnimeNewsItems(anime as Anime)
      .then((items) => {
        if (cancelled) return;
        setState({ news: items, loading: false });
        LS.set(cacheKey, { ts: Date.now(), data: items });
      })
      .catch(() => { if (!cancelled) setState({ news: [], loading: false }); });
    return () => { cancelled = true; };
  }, [id, anime]);
  return state;
}

// ── Synopsis block (expandable) ────────────────────────────────────────────────
// Full synopses can be quite long. Show the first ~280 chars by default and
// reveal the rest on tap so the detail sheet doesn't become a wall of text.
function SynopsisBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const COLLAPSED_CHARS = 280;
  const needsTruncation = text.length > COLLAPSED_CHARS + 40;
  const display = expanded || !needsTruncation ? text : text.slice(0, COLLAPSED_CHARS).trimEnd() + "…";
  return (
    <div style={{ marginBottom:16 }}>
      <div style={{ fontSize:11, fontWeight:800, color:MT2, letterSpacing:".8px", textTransform:"uppercase" as const, marginBottom:6 }}>About</div>
      <p style={{ fontSize:13.5, lineHeight:1.7, color:TX, opacity:.85, margin:0, whiteSpace:"pre-wrap" as const, letterSpacing:".05px" }}>{display}</p>
      {needsTruncation && (
        <button
          onClick={() => { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); setExpanded((v) => !v); }}
          style={{ marginTop:8, padding:0, background:"none", border:"none", color:OR, fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"inherit", display:"inline-flex", alignItems:"center", gap:4 }}
        >
          <span>{expanded ? "Show less" : "Read more"}</span>
          <Icon name={expanded ? "chevronUp" : "chevronDown"} size={12} color={OR}/>
        </button>
      )}
    </div>
  );
}

// ── Anime news section (inside detail sheet) ──────────────────────────────────
// Shows up to 3 recent news items for the anime. Tapping a row opens the article
// externally. Keeps the user engaged without bouncing them out of the detail flow.
function AnimeNewsSection({ anime, news, loading }: { anime: Anime; news: NewsItem[]; loading: boolean }) {
  // Hide the whole section if we're done loading and have nothing useful
  if (!loading && news.length === 0) return null;
  const visible = news.slice(0, 3);
  return (
    <div style={{ marginBottom:18 }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10, fontSize:11, fontWeight:800, color:MT2, letterSpacing:".8px", textTransform:"uppercase" as const }}>
        <Icon name="news" size={13} color={MT2} strokeWidth={2.1}/>
        <span>Latest News</span>
        {!loading && <span style={{ fontSize:10, padding:"1px 7px", borderRadius:99, background:BG3, border:`1px solid ${BD}`, color:MT }}>{news.length}</span>}
        <div style={{ flex:1, height:1, background:BD }}/>
      </div>
      {loading ? (
        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
          {[0,1].map((i) => (
            <div key={i} style={{ display:"flex", gap:10, padding:10, background:BG3, border:`1px solid ${BD}`, borderRadius:12 }}>
              <div className="anical-skel" style={{ width:56, height:56, borderRadius:8, flexShrink:0 }}/>
              <div style={{ flex:1, display:"flex", flexDirection:"column", gap:6, justifyContent:"center" }}>
                <div className="anical-skel" style={{ height:11, borderRadius:4, width:"85%" }}/>
                <div className="anical-skel" style={{ height:9, borderRadius:4, width:"50%" }}/>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {visible.map((n, i) => {
              const age = formatNewsAge(n.date);
              return (
                <button
                  key={n.id}
                  aria-label={`Read: ${n.title}`}
                  onClick={() => { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); openUrl(n.url); }}
                  style={{
                    display:"flex", alignItems:"center", gap:10, padding:10,
                    background:BG3, border:`1px solid ${BD}`, borderRadius:12,
                    cursor:"pointer", textAlign:"left" as const, fontFamily:"inherit", color:TX,
                    animation:`cardIn .35s ${i*40}ms cubic-bezier(.2,.7,.2,1) both`,
                    transition:"transform .12s, border-color .2s",
                  } as React.CSSProperties}
                >
                  {n.imageUrl ? (
                    <img src={n.imageUrl} alt="" loading="lazy" decoding="async"
                      style={{ width:56, height:56, borderRadius:8, objectFit:"cover", flexShrink:0, background:BG4 } as React.CSSProperties}/>
                  ) : (
                    <div style={{ width:56, height:56, borderRadius:8, background:BG4, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, color:MT2 }}>
                      <Icon name="news" size={22} color={MT2}/>
                    </div>
                  )}
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:12.5, fontWeight:700, color:TX, lineHeight:1.35, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" as const, marginBottom:3 }}>{n.title}</div>
                    <div style={{ fontSize:10.5, color:MT2, display:"inline-flex", alignItems:"center", gap:5 }}>
                      <span style={{ fontSize:8.5, fontWeight:800, padding:"1px 5px", borderRadius:3, background:OR2, color:OR, border:`1px solid ${OR3}`, textTransform:"uppercase" as const, letterSpacing:".4px" }}>{n.source}</span>
                      {age && <span>· {age}</span>}
                    </div>
                  </div>
                  <Icon name="chevronRight" size={14} color={MT2}/>
                </button>
              );
            })}
          </div>
          {news.length > 3 && (
            <button
              onClick={() => openUrl(`https://myanimelist.net/anime/${anime.id}/news`)}
              style={{ marginTop:8, padding:"7px 0", background:"none", border:"none", color:MT, fontSize:11.5, fontWeight:700, cursor:"pointer", fontFamily:"inherit", display:"inline-flex", alignItems:"center", gap:4 }}
            >
              <span>View all {news.length} articles on MAL</span>
              <Icon name="external" size={11} color={MT}/>
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ── Detail sheet ───────────────────────────────────────────────────────────────
function DetailSheet({ anime, favorites, onClose, onToggleFav, onOpenCommunity, noSpoiler, tz, onToast }: { anime: Anime | null; favorites: number[]; onClose: () => void; onToggleFav: (id: number) => void; onOpenCommunity: (a: Anime) => void; noSpoiler: boolean; tz: string; onToast: (m: string) => void }) {
  // Hooks must run unconditionally — provide a safe fallback id
  const { trailerYtId, fullSynopsis } = useAnimeTrailer(anime?.id ?? 0, noSpoiler);
  const { news: animeNews, loading: newsLoading } = useAnimeNews(anime);
  if (!anime) return null;
  const isFav = favorites.includes(anime.id);
  const localTime = jstToLocal(anime.broadcast_time, tz);
  // Prefer the full synopsis fetched from /anime/{id}; fall back to the truncated one
  const displaySynopsis = fullSynopsis || anime.synopsis || "No synopsis available.";
  const handleShare = async () => {
    Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
    const r = await shareAnime(anime);
    if (r === "copied") onToast("Link copied to clipboard ✓");
    else if (r === false) onToast("Sharing not available");
  };
  return (
    <>
      <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.82)", zIndex:200, animation:"fadeIn .25s ease-out", backdropFilter:"blur(6px)" } as React.CSSProperties} onClick={onClose}/>
      <div role="dialog" aria-modal="true" aria-label={anime.title}
        style={{ position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)", width:"100%", maxWidth:480, background:BG2, borderRadius:"22px 22px 0 0", border:`1px solid ${BD}`, borderBottom:"none", maxHeight:"88vh", overflowY:"auto", zIndex:201, animation:"sheetUpScale .42s cubic-bezier(.2,.85,.2,1) both", willChange:"transform, opacity" } as React.CSSProperties}>
        <div style={{ width:40, height:4, background:BD2, borderRadius:2, margin:"14px auto 0" }}/>
        <div style={{ padding:"16px 20px 48px" }}>
          <div style={{ animation:"detailEl .45s 0ms cubic-bezier(.2,.7,.2,1) both" } as React.CSSProperties}>
            <HeroCover imageUrl={anime.image_url}/>
          </div>
          <div style={{ animation:"detailEl .42s 60ms cubic-bezier(.2,.7,.2,1) both", fontSize:21, fontWeight:800, lineHeight:1.2, marginBottom:8 } as React.CSSProperties}>{anime.title}</div>
          <div style={{ animation:"detailEl .42s 110ms cubic-bezier(.2,.7,.2,1) both", display:"flex", gap:8, flexWrap:"wrap", marginBottom:12 } as React.CSSProperties}>
            {anime.score && <span style={{ fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:6, background:OR2, color:OR, border:`1px solid ${OR3}` }}>★ {anime.score}</span>}
            {anime.year && <span style={{ fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:6, background:BG4, color:MT, border:`1px solid ${BD}` }}>{anime.year}</span>}
            {anime.season && <span style={{ fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:6, background:BG4, color:MT, border:`1px solid ${BD}` }}>{capitalize(anime.season)}</span>}
            {anime.episodes && <span style={{ fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:6, background:BG4, color:MT, border:`1px solid ${BD}` }}>{anime.episodes} eps</span>}
            {anime.genres?.slice(0, 3).map((g) => <span key={g} style={{ fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:6, background:BG4, color:MT, border:`1px solid ${BD}` }}>{g}</span>)}
          </div>
          {anime.broadcast_time && (
            <div style={{ background:BG3, border:`1px solid ${BD}`, borderRadius:10, padding:"12px 14px", marginBottom:12 }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
                <div style={{ fontSize:11, fontWeight:700, color:MT, textTransform:"uppercase", letterSpacing:".6px", display:"inline-flex", alignItems:"center", gap:5 }}>
                  <Icon name="clock" size={12} color={MT}/>
                  <span>Airing Time</span>
                </div>
                {getStreamOffsetMin() > 0 && (
                  <span style={{ fontSize:9.5, fontWeight:800, padding:"2px 7px", borderRadius:99, background:OR2, color:OR, border:`1px solid ${OR3}`, letterSpacing:".3px" }}>+{getStreamOffsetMin()}m offset</span>
                )}
              </div>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}><div style={{ fontSize:16, fontWeight:700 }}>{anime.broadcast_time}</div><div style={{ fontSize:10, color:MT }}>Japan TV</div></div>
                <div style={{ color:MT, fontSize:22 }}>→</div>
                <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}><div style={{ fontSize:16, fontWeight:700, color:OR }}>{localTime || "—"}</div><div style={{ fontSize:10, color:MT }}>Your time</div></div>
                <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}><div style={{ fontSize:14, fontWeight:700 }}>{capitalize(anime.broadcast_day || "")}</div><div style={{ fontSize:10, color:MT }}>Day</div></div>
              </div>
              {getStreamOffsetMin() === 0 && (
                <div style={{ marginTop:8, fontSize:10.5, color:MT2, lineHeight:1.5, paddingTop:8, borderTop:`1px dashed ${BD}` }}>
                  Times shown are the Japanese TV broadcast. Crunchyroll & other simulcasts usually publish 30–60 min later — adjust in <strong style={{ color:OR, fontWeight:700 }}>Settings → Streaming offset</strong>.
                </div>
              )}
            </div>
          )}
          {/* Synopsis — uses the FULL synopsis fetched from /anime/{id} when available,
              falls back to the truncated one stored in the schedule cache. */}
          <SynopsisBlock text={displaySynopsis}/>

          {/* Latest news for this anime — pulled from Jikan; only shown when we have results */}
          <AnimeNewsSection anime={anime} news={animeNews} loading={newsLoading}/>

          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            <div style={{ display:"flex", gap:8 }}>
              <button aria-label={isFav ? "Remove from favorites" : "Add to favorites"} style={{ flex:1, padding:12, borderRadius:10, border:`1px solid ${isFav ? OR : BD}`, background: isFav ? OR2 : BG3, color: isFav ? OR : MT, fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }} onClick={() => onToggleFav(anime.id)}>
                {isFav ? "★ Favorited" : "☆ Favorite"}
              </button>
              <button
                aria-label="Open community discussion"
                style={{ flex:1, padding:12, borderRadius:10, border:`1px solid ${BD}`, background:BG3, color:MT, fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center", gap:5 }}
                onClick={() => { onClose(); setTimeout(() => onOpenCommunity(anime), 120); }}
              >
                <span>💬</span><span>Community</span>
              </button>
              <button
                aria-label="Share anime"
                style={{ flexShrink:0, padding:"12px 14px", borderRadius:10, border:`1px solid ${BD}`, background:BG3, color:MT, fontSize:15, cursor:"pointer", fontFamily:"inherit" }}
                onClick={handleShare}
              >
                ↗
              </button>
            </div>

            {/* Streaming platforms — try the app first, fallback to web */}
            <div style={{ fontSize:10, fontWeight:800, color:MT, letterSpacing:".8px", textTransform:"uppercase", marginTop:6, marginBottom:2 }}>Where to watch</div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(2,1fr)", gap:6 }}>
              {PLATFORMS.slice(0, 4).map((p) => (
                <button
                  key={p.id}
                  aria-label={`Open ${p.label}`}
                  onClick={() => { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); openStreaming(p.id, anime.title); }}
                  style={{
                    padding:"11px 12px", borderRadius:10, border:`1px solid ${BD}`, background:BG3, color:TX,
                    fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"inherit",
                    display:"flex", alignItems:"center", justifyContent:"center", gap:6,
                    transition:"transform .12s",
                  }}
                >
                  <span style={{ fontSize:14 }}>{p.emoji}</span>
                  <span style={{ color:p.color }}>{p.label}</span>
                </button>
              ))}
            </div>
            {/* Trailer link — only shown when Jikan returns a current/recent trailer */}
            {trailerYtId && !noSpoiler && (
              <button
                aria-label="Watch official trailer on YouTube"
                onClick={() => { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); openUrl(`https://www.youtube.com/watch?v=${trailerYtId}`); }}
                style={{ width:"100%", padding:"11px 14px", borderRadius:10, border:"1px solid rgba(220,0,0,.5)", background:"linear-gradient(135deg, rgba(220,0,0,.18), rgba(220,0,0,.08))", color:"#fff", fontSize:13, fontWeight:800, cursor:"pointer", fontFamily:"inherit", marginTop:2, display:"flex", alignItems:"center", justifyContent:"center", gap:7 } as React.CSSProperties}
              >
                <Icon name="play" size={14} color="#ff6b6b"/>
                <span>Watch trailer on YouTube</span>
              </button>
            )}
            <button
              aria-label="Search this title on YouTube"
              onClick={() => { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); openStreaming("youtube", anime.title); }}
              style={{ width:"100%", padding:10, borderRadius:10, border:`1px solid ${BD}`, background:BG3, color:MT, fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"inherit", marginTop:2, display:"flex", alignItems:"center", justifyContent:"center", gap:6 }}
            >
              <Icon name="external" size={12} color={MT}/>
              <span>More on YouTube</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Community sheet (Reddit-style) ────────────────────────────────────────────
const REACTION_EMOJIS = ["🔥","❤️","😂","🤯"];
const NICK_SUGGESTIONS = ["OtakuPrime","AnimeGuru","WaifuHunter","SenpaiVibes","MangaHead","NarutoBro","ShinjiPilot","GarouFan","ZeroTwo","ReiAya"];
type SortMode = "hot" | "new" | "top";

function hotScore(post: CommunityPost): number {
  const votes = post.reactions["▲"] || 0;
  const awards = REACTION_EMOJIS.reduce((a, e) => a + (post.reactions[e] || 0), 0);
  const ageH = (Date.now() - new Date(post.created_at).getTime()) / 3_600_000;
  return votes * 3 + awards * 1.5 - Math.max(0, Math.log(ageH + 1) * 1.8);
}

function sortPosts(posts: CommunityPost[], mode: SortMode): CommunityPost[] {
  const copy = [...posts];
  if (mode === "hot") return copy.sort((a, b) => hotScore(b) - hotScore(a));
  if (mode === "top") return copy.sort((a, b) => {
    const sa = Object.values(a.reactions).reduce((x,y)=>x+y,0);
    const sb = Object.values(b.reactions).reduce((x,y)=>x+y,0);
    return sb - sa; // descending: highest reactions first
  });
  return copy; // "new" — already ordered by created_at desc from API
}

function CommunitySheet({ anime, onClose }: { anime: Anime; onClose: () => void }) {
  const [posts, setPosts] = useState<CommunityPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [composing, setComposing] = useState(false);
  const [sending, setSending] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("hot");
  const [nickname, setNickname] = useState<string>(() => LS.get<string>("anical_nickname", ""));
  const [nickDraft, setNickDraft] = useState("");
  const [pickingNick, setPickingNick] = useState(!LS.get<string>("anical_nickname", ""));
  const [reactedMap, setReactedMap] = useState<Record<string, string>>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const avatarColor = nickname ? getAvatarColor(nickname) : OR;

  const load = useCallback(async () => {
    try { const p = await fetchCommunityPosts(anime.id); setPosts(p); }
    catch {} finally { setLoading(false); }
  }, [anime.id]);

  useEffect(() => { load(); const id = setInterval(load, COMMUNITY_TTL); return () => clearInterval(id); }, [load]);

  const confirmNick = () => {
    const n = nickDraft.trim();
    if (n.length < 2) return;
    setNickname(n); LS.set("anical_nickname", n); setPickingNick(false);
  };

  const handleSend = async () => {
    if (!draft.trim() || !nickname || sending) return;
    setSending(true);
    try {
      const post = await submitCommunityPost({ anime_id:anime.id, anime_title:anime.title, nickname, avatar_color:avatarColor, message:draft.trim() });
      setPosts(p => [post, ...p]);
      setDraft(""); setComposing(false);
      Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
    } catch {} finally { setSending(false); }
  };

  const handleVote = async (post: CommunityPost) => {
    const key = `${post.id}_▲`;
    if (reactedMap[key]) return;
    setReactedMap(m => ({ ...m, [key]: "1" }));
    setPosts(ps => ps.map(p => p.id === post.id ? { ...p, reactions: { ...p.reactions, "▲": (p.reactions["▲"] || 0) + 1 } } : p));
    Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
    try { await reactToPost(post, "▲"); } catch {}
  };

  const handleReact = async (post: CommunityPost, emoji: string) => {
    const key = `${post.id}_${emoji}`;
    if (reactedMap[key]) return;
    setReactedMap(m => ({ ...m, [key]: "1" }));
    setPosts(ps => ps.map(p => p.id === post.id ? { ...p, reactions: { ...p.reactions, [emoji]: (p.reactions[emoji] || 0) + 1 } } : p));
    Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
    try { await reactToPost(post, emoji); } catch {}
  };

  const sorted = sortPosts(posts, sortMode);
  const totalVotes = posts.reduce((s, p) => s + (p.reactions["▲"] || 0), 0);
  const uniquePosters = new Set(posts.map(p => p.nickname)).size;

  return (
    <>
      <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.88)", zIndex:300, backdropFilter:"blur(10px)" } as React.CSSProperties} onClick={onClose}/>
      <div style={{ position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)", width:"100%", maxWidth:480, background:BG2, borderRadius:"22px 22px 0 0", border:`1px solid rgba(255,255,255,0.07)`, borderBottom:"none", height:"91vh", display:"flex", flexDirection:"column", zIndex:301, animation:"sheetUp .3s cubic-bezier(.2,.7,.2,1)" } as React.CSSProperties}>

        {/* ── Drag handle ── */}
        <div style={{ width:36, height:4, background:"rgba(255,255,255,0.18)", borderRadius:2, margin:"12px auto 0", flexShrink:0 }}/>

        {/* ── Subreddit-style header ── */}
        <div style={{ flexShrink:0 }}>
          {/* Banner */}
          <div style={{ height:54, background:`linear-gradient(135deg, #1a0a2e, #0f0a1e, #0a1628)`, position:"relative", overflow:"hidden" }}>
            {anime.image_url && <img src={anime.image_url} alt="" style={{ width:"100%", height:"100%", objectFit:"cover", opacity:.18, filter:"blur(4px)", transform:"scale(1.08)" }}/>}
            <div style={{ position:"absolute", inset:0, background:"linear-gradient(to bottom, transparent 40%, rgba(17,17,25,.9))" }}/>
          </div>
          {/* Community info row */}
          <div style={{ display:"flex", alignItems:"flex-end", gap:12, padding:"0 16px 12px", marginTop:-20, position:"relative" }}>
            {/* Icon */}
            <div style={{ width:52, height:52, borderRadius:14, background:`linear-gradient(135deg, #7c3aed, #4f46e5)`, border:`3px solid ${BG2}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:24, flexShrink:0, boxShadow:`0 4px 16px rgba(124,58,237,.4)` }}>
              {anime.image_url ? <img src={anime.image_url} alt="" style={{ width:"100%", height:"100%", objectFit:"cover", borderRadius:11 }}/> : "💬"}
            </div>
            <div style={{ flex:1, minWidth:0, paddingBottom:2 }}>
              <div style={{ fontSize:15, fontWeight:800, lineHeight:1.2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" as const }}>{anime.title}</div>
              <div style={{ display:"flex", gap:10, marginTop:3, flexWrap:"wrap" as const }}>
                <span style={{ fontSize:10, color:MT2, fontWeight:600 }}>{posts.length} posts</span>
                <span style={{ fontSize:10, color:MT2, fontWeight:600 }}>{uniquePosters} members</span>
                {totalVotes > 0 && <span style={{ fontSize:10, color:OR, fontWeight:700 }}>▲ {totalVotes}</span>}
              </div>
            </div>
            <button onClick={onClose} style={{ background:"rgba(255,255,255,0.08)", border:"none", color:MT, width:28, height:28, borderRadius:"50%", cursor:"pointer", fontSize:13, fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>✕</button>
          </div>

          {/* ── Sort tabs ── */}
          <div style={{ display:"flex", gap:2, padding:"0 14px 10px", borderBottom:`1px solid rgba(255,255,255,0.06)` }}>
            {(["hot","new","top"] as SortMode[]).map((m) => {
              const icons: Record<SortMode,string> = { hot:"🔥", new:"✨", top:"⬆️" };
              const sel = sortMode === m;
              return (
                <button key={m} onClick={() => setSortMode(m)}
                  style={{ display:"flex", alignItems:"center", gap:5, padding:"6px 12px", borderRadius:99, border:`1px solid ${sel ? OR : "transparent"}`, background: sel ? OR2 : "transparent", color: sel ? OR : MT, fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"inherit", textTransform:"uppercase" as const, letterSpacing:".5px", transition:"all .15s" }}>
                  <span style={{ fontSize:12 }}>{icons[m]}</span>{m}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Post feed ── */}
        <div style={{ flex:1, overflowY:"auto" }}>
          {loading ? (
            <div style={{ padding:"16px 16px 0" }}>
              {[0,1,2,3].map(i => (
                <div key={i} style={{ display:"flex", gap:10, padding:"14px 0", borderBottom:`1px solid rgba(255,255,255,0.05)` }}>
                  <div className="anical-skel" style={{ width:32, height:70, borderRadius:8, flexShrink:0 }}/>
                  <div style={{ flex:1, display:"flex", flexDirection:"column", gap:8 }}>
                    <div className="anical-skel" style={{ height:10, width:"40%", borderRadius:4 }}/>
                    <div className="anical-skel" style={{ height:13, width:"90%", borderRadius:4 }}/>
                    <div className="anical-skel" style={{ height:10, width:"60%", borderRadius:4 }}/>
                  </div>
                </div>
              ))}
            </div>
          ) : posts.length === 0 ? (
            <div style={{ textAlign:"center", padding:"56px 24px", color:MT }}>
              <div style={{ fontSize:52, marginBottom:14 }}>💬</div>
              <div style={{ fontSize:16, fontWeight:800, marginBottom:8 }}>No posts yet</div>
              <div style={{ fontSize:13, color:MT2, marginBottom:20 }}>Be the first to post in this community!</div>
              <button onClick={() => { setComposing(true); }} style={{ padding:"10px 24px", borderRadius:99, border:"none", background:`linear-gradient(135deg, ${OR}, #cc5610)`, color:"#fff", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>Create Post</button>
            </div>
          ) : (
            sorted.map((post, i) => {
              const votes = post.reactions["▲"] || 0;
              const voted = !!reactedMap[`${post.id}_▲`];
              return (
                <div key={post.id} style={{ display:"flex", gap:0, borderBottom:`1px solid rgba(255,255,255,0.05)`, animation:`cardIn .25s ${Math.min(i*30,250)}ms both` }}>
                  {/* Vote column */}
                  <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:2, padding:"14px 10px 14px 14px", minWidth:46 }}>
                    <button onClick={() => handleVote(post)}
                      style={{ background: voted ? OR2 : "rgba(255,255,255,0.05)", border:`1px solid ${voted ? OR3 : "rgba(255,255,255,0.08)"}`, color: voted ? OR : MT, width:32, height:32, borderRadius:8, cursor:"pointer", fontFamily:"inherit", fontSize:15, display:"flex", alignItems:"center", justifyContent:"center", transition:"all .15s", flexShrink:0 }}>
                      ▲
                    </button>
                    <span style={{ fontSize:12, fontWeight:800, color: voted ? OR : votes > 0 ? TX : MT2, lineHeight:1 }}>{votes || 0}</span>
                  </div>

                  {/* Content */}
                  <div style={{ flex:1, padding:"14px 14px 12px 4px", minWidth:0 }}>
                    {/* Author */}
                    <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:8 }}>
                      <Avatar nickname={post.nickname} color={safeAvatarColor(post.avatar_color)} size={22}/>
                      <span style={{ fontSize:12, fontWeight:700, color: safeAvatarColor(post.avatar_color) }}>{post.nickname}</span>
                      <span style={{ fontSize:10, color:MT2 }}>· {formatNewsAge(post.created_at)}</span>
                    </div>
                    {/* Message */}
                    <div style={{ fontSize:14, lineHeight:1.65, color:TX, wordBreak:"break-word" as const, marginBottom:10 }}>{post.message}</div>
                    {/* Awards row */}
                    <div style={{ display:"flex", gap:4, flexWrap:"wrap" as const }}>
                      {REACTION_EMOJIS.map(emoji => {
                        const count = post.reactions[emoji] || 0;
                        const reacted = !!reactedMap[`${post.id}_${emoji}`];
                        return (
                          <button key={emoji} onClick={() => handleReact(post, emoji)}
                            style={{ display:"flex", alignItems:"center", gap:3, padding:"3px 8px", borderRadius:99, background: reacted ? "rgba(255,107,26,.12)" : "rgba(255,255,255,0.04)", border:`1px solid ${reacted ? OR3 : "rgba(255,255,255,0.07)"}`, cursor:"pointer", fontFamily:"inherit", transition:"all .15s" }}>
                            <span style={{ fontSize:12 }}>{emoji}</span>
                            {count > 0 && <span style={{ fontSize:10, fontWeight:700, color: reacted ? OR : MT2 }}>{count}</span>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })
          )}
          {/* Bottom spacer */}
          <div style={{ height:20 }}/>
        </div>

        {/* ── Compose / Nickname area ── */}
        <div style={{ borderTop:`1px solid rgba(255,255,255,0.07)`, background:BG, flexShrink:0 } as React.CSSProperties}>
          {pickingNick ? (
            <div style={{ padding:"14px 16px 32px" }}>
              <div style={{ fontSize:13, fontWeight:700, marginBottom:10 }}>Pick your username</div>
              <div style={{ display:"flex", flexWrap:"wrap" as const, gap:5, marginBottom:10 }}>
                {NICK_SUGGESTIONS.map(s => (
                  <button key={s} onClick={() => setNickDraft(s)}
                    style={{ fontSize:11, padding:"4px 10px", borderRadius:99, border:`1px solid ${nickDraft===s?OR:BD}`, background:nickDraft===s?OR2:BG3, color:nickDraft===s?OR:MT, cursor:"pointer", fontFamily:"inherit" }}>
                    {s}
                  </button>
                ))}
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <input style={{ flex:1, background:BG3, border:`1px solid ${BD}`, borderRadius:10, padding:"9px 12px", color:TX, fontSize:13, fontFamily:"inherit", outline:"none" }}
                  placeholder="or type your own…" value={nickDraft}
                  onChange={e => setNickDraft(e.target.value)} maxLength={24}
                  onKeyDown={e => e.key==="Enter" && confirmNick()}/>
                <button onClick={confirmNick} disabled={nickDraft.trim().length < 2}
                  style={{ padding:"9px 16px", borderRadius:10, border:"none", background:nickDraft.trim().length>=2?`linear-gradient(135deg,${OR},#cc5610)`:BG3, color:nickDraft.trim().length>=2?"#fff":MT2, fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>
                  Join
                </button>
              </div>
            </div>
          ) : composing ? (
            <div style={{ padding:"12px 16px 32px" }}>
              <div style={{ display:"flex", gap:8, alignItems:"flex-start", marginBottom:8 }}>
                <Avatar nickname={nickname} color={avatarColor} size={30}/>
                <textarea ref={textareaRef}
                  style={{ flex:1, background:BG3, border:`1px solid ${draft?OR3:"rgba(255,255,255,.1)"}`, borderRadius:12, padding:"10px 12px", color:TX, fontSize:14, fontFamily:"inherit", resize:"none", outline:"none", minHeight:72, maxHeight:140, lineHeight:1.55, transition:"border-color .2s" } as React.CSSProperties}
                  autoFocus placeholder="What's your take on this show?"
                  value={draft} onChange={e => setDraft(e.target.value.slice(0, 500))} rows={3}/>
              </div>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <div style={{ fontSize:10, color:MT2 }}>
                  Posting as <span style={{ color:avatarColor, fontWeight:700 }}>{nickname}</span>
                  <button onClick={() => { setPickingNick(true); setNickDraft(nickname); }} style={{ marginLeft:8, fontSize:10, color:MT2, background:"none", border:"none", cursor:"pointer", fontFamily:"inherit", textDecoration:"underline", padding:0 }}>change</button>
                </div>
                <div style={{ display:"flex", gap:6 }}>
                  <button onClick={() => { setComposing(false); setDraft(""); }} style={{ padding:"7px 14px", borderRadius:99, border:`1px solid ${BD}`, background:"transparent", color:MT, fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>Cancel</button>
                  <button onClick={handleSend} disabled={!draft.trim() || sending}
                    style={{ padding:"7px 18px", borderRadius:99, border:"none", background:draft.trim()?`linear-gradient(135deg,${OR},#cc5610)`:BG3, color:draft.trim()?"#fff":MT2, fontSize:12, fontWeight:700, cursor:draft.trim()?"pointer":"default", fontFamily:"inherit", boxShadow:draft.trim()?`0 4px 14px rgba(255,107,26,.35)`:"none", transition:"all .18s" }}>
                    {sending ? "Posting…" : "Post"}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ padding:"10px 16px 32px", display:"flex", gap:10, alignItems:"center" }}>
              <Avatar nickname={nickname} color={avatarColor} size={30}/>
              <button onClick={() => setComposing(true)}
                style={{ flex:1, textAlign:"left" as const, background:"rgba(255,255,255,0.06)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:99, padding:"9px 16px", color:MT2, fontSize:13, cursor:"pointer", fontFamily:"inherit" }}>
                Share your thoughts on {anime.title.split(" ").slice(0,3).join(" ")}…
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ── Schedule view ──────────────────────────────────────────────────────────────
function ScheduleView({ anime, selectedDay, setSelectedDay, todayDayIdx, dayNavRef, schedule, favs, favFilter, search, tz, onOpen, onToggleFav, tick, topGenres, genreFilter, setGenreFilter, ratingFilter, setRatingFilter, streamOffsetMin }: {
  anime: Anime[];
  selectedDay: number;
  setSelectedDay: (d: number) => void;
  todayDayIdx: number;
  dayNavRef: React.RefObject<HTMLDivElement | null>;
  schedule: Schedule;
  favs: number[];
  favFilter: boolean;
  search: string;
  tz: string;
  onOpen: (a: Anime) => void;
  onToggleFav: (id: number) => void;
  tick: number;
  topGenres: string[];
  genreFilter: string | null;
  setGenreFilter: (g: string | null) => void;
  ratingFilter: number;
  setRatingFilter: (n: number) => void;
  streamOffsetMin: number;
}) {
  void streamOffsetMin; // referenced so the prop is part of the deps tree even though the cards re-read it via getStreamOffsetMin()
  const today = new Date();
  const swipeStartX = useRef(0);
  const swipeStartY = useRef(0);

  const getCount = (i: number) => {
    let list = schedule[DAYS[i]] || [];
    if (favFilter) list = list.filter((a) => favs.includes(a.id));
    if (genreFilter) list = list.filter((a) => (a.genres || []).includes(genreFilter));
    if (ratingFilter > 0) list = list.filter((a) => (a.score ?? 0) >= ratingFilter);
    if (search) { const q = search.toLowerCase(); list = list.filter((a) => a.title.toLowerCase().includes(q)); }
    return list.length;
  };

  const groups: Record<string, Anime[]> = {};
  anime.forEach((a) => { const k = a.broadcast_time || "?"; if (!groups[k]) groups[k] = []; groups[k].push(a); });
  const now = new Date();

  const onTouchStart = (e: React.TouchEvent) => {
    swipeStartX.current = e.touches[0].clientX;
    swipeStartY.current = e.touches[0].clientY;
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    if (e.changedTouches.length === 0) return;
    const dx = e.changedTouches[0].clientX - swipeStartX.current;
    const dy = e.changedTouches[0].clientY - swipeStartY.current;
    if (Math.abs(dx) > Math.abs(dy) + 20 && Math.abs(dx) > 60) {
      if (dx < 0) setSelectedDay(Math.min(6, selectedDay + 1));
      else setSelectedDay(Math.max(0, selectedDay - 1));
    }
  };

  return (
    <>
      <div style={{ display:"flex", gap:6, padding:"12px 16px", overflowX:"auto", scrollbarWidth:"none" }} ref={dayNavRef}>
        {DAYS.map((d, i) => {
          const date = new Date(today);
          date.setDate(today.getDate() - todayDayIdx + i);
          const active = i === selectedDay, isToday = i === todayDayIdx;
          return (
            <div
              key={d} data-day={i}
              style={{
                flexShrink:0, display:"flex", flexDirection:"column", alignItems:"center", gap:2,
                padding:"8px 14px", borderRadius:10,
                border:`1px solid ${active ? OR : isToday ? OR3 : BD}`,
                cursor:"pointer",
                background: active ? `linear-gradient(145deg, ${OR} 0%, #cc5610 100%)` : isToday ? OR2 : BG2,
                minWidth:54, transition:"all .22s cubic-bezier(.2,.7,.2,1)",
                boxShadow: active ? `0 6px 24px -4px rgba(255,107,26,.55)` : "none",
              }}
              onClick={() => setSelectedDay(i)}
            >
              <div style={{ fontSize:10, fontWeight:700, letterSpacing:".8px", textTransform:"uppercase", color: active ? "rgba(255,255,255,.8)" : isToday ? OR : MT }}>{DAY_SHORT[i]}</div>
              <div style={{ fontSize:18, fontWeight:800, color: active ? "#fff" : TX }}>{date.getDate()}</div>
              <div style={{ fontSize:10, fontWeight:500, color: active ? "rgba(255,255,255,.6)" : MT2 }}>{getCount(i)}</div>
            </div>
          );
        })}
      </div>

      {/* Genre filter chips — top genres across the week */}
      {topGenres.length > 0 && (
        <div style={{ display:"flex", gap:6, padding:"0 16px 6px", overflowX:"auto", scrollbarWidth:"none" } as React.CSSProperties}>
          <button
            aria-label="Show all genres"
            aria-pressed={genreFilter === null}
            onClick={() => { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); setGenreFilter(null); }}
            style={{ flexShrink:0, padding:"6px 13px", borderRadius:99, border:`1px solid ${genreFilter === null ? OR : BD}`, background: genreFilter === null ? OR2 : BG3, color: genreFilter === null ? OR : MT, fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"inherit", letterSpacing:".2px", transition:"all .15s" } as React.CSSProperties}
          >All</button>
          {topGenres.map((g) => {
            const active = genreFilter === g;
            return (
              <button
                key={g}
                aria-label={`Filter by ${g}`}
                aria-pressed={active}
                onClick={() => { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); setGenreFilter(active ? null : g); }}
                style={{ flexShrink:0, padding:"6px 13px", borderRadius:99, border:`1px solid ${active ? OR : BD}`, background: active ? OR2 : BG3, color: active ? OR : MT, fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"inherit", letterSpacing:".2px", transition:"all .15s" } as React.CSSProperties}
              >
                {g}
              </button>
            );
          })}
        </div>
      )}

      {/* Rating filter chips — MAL score threshold */}
      <div style={{ display:"flex", gap:6, padding:"0 16px 10px", overflowX:"auto", scrollbarWidth:"none", alignItems:"center" } as React.CSSProperties}>
        <span style={{ flexShrink:0, fontSize:10, fontWeight:800, color:MT2, letterSpacing:".6px", textTransform:"uppercase" as const, marginRight:2 }}>Rating</span>
        {([0, 7, 8, 9] as const).map((threshold) => {
          const active = ratingFilter === threshold;
          const label = threshold === 0 ? "All" : `${threshold}+`;
          return (
            <button
              key={threshold}
              aria-label={threshold === 0 ? "Show all ratings" : `Show anime rated ${threshold} or higher`}
              aria-pressed={active}
              onClick={() => { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); setRatingFilter(threshold); }}
              style={{ flexShrink:0, padding:"6px 12px", borderRadius:99, border:`1px solid ${active ? OR : BD}`, background: active ? OR2 : BG3, color: active ? OR : MT, fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"inherit", letterSpacing:".2px", transition:"all .15s", display:"inline-flex", alignItems:"center", gap:4 } as React.CSSProperties}
            >
              {threshold > 0 && <Icon name="starFilled" size={11} color={active ? OR : MT}/>}
              <span>{label}</span>
            </button>
          );
        })}
      </div>

      <div
        style={{ padding:"0 16px 16px", touchAction:"pan-y" } as React.CSSProperties}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {anime.length === 0 ? (
          <div style={{ textAlign:"center", padding:"48px 20px", color:MT, display:"flex", flexDirection:"column", alignItems:"center", gap:10 }}>
            <div style={{ fontSize:40 }}>{favFilter ? "⭐" : (genreFilter || ratingFilter > 0) ? "🔎" : "📭"}</div>
            <div style={{ fontSize:14, lineHeight:1.5, whiteSpace:"pre-line" }}>
              {favFilter ? "No favorites airing.\nTurn off filter to see all."
                : ratingFilter > 0 && genreFilter ? `No ${genreFilter} anime\nrated ${ratingFilter}+ airing this day.`
                : ratingFilter > 0 ? `No anime rated ${ratingFilter}+\nairing this day.`
                : genreFilter ? `No ${genreFilter} anime\nairing this day.`
                : "Nothing scheduled."}
            </div>
            {(favFilter || genreFilter || ratingFilter > 0) && (
              <button
                onClick={() => { setGenreFilter(null); setRatingFilter(0); }}
                style={{ marginTop:6, padding:"8px 18px", borderRadius:99, background:BG3, border:`1px solid ${BD}`, color:OR, fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}
              >Clear filters</button>
            )}
          </div>
        ) : (
          Object.entries(groups).map(([time, items]) => {
            let isNow = false, localStr: string | null = null;
            if (time !== "?") {
              const [h, m] = time.split(":").map(Number);
              const offsetMin = getStreamOffsetMin();
              const utcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h - 9, m) + offsetMin * 60_000;
              const diff = (utcMs - now.getTime()) / 60_000;
              isNow = selectedDay === todayDayIdx && diff > -30 && diff <= 0;
              const opts: Intl.DateTimeFormatOptions = { hour:"2-digit", minute:"2-digit", hour12:true };
              if (tz !== "auto") opts.timeZone = tz;
              localStr = new Date(utcMs).toLocaleTimeString([], opts);
            }
            return (
              <div key={time}>
                <div style={{ display:"flex", alignItems:"center", gap:8, padding:"14px 0 8px" }}>
                  <span style={{
                    fontSize:10, fontWeight:800, letterSpacing:".5px", textTransform:"uppercase",
                    padding:"4px 10px", borderRadius:99, flexShrink:0,
                    background: isNow ? "rgba(34,197,94,.15)" : BG3,
                    color: isNow ? GR : MT,
                    border:`1px solid ${isNow ? "rgba(34,197,94,.4)" : BD}`,
                  }}>
                    {isNow ? "🟢 Live" : time !== "?" ? `${time} JP` : "Time unknown"}
                  </span>
                  {!isNow && localStr && <span style={{ fontSize:10, color:OR, fontWeight:700, flexShrink:0 }}>→ {localStr}</span>}
                  <div style={{ flex:1, height:1, background:BD }}/>
                </div>
                {items.map((a, idx) => (
                  <AnimeCard key={a.id} anime={a} favorites={favs} tz={tz} onOpen={onOpen} onToggleFav={onToggleFav} animDelay={idx * 30} tick={tick}/>
                ))}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

// ── Upcoming view ──────────────────────────────────────────────────────────────
// Redesigned: no more confusing month calendar grid. Just a clean season
// countdown banner + filterable card grid of announced shows, with optional
// "Next season" preview.
function MonthView({ schedule: _schedule, favs: _favs, onOpen }: {
  // monthOffset / setMonthOffset kept for prop-compat with parent; unused
  monthOffset?: number;
  setMonthOffset?: (fn: (v: number) => number) => void;
  schedule: Schedule;
  favs: number[];
  // Opens the rich detail sheet (synopsis + trailer + news + community link)
  // instead of jumping straight to the community thread
  onOpen: (a: Anime) => void;
}) {
  void _schedule; void _favs;
  const now = new Date();

  // Upcoming data
  const [upcoming, setUpcoming] = useState<UpcomingAnime[]>(() => {
    const c = LS.get<{ ts: number; data: UpcomingAnime[] } | null>("anical_upcoming_cache", null);
    return c && Date.now() - c.ts < UPCOMING_TTL ? c.data : [];
  });
  const [upcomingStars, setUpcomingStars] = useState<number[]>(() => LS.get<number[]>("anical_upcoming_stars", []));
  const [upcomingLoading, setUpcomingLoading] = useState(() => {
    const c = LS.get<{ ts: number } | null>("anical_upcoming_cache", null);
    return !(c && Date.now() - c.ts < UPCOMING_TTL);
  });

  useEffect(() => {
    if (!upcomingLoading) return;
    fetchUpcoming().then((items) => {
      setUpcoming(items);
      LS.set("anical_upcoming_cache", { ts: Date.now(), data: items });
    }).finally(() => setUpcomingLoading(false));
  }, [upcomingLoading]);

  const toggleUpcomingStar = (id: number) => {
    Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
    setUpcomingStars((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      LS.set("anical_upcoming_stars", next);
      return next;
    });
  };

  // Compute current and next season
  const thisSeason = monthToSeason(now.getMonth());
  const thisSeasonYear = now.getFullYear();
  // The "next season" is the season after the current one
  const seasonOrder: Season[] = ["winter", "spring", "summer", "fall"];
  const thisIdx = seasonOrder.indexOf(thisSeason);
  const nextSeason = seasonOrder[(thisIdx + 1) % 4];
  const nextSeasonYear = nextSeason === "winter" && thisSeason === "fall" ? thisSeasonYear + 1 : thisSeasonYear;

  // Filter state — "next" | "soon" | "all"
  const [filter, setFilter] = useState<"next" | "soon" | "all" | "starred">("next");

  // Buckets
  const matchSeason = (a: UpcomingAnime, season: Season, year: number) =>
    a.season?.toLowerCase() === season && a.year === year;

  const nextSeasonItems = upcoming.filter((a) => matchSeason(a, nextSeason, nextSeasonYear));
  const allItems = upcoming;
  const starredItems = upcoming.filter((a) => upcomingStars.includes(a.id));
  // "Soon" = next 60 days from a season start
  const soonItems = upcoming.filter((a) => {
    if (!a.season || !a.year) return false;
    const start = new Date(a.year, SEASON_MONTHS[a.season.toLowerCase() as Season] || 0, 1);
    const days = Math.floor((start.getTime() - now.getTime()) / 86_400_000);
    return days >= -7 && days <= 60;
  });

  const filteredItems = filter === "next" ? nextSeasonItems : filter === "soon" ? soonItems : filter === "starred" ? starredItems : allItems;
  const groupedBySeasonYear: Record<string, UpcomingAnime[]> = {};
  filteredItems.forEach((a) => {
    if (!a.season || !a.year) return;
    const k = `${a.season.toLowerCase()}-${a.year}`;
    if (!groupedBySeasonYear[k]) groupedBySeasonYear[k] = [];
    groupedBySeasonYear[k].push(a);
  });
  const seasonGroups = Object.entries(groupedBySeasonYear).sort(([a], [b]) => {
    const [sA, yA] = a.split("-"); const [sB, yB] = b.split("-");
    if (yA !== yB) return Number(yA) - Number(yB);
    return seasonOrder.indexOf(sA as Season) - seasonOrder.indexOf(sB as Season);
  });

  const nextCountdown = seasonCountdown(nextSeason, nextSeasonYear);

  // Filter pill component
  const FilterPill = ({ id, label, count }: { id: typeof filter; label: string; count?: number }) => {
    const active = filter === id;
    return (
      <button
        aria-pressed={active}
        onClick={() => { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); setFilter(id); }}
        style={{
          flexShrink:0, padding:"8px 14px", borderRadius:99,
          border:`1px solid ${active ? "rgba(139,92,246,.6)" : BD}`,
          background: active ? "rgba(139,92,246,.14)" : BG3,
          color: active ? "rgba(167,139,250,1)" : MT,
          fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"inherit",
          letterSpacing:".2px", transition:"all .18s",
          display:"inline-flex", alignItems:"center", gap:6,
          boxShadow: active ? "0 0 12px rgba(139,92,246,.2)" : "none",
        } as React.CSSProperties}
      >
        <span>{label}</span>
        {count !== undefined && (
          <span style={{ fontSize:10, fontWeight:800, padding:"1px 6px", borderRadius:99, background: active ? "rgba(139,92,246,.25)" : BG4, color: active ? "rgba(167,139,250,1)" : MT2 }}>{count}</span>
        )}
      </button>
    );
  };

  return (
    <div style={{ padding:"4px 16px 24px" }}>
      {/* Hero — next season countdown */}
      <div style={{
        marginTop:8, marginBottom:16,
        background:`linear-gradient(135deg, rgba(139,92,246,.18), rgba(99,102,241,.10))`,
        border:`1px solid rgba(139,92,246,.32)`,
        borderRadius:18, padding:"18px 18px 16px",
        position:"relative", overflow:"hidden",
      }}>
        <div style={{ position:"absolute", top:-30, right:-20, fontSize:120, opacity:.08, pointerEvents:"none" }}>{SEASON_EMOJI[nextSeason]}</div>
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
          <Icon name="upcoming" size={16} color="rgba(167,139,250,1)" strokeWidth={2.2}/>
          <span style={{ fontSize:10, fontWeight:800, letterSpacing:".8px", textTransform:"uppercase", color:"rgba(167,139,250,1)" }}>Next Season</span>
        </div>
        <div style={{ fontSize:24, fontWeight:900, color:TX, letterSpacing:"-.5px", lineHeight:1.1 }}>
          {SEASON_EMOJI[nextSeason]} {seasonYear(nextSeason, nextSeasonYear)}
        </div>
        <div style={{ marginTop:8, fontSize:13, color:MT, fontWeight:600 }}>
          {upcomingLoading ? "Loading announcements…" : nextCountdown ? `Starts ${nextCountdown}` : "Season schedule TBA"}
        </div>
        {!upcomingLoading && nextSeasonItems.length > 0 && (
          <div style={{ marginTop:10, fontSize:11, color:"rgba(167,139,250,.85)", fontWeight:700 }}>
            {nextSeasonItems.length} show{nextSeasonItems.length === 1 ? "" : "s"} announced
          </div>
        )}
      </div>

      {/* Filter pills — scrollable */}
      <div style={{ display:"flex", gap:7, overflowX:"auto", paddingBottom:4, marginBottom:14, scrollbarWidth:"none" } as React.CSSProperties}>
        <FilterPill id="next"    label="Next season" count={nextSeasonItems.length}/>
        <FilterPill id="soon"    label="Coming soon" count={soonItems.length}/>
        <FilterPill id="starred" label="★ Starred"   count={starredItems.length}/>
        <FilterPill id="all"     label="All"         count={allItems.length}/>
      </div>

      {/* Content — grid of upcoming cards grouped by season */}
      {upcomingLoading ? (
        <div style={{ display:"grid", gridTemplateColumns:"repeat(2, 1fr)", gap:10 }}>
          {[0,1,2,3].map((i) => <div key={i} className="anical-skel" style={{ aspectRatio:"3/4", borderRadius:14 }}/>)}
        </div>
      ) : filteredItems.length === 0 ? (
        <div style={{ textAlign:"center", padding:"50px 20px", color:MT, display:"flex", flexDirection:"column", alignItems:"center", gap:10 }}>
          <div style={{ width:72, height:72, borderRadius:"50%", background:"rgba(139,92,246,.08)", display:"flex", alignItems:"center", justifyContent:"center", marginBottom:4 }}>
            <Icon name="upcoming" size={36} color="rgba(167,139,250,.6)" strokeWidth={1.8}/>
          </div>
          <div style={{ fontSize:15, fontWeight:700, color:TX }}>
            {filter === "starred" ? "Nothing starred yet" : "No upcoming shows here"}
          </div>
          <div style={{ fontSize:12, color:MT2, maxWidth:280, lineHeight:1.55 }}>
            {filter === "starred" ? "Tap ☆ on any upcoming show to keep it in your shortlist."
              : filter === "next" ? "Announcements for the next season will appear here as MyAnimeList confirms them."
              : "Try a different filter or check back soon — MAL refreshes the upcoming list weekly."}
          </div>
        </div>
      ) : (
        seasonGroups.map(([key, items]) => {
          const [s, y] = key.split("-");
          const seasonKey = s as Season;
          const yearN = Number(y);
          const cd = seasonCountdown(seasonKey, yearN);
          return (
            <div key={key} style={{ marginBottom:24 }}>
              {/* Season header */}
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                <span style={{ display:"inline-flex", alignItems:"center", gap:6, fontSize:11, fontWeight:800, letterSpacing:".5px", textTransform:"uppercase", padding:"4px 10px", borderRadius:99, background:"rgba(139,92,246,.12)", color:"rgba(167,139,250,1)", border:"1px solid rgba(139,92,246,.3)" }}>
                  <span style={{ fontSize:13 }}>{SEASON_EMOJI[seasonKey]}</span>
                  {seasonYear(seasonKey, yearN)}
                </span>
                <div style={{ flex:1, height:1, background:BD }}/>
                <span style={{ fontSize:10, color:MT2, fontWeight:600 }}>{items.length} show{items.length===1?"":"s"}</span>
              </div>
              {cd && (
                <div style={{ fontSize:11.5, color:"rgba(167,139,250,.85)", fontWeight:600, marginBottom:10, display:"inline-flex", alignItems:"center", gap:4 }}>
                  <Icon name="clock" size={11} color="rgba(167,139,250,.85)" strokeWidth={2.3}/>
                  <span>Season {cd}</span>
                </div>
              )}

              {/* Grid */}
              <div style={{ display:"grid", gridTemplateColumns:"repeat(2, 1fr)", gap:10 }}>
                {items.map((a, i) => {
                  const starred = upcomingStars.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      aria-label={`Open details for ${a.title}`}
                      onClick={() => { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); onOpen({ id:a.id, title:a.title, image_url:a.imageUrl ?? null, genres:a.genres, episodes:a.episodes, synopsis:a.synopsis, studios:a.studios, year:a.year, season:a.season, mal_url:a.mal_url ?? null }); }}
                      style={{
                        position:"relative", overflow:"hidden",
                        background: starred ? `rgba(255,107,26,.07)` : BG2,
                        border:`1px solid ${starred ? OR3 : "rgba(139,92,246,.2)"}`,
                        borderRadius:14, cursor:"pointer", padding:0,
                        fontFamily:"inherit", color:TX, textAlign:"left" as const,
                        animation:`cardIn .35s ${Math.min(i*40, 400)}ms both`,
                        transition:"transform .15s, border-color .2s",
                      } as React.CSSProperties}
                    >
                      {/* Poster */}
                      <div style={{ position:"relative", width:"100%", aspectRatio:"3/4", background:BG4 }}>
                        {a.imageUrl
                          ? <img src={a.imageUrl} alt={a.title} loading="lazy" decoding="async" style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }}/>
                          : <div style={{ width:"100%", height:"100%", display:"flex", alignItems:"center", justifyContent:"center" }}>
                              <Icon name="upcoming" size={36} color={MT2}/>
                            </div>}
                        <div style={{ position:"absolute", inset:0, background:"linear-gradient(180deg, transparent 50%, rgba(0,0,0,.8))" }}/>
                        {/* Star button */}
                        <button
                          aria-label={starred ? `Unstar ${a.title}` : `Star ${a.title}`}
                          aria-pressed={starred}
                          onClick={(e) => { e.stopPropagation(); toggleUpcomingStar(a.id); }}
                          style={{ position:"absolute", top:8, right:8, width:34, height:34, borderRadius:"50%", background:"rgba(0,0,0,.55)", border:"1px solid rgba(255,255,255,.12)", color: starred ? OR : "rgba(255,255,255,.92)", display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", backdropFilter:"blur(8px)", fontFamily:"inherit" } as React.CSSProperties}
                        >
                          <Icon name={starred ? "starFilled" : "star"} size={16} color={starred ? OR : "#fff"}/>
                        </button>
                        {/* Genre pill (top-left) */}
                        {a.genres?.[0] && (
                          <span style={{ position:"absolute", top:8, left:8, fontSize:9, fontWeight:800, padding:"3px 8px", borderRadius:99, background:"rgba(0,0,0,.55)", color:"#fff", backdropFilter:"blur(8px)", letterSpacing:".3px" } as React.CSSProperties}>{a.genres[0]}</span>
                        )}
                      </div>

                      {/* Info */}
                      <div style={{ padding:"10px 11px 12px" }}>
                        <div style={{ fontSize:13, fontWeight:800, lineHeight:1.3, color:TX, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" as const, minHeight:34, letterSpacing:"-.1px" }}>{a.title}</div>
                        <div style={{ display:"flex", alignItems:"center", gap:5, marginTop:5, fontSize:10, color:MT2 }}>
                          <span style={{ color:"rgba(167,139,250,1)", fontWeight:700 }}>{SEASON_EMOJI[seasonKey]} {capitalize(seasonKey)}</span>
                          {a.episodes && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>{a.episodes} ep{a.episodes===1?"":"s"}</span>
                            </>
                          )}
                        </div>
                        {a.studios?.[0] && (
                          <div style={{ marginTop:4, fontSize:10, color:MT, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" as const }}>{a.studios[0]}</div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// ── Notification banner ────────────────────────────────────────────────────────
function NotifBanner({ notifPerm, notifEnabled, notifSettings, setNotifSettings, requestNotifPerm, testNotif }: any) {
  if (notifPerm === "unsupported") return null;
  const denied = notifPerm === "denied";

  const toggle = async () => {
    if (notifEnabled) {
      setNotifSettings((s: NotifSettings) => ({ ...s, enabled: false }));
    } else if (!denied) {
      const g = (await requestNotifPerm()) === "granted";
      if (g) setNotifSettings((s: NotifSettings) => ({ ...s, enabled: true }));
    }
  };

  return (
    <div style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:12, overflow:"hidden" }}>
      {/* Main row */}
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"11px 14px" }}>
        <span style={{ fontSize:15, opacity: notifEnabled ? 1 : 0.4 }}>{notifEnabled ? "🔔" : "🔕"}</span>
        <div style={{ flex:1, minWidth:0 }}>
          <span style={{ fontSize:12, fontWeight:600, color: notifEnabled ? TX : MT, letterSpacing:".1px" }}>Notifications</span>
          {notifEnabled && (
            <span style={{ fontSize:10, color:MT2, marginLeft:8 }}>
              {notifSettings.leadMinutes === 0 ? "at airtime" : `${notifSettings.leadMinutes} min before`}
            </span>
          )}
          {denied && <span style={{ fontSize:10, color:MT2, marginLeft:8 }}>Blocked in browser settings</span>}
        </div>
        {/* Toggle switch */}
        <button
          onClick={toggle}
          disabled={denied}
          style={{ position:"relative", width:38, height:22, borderRadius:11, border:"none", background: notifEnabled ? OR : "rgba(255,255,255,0.12)", cursor: denied ? "default" : "pointer", transition:"background .2s", padding:0, flexShrink:0 } as React.CSSProperties}
        >
          <span style={{ position:"absolute", top:3, left: notifEnabled ? 19 : 3, width:16, height:16, borderRadius:"50%", background:"#fff", transition:"left .2s", display:"block", boxShadow:"0 1px 4px rgba(0,0,0,.4)" } as React.CSSProperties}/>
        </button>
      </div>

      {/* Timing row — only when on */}
      {notifEnabled && (
        <div style={{ borderTop:"1px solid rgba(255,255,255,0.06)", padding:"8px 14px", display:"flex", gap:5, alignItems:"center", overflowX:"auto" } as React.CSSProperties}>
          {LEAD_OPTIONS.map((m) => {
            const sel = notifSettings.leadMinutes === m;
            return (
              <button key={m} onClick={() => setNotifSettings((s: NotifSettings) => ({ ...s, leadMinutes: m }))}
                style={{ fontSize:10, fontWeight:700, padding:"3px 9px", borderRadius:99, whiteSpace:"nowrap", background: sel ? OR : "transparent", border:`1px solid ${sel ? OR : "rgba(255,255,255,0.1)"}`, color: sel ? "#fff" : MT2, cursor:"pointer", fontFamily:"inherit", transition:"all .15s", flexShrink:0 } as React.CSSProperties}>
                {m === 0 ? "at airtime" : `${m}m before`}
              </button>
            );
          })}
          <button onClick={testNotif}
            style={{ marginLeft:"auto", fontSize:10, fontWeight:600, padding:"3px 9px", borderRadius:99, background:"transparent", border:"1px solid rgba(255,255,255,0.1)", color:MT2, cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap", flexShrink:0 } as React.CSSProperties}>
            Test
          </button>
        </div>
      )}
    </div>
  );
}

// ── Upcoming card ─────────────────────────────────────────────────────────────
function UpcomingCard({ anime, starred, onToggle, onOpen, delay = 0 }: { anime: UpcomingAnime; starred: boolean; onToggle: (id: number) => void; onOpen: (a: UpcomingAnime) => void; delay?: number }) {
  const [imgFailed, setImgFailed] = useState(false);
  const seasonLabel = [capitalize(anime.season), anime.year].filter(Boolean).join(" ");
  return (
    <div
      className="anical-card"
      onClick={() => onOpen(anime)}
      style={{ display:"flex", gap:12, padding:12, background: starred ? `rgba(255,107,26,.07)` : BG2, border:`1px solid ${starred ? OR3 : BD}`, borderRadius:14, cursor:"pointer", overflow:"hidden", animation:`cardIn .4s ${delay}ms cubic-bezier(.2,.7,.2,1) both`, transition:"transform .15s", boxShadow: starred ? `0 4px 18px -6px ${OR3}` : "none" }}
    >
      <div style={{ position:"relative", flexShrink:0, width:60, height:84, borderRadius:8, overflow:"hidden", background:BG4 }}>
        {anime.imageUrl && !imgFailed
          ? <img src={anime.imageUrl} alt="" loading="lazy" style={{ width:"100%", height:"100%", objectFit:"cover" }} onError={() => setImgFailed(true)}/>
          : <div style={{ width:"100%", height:"100%", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, color:MT2 }}>🎬</div>}
        <div style={{ position:"absolute", inset:0, background:"linear-gradient(180deg, transparent 55%, rgba(0,0,0,.7))" }}/>
      </div>
      <div style={{ flex:1, minWidth:0, display:"flex", flexDirection:"column", justifyContent:"center", gap:5 }}>
        <div style={{ fontSize:14, fontWeight:700, lineHeight:1.3, color:TX, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" as const }}>{anime.title}</div>
        <div style={{ display:"flex", gap:5, flexWrap:"wrap" as const, alignItems:"center" }}>
          {seasonLabel && <span style={{ fontSize:10, fontWeight:700, padding:"2px 7px", borderRadius:6, background:OR2, color:OR, border:`1px solid ${OR3}` }}>{seasonLabel}</span>}
          {anime.episodes && <span style={{ fontSize:10, color:MT, padding:"2px 7px", borderRadius:6, background:BG3, border:`1px solid ${BD}` }}>{anime.episodes} eps</span>}
          {anime.genres?.[0] && <span style={{ fontSize:10, color:MT, padding:"2px 7px", borderRadius:6, background:BG3, border:`1px solid ${BD}` }}>{anime.genres[0]}</span>}
        </div>
        {anime.studios?.[0] && <div style={{ fontSize:10, color:MT2, fontWeight:600 }}>{anime.studios[0]}</div>}
      </div>
      <button
        className="anical-favbtn"
        onClick={(e) => { e.stopPropagation(); onToggle(anime.id); }}
        style={{ flexShrink:0, alignSelf:"flex-start", background:"none", border:"none", cursor:"pointer", fontSize:22, padding:"2px 4px", lineHeight:1, color: starred ? OR : MT2, fontFamily:"inherit", transition:"color .15s" }}
      >{starred ? "★" : "☆"}</button>
    </div>
  );
}

// ── News card ──────────────────────────────────────────────────────────────────
// Rough estimate of read time from the excerpt
function estimateReadMin(excerpt?: string): number {
  if (!excerpt) return 1;
  const words = excerpt.split(/\s+/).length;
  // ANN excerpts are often a teaser; bump up a bit so it feels closer to article length
  const total = Math.max(words * 5, 200);
  return Math.max(1, Math.round(total / 220));
}

function NewsCard({ item, delay = 0, onOpen }: { item: NewsItem; delay?: number; onOpen: (n: NewsItem) => void }) {
  const age = formatNewsAge(item.date);
  const isANN = item.source === "ANN";
  const readMin = estimateReadMin(item.excerpt);
  const hasImage = !!item.imageUrl;
  return (
    <article
      className="anical-card"
      onClick={() => onOpen(item)}
      role="button"
      aria-label={`Read ${item.title}`}
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(item); } }}
      style={{
        display:"flex", flexDirection:"column",
        background:BG2, border:`1px solid ${BD}`, borderRadius:16,
        cursor:"pointer", marginBottom:10, overflow:"hidden",
        animation:`cardIn .4s ${delay}ms cubic-bezier(.2,.7,.2,1) both`,
        transition:"transform .15s, border-color .2s, box-shadow .2s",
      } as React.CSSProperties}
    >
      {/* Hero image — full width if present */}
      {hasImage && (
        <div style={{ position:"relative", width:"100%", height:158, background:BG4, overflow:"hidden" }}>
          <img src={item.imageUrl} alt={item.title} loading="lazy" decoding="async" style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }}/>
          <div style={{ position:"absolute", inset:0, background:"linear-gradient(180deg, rgba(0,0,0,.05) 0%, rgba(0,0,0,.65) 100%)" }}/>
          {/* Source pill over image */}
          <span style={{ position:"absolute", top:10, left:10, fontSize:9, fontWeight:800, padding:"3px 8px", borderRadius:6, background: isANN ? OR : "rgba(0,0,0,.55)", color:"#fff", border:`1px solid ${isANN ? OR : "rgba(255,255,255,.15)"}`, textTransform:"uppercase" as const, letterSpacing:".7px", backdropFilter:"blur(8px)" } as React.CSSProperties}>{item.source}</span>
          {item.animeTitle && (
            <span style={{ position:"absolute", top:10, right:10, fontSize:10, fontWeight:700, padding:"3px 8px", borderRadius:99, background:"rgba(255,107,26,.25)", color:"#fff", border:`1px solid rgba(255,107,26,.6)`, backdropFilter:"blur(8px)", maxWidth:160, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" as const } as React.CSSProperties}>{item.animeTitle}</span>
          )}
        </div>
      )}

      {/* Body */}
      <div style={{ display:"flex", gap:12, padding: hasImage ? "12px 14px 14px" : 14 }}>
        {/* Compact thumb shown when no hero image */}
        {!hasImage && (
          <div style={{ width:78, height:78, borderRadius:12, background:BG4, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, color:MT2 }}>
            <Icon name="news" size={32} color={MT2}/>
          </div>
        )}
        <div style={{ flex:1, minWidth:0 }}>
          {/* Meta row when no hero image */}
          {!hasImage && (
            <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:6, flexWrap:"wrap" as const }}>
              <span style={{ fontSize:9, fontWeight:800, padding:"2px 7px", borderRadius:4, background:isANN?OR2:BG3, color:isANN?OR:MT, border:`1px solid ${isANN?OR3:BD}`, textTransform:"uppercase" as const, letterSpacing:".5px" }}>{item.source}</span>
              {item.animeTitle && <span style={{ fontSize:10, color:OR, fontWeight:700, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" as const, maxWidth:140 }}>{item.animeTitle}</span>}
            </div>
          )}
          {/* Title */}
          <h3 style={{ fontSize:14.5, fontWeight:800, lineHeight:1.32, color:TX, margin:0, marginBottom:6, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:hasImage?2:2, WebkitBoxOrient:"vertical" as const, letterSpacing:"-.1px" } as React.CSSProperties}>{item.title}</h3>
          {/* Excerpt — 3 lines for richer preview */}
          {item.excerpt && (
            <p style={{ fontSize:12, color:MT, lineHeight:1.6, margin:0, marginBottom:8, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:3, WebkitBoxOrient:"vertical" as const } as React.CSSProperties}>{item.excerpt}</p>
          )}
          {/* Footer with read time + age + chevron */}
          <div style={{ display:"flex", alignItems:"center", gap:6, fontSize:10.5, color:MT2 }}>
            <div style={{ display:"inline-flex", alignItems:"center", gap:3 }}>
              <Icon name="clock" size={11} color={MT2} strokeWidth={2.2}/>
              <span>{readMin} min read</span>
            </div>
            {age && <span aria-hidden="true">·</span>}
            {age && <span>{age}</span>}
            <span style={{ marginLeft:"auto", display:"inline-flex", alignItems:"center", gap:3, color:OR, fontWeight:700 }}>
              Read more
              <Icon name="chevronRight" size={11} color={OR} strokeWidth={2.5}/>
            </span>
          </div>
        </div>
      </div>
    </article>
  );
}

// ── News detail sheet ──────────────────────────────────────────────────────────
function NewsDetailSheet({ item, onClose }: { item: NewsItem; onClose: () => void }) {
  const age = formatNewsAge(item.date);
  const isANN = item.source === "ANN";
  const readMin = estimateReadMin(item.excerpt);
  const fullDate = item.date ? (() => { try { return new Date(item.date).toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" }); } catch { return null; } })() : null;
  // Split excerpt into paragraphs on double-newline or sentence boundaries for nicer reading
  const paragraphs: string[] = item.excerpt
    ? item.excerpt.split(/\n\n+|(?<=[\.\?\!])\s+(?=[A-Z"])/)
        .map((p) => p.trim()).filter((p) => p.length > 0)
    : [];
  const handleShareArticle = async () => {
    Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
    try {
      if ((navigator as any).share) {
        await (navigator as any).share({ title: item.title, text: item.title, url: item.url });
        return;
      }
    } catch {}
    try { await navigator.clipboard.writeText(item.url); } catch {}
  };
  return (
    <>
      <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.84)", zIndex:200, backdropFilter:"blur(8px)" } as React.CSSProperties} onClick={onClose}/>
      <div role="dialog" aria-modal="true" aria-label={item.title}
        style={{ position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)", width:"100%", maxWidth:480, background:BG2, borderRadius:"22px 22px 0 0", border:`1px solid ${BD}`, borderBottom:"none", maxHeight:"92vh", overflowY:"auto", zIndex:201, animation:"sheetUp .3s cubic-bezier(.2,.7,.2,1)" }}>
        <div style={{ width:40, height:4, background:BD2, borderRadius:2, margin:"12px auto 0" }}/>

        {/* Hero image — larger */}
        {item.imageUrl ? (
          <div style={{ position:"relative", margin:"12px 0 0", height:240, overflow:"hidden" }}>
            <img src={item.imageUrl} alt={item.title} loading="eager" decoding="async" style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }}/>
            <div style={{ position:"absolute", inset:0, background:"linear-gradient(to bottom, transparent 35%, rgba(17,17,25,.96))" }}/>
            {/* Close button over image */}
            <button
              aria-label="Close"
              onClick={onClose}
              style={{ position:"absolute", top:10, right:12, width:36, height:36, borderRadius:"50%", background:"rgba(0,0,0,.55)", border:"1px solid rgba(255,255,255,.18)", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", backdropFilter:"blur(8px)" } as React.CSSProperties}
            >
              <Icon name="close" size={18} color="#fff"/>
            </button>
            {/* Source + pills row */}
            <div style={{ position:"absolute", top:10, left:14, display:"flex", gap:6, flexWrap:"wrap" as const }}>
              <span style={{ fontSize:9, fontWeight:800, padding:"4px 9px", borderRadius:6, background: isANN ? OR : "rgba(0,0,0,.55)", color:"#fff", border:`1px solid ${isANN ? OR : "rgba(255,255,255,.15)"}`, textTransform:"uppercase" as const, letterSpacing:".8px", backdropFilter:"blur(8px)" } as React.CSSProperties}>{item.source}</span>
              {item.animeTitle && (
                <span style={{ fontSize:10, fontWeight:700, padding:"4px 9px", borderRadius:99, background:"rgba(255,107,26,.25)", color:"#fff", border:`1px solid rgba(255,107,26,.6)`, backdropFilter:"blur(8px)", maxWidth:180, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" as const } as React.CSSProperties}>{item.animeTitle}</span>
              )}
            </div>
          </div>
        ) : (
          <div style={{ display:"flex", alignItems:"center", justifyContent:"flex-end", padding:"6px 12px 0" }}>
            <button aria-label="Close" onClick={onClose} style={{ width:32, height:32, borderRadius:"50%", background:BG3, border:`1px solid ${BD}`, color:MT, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer" }}>
              <Icon name="close" size={16} color={MT}/>
            </button>
          </div>
        )}

        <div style={{ padding: item.imageUrl ? "0 22px 48px" : "0 22px 48px" }}>
          {/* Meta row (only when no hero) */}
          {!item.imageUrl && (
            <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" as const, marginBottom:12 }}>
              <span style={{ fontSize:9, fontWeight:800, padding:"3px 8px", borderRadius:4, background:isANN?OR2:BG3, color:isANN?OR:MT, border:`1px solid ${isANN?OR3:BD}`, textTransform:"uppercase" as const, letterSpacing:".6px" }}>{item.source}</span>
              {item.animeTitle && (
                <span style={{ fontSize:11, fontWeight:700, padding:"3px 9px", borderRadius:99, background:OR2, color:OR, border:`1px solid ${OR3}` }}>{item.animeTitle}</span>
              )}
            </div>
          )}

          {/* Title — bigger, tighter */}
          <h2 style={{ fontSize:23, fontWeight:900, lineHeight:1.22, color:TX, margin:0, marginTop:item.imageUrl ? 4 : 0, marginBottom:12, letterSpacing:"-.4px" }}>{item.title}</h2>

          {/* Byline row */}
          <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" as const, marginBottom:18, fontSize:11.5, color:MT }}>
            <div style={{ display:"inline-flex", alignItems:"center", gap:4 }}>
              <Icon name="news" size={13} color={MT} strokeWidth={2}/>
              <span style={{ fontWeight:600 }}>{isANN ? "Anime News Network" : "MyAnimeList"}</span>
            </div>
            {fullDate && <><span aria-hidden="true">·</span><span>{fullDate}</span></>}
            {age && <><span aria-hidden="true">·</span><span>{age}</span></>}
            <div style={{ marginLeft:"auto", display:"inline-flex", alignItems:"center", gap:4, color:OR, fontWeight:700 }}>
              <Icon name="clock" size={12} color={OR} strokeWidth={2.4}/>
              <span>{readMin} min read</span>
            </div>
          </div>

          {/* Divider */}
          <div style={{ height:1, background:BD, marginBottom:18 }}/>

          {/* Body — proper paragraph breaks */}
          {paragraphs.length > 0 ? (
            <div style={{ marginBottom:24 }}>
              {paragraphs.map((p, i) => (
                <p key={i} style={{ fontSize:15, lineHeight:1.78, color:TX, opacity:.92, margin:0, marginBottom: i === paragraphs.length - 1 ? 0 : 14, letterSpacing:".05px" } as React.CSSProperties}>{p}</p>
              ))}
              {/* Read-more nudge */}
              <div style={{ marginTop:14, padding:"10px 14px", background:BG3, border:`1px dashed ${BD2}`, borderRadius:10, fontSize:12, color:MT, textAlign:"center" as const, fontStyle:"italic" as const }}>
                Preview shown — open the full article for the complete story.
              </div>
            </div>
          ) : (
            <div style={{ fontSize:13, color:MT2, marginBottom:24, fontStyle:"italic" as const, padding:"16px 14px", background:BG3, borderRadius:10, textAlign:"center" as const }}>
              No preview available for this article. Tap below to read the full story on {isANN ? "ANN" : "MAL"}.
            </div>
          )}

          {/* Actions: Read full + Share */}
          <div style={{ display:"flex", gap:8 }}>
            <button
              aria-label="Read the full article"
              onClick={() => { Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {}); openUrl(item.url); }}
              style={{ flex:1, padding:"14px 18px", borderRadius:14, border:"none", background:`linear-gradient(135deg, ${OR}, #cc5610)`, color:"#fff", fontSize:14.5, fontWeight:800, cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center", gap:8, boxShadow:`0 8px 24px -6px rgba(255,107,26,.5)` } as React.CSSProperties}
            >
              <span>Read Full Article</span>
              <Icon name="external" size={16} color="#fff"/>
            </button>
            <button
              aria-label="Share article"
              onClick={handleShareArticle}
              style={{ flexShrink:0, width:50, borderRadius:14, border:`1px solid ${BD}`, background:BG3, color:MT, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", fontFamily:"inherit" } as React.CSSProperties}
            >
              <Icon name="share" size={18} color={MT}/>
            </button>
          </div>

          {/* Source label */}
          <div style={{ textAlign:"center", fontSize:10.5, color:MT2, marginTop:12, letterSpacing:".3px" }}>
            via {isANN ? "Anime News Network" : "MyAnimeList"}
          </div>
        </div>
      </div>
    </>
  );
}

// ── News skeleton ──────────────────────────────────────────────────────────────
function NewsSkeleton({ withHero = true }: { withHero?: boolean }) {
  return (
    <div style={{ background:BG2, border:`1px solid ${BD}`, borderRadius:16, marginBottom:10, overflow:"hidden" }}>
      {withHero && <div className="anical-skel" style={{ width:"100%", height:158 }}/>}
      <div style={{ padding:"12px 14px 14px", display:"flex", flexDirection:"column", gap:8 }}>
        <div className="anical-skel" style={{ height:14, borderRadius:5, width:"92%" }}/>
        <div className="anical-skel" style={{ height:14, borderRadius:5, width:"70%" }}/>
        <div style={{ height:4 }}/>
        <div className="anical-skel" style={{ height:10, borderRadius:4, width:"100%" }}/>
        <div className="anical-skel" style={{ height:10, borderRadius:4, width:"100%" }}/>
        <div className="anical-skel" style={{ height:10, borderRadius:4, width:"55%" }}/>
      </div>
    </div>
  );
}

// ── Art post detail sheet ──────────────────────────────────────────────────────
// Instagram-style post detail: full-size image, caption, like, comments,
// report (auto-hides at 3 flags), and a link to the anime detail when tagged.
function ArtPostSheet({ post, onClose, onUpdated, onOpenAnime, allAnime, onToast }: {
  post: ArtPost;
  onClose: () => void;
  onUpdated: (p: ArtPost) => void;
  onOpenAnime: (a: Anime) => void;
  allAnime: Anime[];
  onToast: (msg: string) => void;
}) {
  const [comments, setComments] = useState<ArtComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [liked, setLiked] = useState<boolean>(() => LS.get<boolean>(`anical_art_liked_${post.id}`, false));
  const [flagged, setFlagged] = useState<boolean>(() => LS.get<boolean>(`anical_art_flagged_${post.id}`, false));
  const [optimisticLikes, setOptimisticLikes] = useState(post.likes);
  const [nickname, setNickname] = useState<string>(() => LS.get<string>("anical_nickname", ""));
  const [nickDraft, setNickDraft] = useState("");
  const [pickingNick, setPickingNick] = useState(!LS.get<string>("anical_nickname", ""));
  const avatarColor = nickname ? getAvatarColor(nickname) : OR;
  const tagged = post.anime_id ? allAnime.find((a) => a.id === post.anime_id) : null;

  useEffect(() => {
    let cancelled = false;
    fetchArtComments(post.id)
      .then((c) => { if (!cancelled) setComments(c); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [post.id]);

  const handleLike = async () => {
    if (liked) return;
    Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
    setLiked(true);
    LS.set(`anical_art_liked_${post.id}`, true);
    setOptimisticLikes((n) => n + 1);
    try {
      await likeArtPost(post.id, post.likes);
      onUpdated({ ...post, likes: post.likes + 1 });
    } catch {}
  };

  const handleFlag = async () => {
    if (flagged) return;
    Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {});
    setFlagged(true);
    LS.set(`anical_art_flagged_${post.id}`, true);
    try {
      await flagArtPost(post.id, post.flag_count);
      onToast("Reported — thanks for keeping the community safe");
    } catch {
      onToast("Couldn't report — try again");
    }
  };

  const confirmNick = () => {
    const n = nickDraft.trim();
    if (n.length < 2) return;
    setNickname(n);
    LS.set("anical_nickname", n);
    setPickingNick(false);
  };

  const handleSend = async () => {
    if (!draft.trim() || !nickname || sending) return;
    setSending(true);
    try {
      const c = await submitArtComment({
        art_id: post.id,
        nickname,
        avatar_color: avatarColor,
        message: draft.trim(),
      });
      setComments((cs) => [...cs, c]);
      setDraft("");
      onUpdated({ ...post, comment_count: post.comment_count + 1 });
      Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
    } catch {
      onToast("Couldn't post comment");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.92)", zIndex:300, animation:"fadeIn .25s ease-out", backdropFilter:"blur(8px)" } as React.CSSProperties} onClick={onClose}/>
      <div role="dialog" aria-modal="true" aria-label="Art post"
        style={{ position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)", width:"100%", maxWidth:480, background:BG2, borderRadius:"22px 22px 0 0", border:`1px solid ${BD}`, borderBottom:"none", maxHeight:"92vh", overflowY:"auto", zIndex:301, animation:"sheetUpScale .42s cubic-bezier(.2,.85,.2,1) both" } as React.CSSProperties}>
        <div style={{ width:40, height:4, background:BD2, borderRadius:2, margin:"12px auto 0" }}/>

        {/* Top bar with poster + close */}
        <div style={{ padding:"14px 16px 12px", display:"flex", alignItems:"center", gap:10 }}>
          <Avatar nickname={post.nickname} color={safeAvatarColor(post.avatar_color)} size={36}/>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:13, fontWeight:700, color:safeAvatarColor(post.avatar_color), letterSpacing:"-.05px" }}>{post.nickname}</div>
            <div style={{ fontSize:10.5, color:MT2, marginTop:1 }}>{formatNewsAge(post.created_at)}</div>
          </div>
          {tagged && (
            <button
              onClick={() => { onClose(); setTimeout(() => onOpenAnime(tagged), 120); }}
              style={{ display:"inline-flex", alignItems:"center", gap:5, padding:"5px 10px", borderRadius:99, background:OR2, border:`1px solid ${OR3}`, color:OR, fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"inherit", maxWidth:140, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" as const } as React.CSSProperties}
            >
              <Icon name="starFilled" size={10} color={OR}/>
              <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" as const }}>{tagged.title}</span>
            </button>
          )}
          <button aria-label="Close" onClick={onClose} style={{ width:32, height:32, borderRadius:"50%", background:BG3, border:`1px solid ${BD}`, color:MT, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer" } as React.CSSProperties}>
            <Icon name="close" size={16} color={MT}/>
          </button>
        </div>

        {/* Image */}
        <div style={{ width:"100%", background:"#000", position:"relative", animation:"heroIn .45s cubic-bezier(.2,.7,.2,1) both" } as React.CSSProperties}>
          <img src={post.image_url} alt={post.caption || "Anime fan art"} loading="eager" decoding="async"
            style={{ width:"100%", maxHeight:"60vh", objectFit:"contain", display:"block" } as React.CSSProperties}/>
        </div>

        {/* Actions row */}
        <div style={{ padding:"12px 18px 6px", display:"flex", alignItems:"center", gap:14 }}>
          <button
            aria-label={liked ? "Liked" : "Like"}
            aria-pressed={liked}
            onClick={handleLike}
            style={{ display:"inline-flex", alignItems:"center", gap:6, background:"none", border:"none", color: liked ? OR : MT, cursor:"pointer", padding:0, fontFamily:"inherit", fontSize:14, fontWeight:700, transition:"transform .12s", transform: liked ? "scale(1.05)" : "scale(1)" } as React.CSSProperties}
          >
            <Icon name={liked ? "heartFilled" : "heart"} size={22} color={liked ? OR : MT}/>
            <span>{optimisticLikes}</span>
          </button>
          <div style={{ display:"inline-flex", alignItems:"center", gap:6, color:MT, fontSize:14, fontWeight:700 }}>
            <Icon name="community" size={22} color={MT}/>
            <span>{post.comment_count + comments.length - (post.comment_count || 0)}</span>
          </div>
          <button
            aria-label={flagged ? "Reported" : "Report this post"}
            onClick={handleFlag}
            disabled={flagged}
            style={{ marginLeft:"auto", display:"inline-flex", alignItems:"center", gap:5, background:"none", border:"none", color: flagged ? MT2 : MT, cursor: flagged ? "default" : "pointer", padding:0, fontFamily:"inherit", fontSize:11.5, fontWeight:600 } as React.CSSProperties}
          >
            <Icon name="spoiler" size={14} color={flagged ? MT2 : MT}/>
            <span>{flagged ? "Reported" : "Report"}</span>
          </button>
        </div>

        {/* Caption */}
        {post.caption && (
          <div style={{ padding:"4px 18px 14px", fontSize:14, lineHeight:1.55, color:TX }}>
            <span style={{ fontWeight:700, color:safeAvatarColor(post.avatar_color), marginRight:6 }}>{post.nickname}</span>
            <span style={{ opacity:.9 }}>{post.caption}</span>
          </div>
        )}

        {/* Comments */}
        <div style={{ padding:"6px 18px 12px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8, fontSize:11, fontWeight:800, color:MT2, letterSpacing:".8px", textTransform:"uppercase" as const }}>
            <Icon name="community" size={12} color={MT2}/>
            <span>Comments</span>
            {!loading && <span style={{ fontSize:10, padding:"1px 6px", borderRadius:99, background:BG3, border:`1px solid ${BD}`, color:MT }}>{comments.length}</span>}
            <div style={{ flex:1, height:1, background:BD }}/>
          </div>
          {loading ? (
            [0,1,2].map((i) => (
              <div key={i} style={{ display:"flex", gap:10, padding:"8px 0" }}>
                <div className="anical-skel" style={{ width:30, height:30, borderRadius:"50%", flexShrink:0 }}/>
                <div style={{ flex:1, display:"flex", flexDirection:"column", gap:6 }}>
                  <div className="anical-skel" style={{ height:10, borderRadius:4, width:"40%" }}/>
                  <div className="anical-skel" style={{ height:10, borderRadius:4, width:"75%" }}/>
                </div>
              </div>
            ))
          ) : comments.length === 0 ? (
            <div style={{ textAlign:"center" as const, padding:"22px 0", color:MT2, fontSize:12.5, lineHeight:1.5 }}>
              No comments yet — be the first to say something.
            </div>
          ) : (
            comments.map((c, i) => (
              <div key={c.id} style={{ display:"flex", gap:10, padding:"10px 0", borderTop: i === 0 ? "none" : `1px solid ${BD}`, animation:`cardIn .3s ${Math.min(i*30, 200)}ms both` } as React.CSSProperties}>
                <Avatar nickname={c.nickname} color={safeAvatarColor(c.avatar_color)} size={30}/>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"baseline", gap:6 }}>
                    <span style={{ fontSize:12, fontWeight:700, color:safeAvatarColor(c.avatar_color) }}>{c.nickname}</span>
                    <span style={{ fontSize:10, color:MT2 }}>{formatNewsAge(c.created_at)}</span>
                  </div>
                  <div style={{ fontSize:13, lineHeight:1.55, color:TX, marginTop:2, wordBreak:"break-word" as const }}>{c.message}</div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Composer / nickname prompt */}
        <div style={{ padding:"12px 16px 20px", background:BG3, borderTop:`1px solid ${BD}`, position:"sticky", bottom:0 } as React.CSSProperties}>
          {pickingNick ? (
            <div>
              <div style={{ fontSize:12, fontWeight:700, color:TX, marginBottom:6 }}>Pick a nickname to comment</div>
              <div style={{ display:"flex", gap:6 }}>
                <input
                  value={nickDraft}
                  onChange={(e) => setNickDraft(e.target.value.slice(0, 20))}
                  placeholder="e.g. OtakuPrime"
                  style={{ flex:1, background:BG2, border:`1px solid ${BD}`, borderRadius:10, padding:"9px 12px", color:TX, fontSize:13, fontFamily:"inherit", outline:"none" } as React.CSSProperties}
                />
                <button
                  onClick={confirmNick}
                  disabled={nickDraft.trim().length < 2}
                  style={{ padding:"9px 16px", borderRadius:10, border:"none", background: nickDraft.trim().length >= 2 ? `linear-gradient(135deg, ${OR}, #cc5610)` : BG4, color: nickDraft.trim().length >= 2 ? "#fff" : MT2, fontSize:12, fontWeight:700, cursor: nickDraft.trim().length >= 2 ? "pointer" : "default", fontFamily:"inherit" } as React.CSSProperties}
                >Save</button>
              </div>
            </div>
          ) : (
            <div style={{ display:"flex", gap:8, alignItems:"flex-end" }}>
              <Avatar nickname={nickname} color={avatarColor} size={32}/>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value.slice(0, 500))}
                placeholder="Add a comment…"
                rows={1}
                style={{ flex:1, background:BG2, border:`1px solid ${draft ? OR3 : BD}`, borderRadius:14, padding:"9px 12px", color:TX, fontSize:13, fontFamily:"inherit", resize:"none" as const, outline:"none", minHeight:38, maxHeight:120, lineHeight:1.45, transition:"border-color .2s" } as React.CSSProperties}
              />
              <button
                onClick={handleSend}
                disabled={!draft.trim() || sending}
                style={{ flexShrink:0, padding:"9px 14px", borderRadius:14, border:"none", background: draft.trim() ? `linear-gradient(135deg, ${OR}, #cc5610)` : BG4, color: draft.trim() ? "#fff" : MT2, fontSize:12, fontWeight:800, cursor: draft.trim() ? "pointer" : "default", fontFamily:"inherit" } as React.CSSProperties}
              >{sending ? "…" : "Post"}</button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ── Art upload sheet ───────────────────────────────────────────────────────────
function ArtUploadSheet({ open, onClose, allAnime, onUploaded, onToast }: {
  open: boolean;
  onClose: () => void;
  allAnime: Anime[];
  onUploaded: () => void;
  onToast: (m: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [animeQuery, setAnimeQuery] = useState("");
  const [selectedAnime, setSelectedAnime] = useState<Anime | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [nickname, setNickname] = useState<string>(() => LS.get<string>("anical_nickname", ""));
  const [nickDraft, setNickDraft] = useState("");
  const [pickingNick, setPickingNick] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const avatarColor = nickname ? getAvatarColor(nickname) : OR;
  const lastUploadAt = LS.get<number>("anical_last_art_upload", 0);
  const minutesSinceLastUpload = (Date.now() - lastUploadAt) / 60_000;
  const rateLimited = minutesSinceLastUpload < 5;

  useEffect(() => {
    if (!open) {
      // Reset when sheet closes
      setFile(null); setPreview(null); setCaption(""); setAnimeQuery(""); setSelectedAnime(null);
      setSubmitting(false); setPickingNick(false); setNickDraft("");
    }
  }, [open]);

  const animeSuggestions = useMemo(() => {
    const q = animeQuery.trim().toLowerCase();
    if (!q) return [];
    return allAnime.filter((a) => a.title.toLowerCase().includes(q)).slice(0, 5);
  }, [animeQuery, allAnime]);

  const onPickFile = () => inputRef.current?.click();
  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      onToast("Pick an image file");
      return;
    }
    if (f.size > 12 * 1024 * 1024) {
      onToast("Image must be smaller than 12 MB");
      return;
    }
    setFile(f);
    const url = URL.createObjectURL(f);
    setPreview(url);
  };

  const confirmNick = () => {
    const n = nickDraft.trim();
    if (n.length < 2) return;
    setNickname(n);
    LS.set("anical_nickname", n);
    setPickingNick(false);
  };

  const handleSubmit = async () => {
    if (!nickname) { setPickingNick(true); return; }
    if (!file) { onToast("Pick an image first"); return; }
    if (rateLimited) { onToast(`Wait ${Math.ceil(5 - minutesSinceLastUpload)} more min before posting again`); return; }
    setSubmitting(true);
    try {
      const compressed = await compressImage(file);
      const { url, path } = await uploadArtImage(compressed);
      await submitArtPost({
        anime_id: selectedAnime?.id ?? null,
        anime_title: selectedAnime?.title ?? null,
        nickname,
        avatar_color: avatarColor,
        image_url: url,
        storage_path: path,
        caption: caption.trim().slice(0, 500),
      });
      LS.set("anical_last_art_upload", Date.now());
      Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {});
      onToast("Submitted! Your post will appear once approved 🎨");
      onUploaded();
      onClose();
    } catch (err: any) {
      onToast(err?.message || "Upload failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <>
      <div onClick={onClose}
        style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.85)", zIndex:400, animation:"fadeIn .22s ease-out", backdropFilter:"blur(8px)" } as React.CSSProperties}/>
      <div role="dialog" aria-modal="true" aria-label="Share your art"
        style={{ position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)", width:"100%", maxWidth:480, background:BG2, borderRadius:"22px 22px 0 0", border:`1px solid ${BD}`, borderBottom:"none", maxHeight:"92vh", overflowY:"auto", zIndex:401, animation:"sheetUpScale .4s cubic-bezier(.2,.85,.2,1) both" } as React.CSSProperties}>
        <div style={{ width:40, height:4, background:BD2, borderRadius:2, margin:"12px auto 0" }}/>

        {/* Header */}
        <div style={{ padding:"14px 22px 10px", display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:36, height:36, borderRadius:10, background:`linear-gradient(135deg, ${OR}, #cc5610)`, display:"flex", alignItems:"center", justifyContent:"center" }}>
            <Icon name="upcoming" size={18} color="#fff"/>
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:18, fontWeight:900, color:TX, letterSpacing:"-.4px" }}>Share your art</div>
            <div style={{ fontSize:11, color:MT, marginTop:1 }}>Fan art, drawings, edits — show the community</div>
          </div>
          <button aria-label="Close" onClick={onClose} style={{ width:32, height:32, borderRadius:"50%", background:BG3, border:`1px solid ${BD}`, color:MT, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer" } as React.CSSProperties}>
            <Icon name="close" size={16} color={MT}/>
          </button>
        </div>

        <div style={{ padding:"6px 22px 36px" }}>
          {/* Image picker / preview */}
          <input ref={inputRef} type="file" accept="image/*" onChange={onFileChange} style={{ display:"none" }}/>
          {preview ? (
            <div style={{ position:"relative", marginBottom:14, borderRadius:14, overflow:"hidden", background:"#000" }}>
              <img src={preview} alt="Preview" style={{ width:"100%", maxHeight:380, objectFit:"contain", display:"block" } as React.CSSProperties}/>
              <button aria-label="Change image" onClick={onPickFile}
                style={{ position:"absolute", bottom:10, right:10, padding:"7px 12px", borderRadius:99, border:"1px solid rgba(255,255,255,.2)", background:"rgba(0,0,0,.65)", color:"#fff", fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"inherit", backdropFilter:"blur(8px)" } as React.CSSProperties}>Change</button>
            </div>
          ) : (
            <button onClick={onPickFile}
              style={{ width:"100%", padding:"40px 20px", borderRadius:14, border:`2px dashed ${BD2}`, background:BG3, color:MT, fontFamily:"inherit", display:"flex", flexDirection:"column" as const, alignItems:"center", gap:10, cursor:"pointer", marginBottom:14, transition:"border-color .2s" } as React.CSSProperties}>
              <div style={{ width:54, height:54, borderRadius:14, background:`linear-gradient(135deg, ${OR}, #cc5610)`, display:"flex", alignItems:"center", justifyContent:"center", boxShadow:`0 4px 14px rgba(255,107,26,.35)` } as React.CSSProperties}>
                <Icon name="upcoming" size={24} color="#fff"/>
              </div>
              <div style={{ fontSize:13.5, fontWeight:800, color:TX }}>Pick an image</div>
              <div style={{ fontSize:11, color:MT2, textAlign:"center" as const, lineHeight:1.55 }}>JPEG, PNG or WebP · up to 12 MB<br/>Compressed automatically before upload</div>
            </button>
          )}

          {/* Anime tag */}
          <div style={{ marginBottom:14 }}>
            <label style={{ fontSize:11, fontWeight:800, color:MT, letterSpacing:".5px", textTransform:"uppercase" as const, marginBottom:6, display:"block" }}>Tag an anime (optional)</label>
            {selectedAnime ? (
              <div style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 12px", background:OR2, border:`1px solid ${OR3}`, borderRadius:12 }}>
                {selectedAnime.image_url && <img src={selectedAnime.image_url} alt="" style={{ width:32, height:32, borderRadius:6, objectFit:"cover" } as React.CSSProperties}/>}
                <div style={{ flex:1, minWidth:0, fontSize:13, fontWeight:700, color:OR, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" as const }}>{selectedAnime.title}</div>
                <button onClick={() => { setSelectedAnime(null); setAnimeQuery(""); }} aria-label="Remove tag"
                  style={{ background:"transparent", border:"none", color:OR, cursor:"pointer", padding:4, display:"flex" }}>
                  <Icon name="close" size={14} color={OR}/>
                </button>
              </div>
            ) : (
              <div style={{ position:"relative" }}>
                <input
                  value={animeQuery}
                  onChange={(e) => setAnimeQuery(e.target.value)}
                  placeholder="Search anime…"
                  style={{ width:"100%", background:BG3, border:`1px solid ${BD}`, borderRadius:12, padding:"10px 12px", color:TX, fontSize:13, fontFamily:"inherit", outline:"none", boxSizing:"border-box" as const } as React.CSSProperties}
                />
                {animeSuggestions.length > 0 && (
                  <div style={{ position:"absolute", top:"100%", left:0, right:0, marginTop:4, background:BG3, border:`1px solid ${BD}`, borderRadius:12, overflow:"hidden", zIndex:1, maxHeight:220, overflowY:"auto" } as React.CSSProperties}>
                    {animeSuggestions.map((a) => (
                      <button key={a.id} onClick={() => { setSelectedAnime(a); setAnimeQuery(""); }}
                        style={{ display:"flex", alignItems:"center", gap:10, padding:"8px 12px", width:"100%", background:"transparent", border:"none", borderBottom:`1px solid ${BD}`, cursor:"pointer", fontFamily:"inherit", textAlign:"left" as const, color:TX } as React.CSSProperties}>
                        {a.image_url ? <img src={a.image_url} alt="" style={{ width:28, height:28, borderRadius:5, objectFit:"cover" }}/> : <div style={{ width:28, height:28, borderRadius:5, background:BG4 }}/>}
                        <span style={{ fontSize:12.5, color:TX, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" as const }}>{a.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Caption */}
          <div style={{ marginBottom:14 }}>
            <label style={{ fontSize:11, fontWeight:800, color:MT, letterSpacing:".5px", textTransform:"uppercase" as const, marginBottom:6, display:"block" }}>Caption</label>
            <textarea
              value={caption}
              onChange={(e) => setCaption(e.target.value.slice(0, 500))}
              placeholder="Tell us about your art…"
              rows={3}
              style={{ width:"100%", background:BG3, border:`1px solid ${BD}`, borderRadius:12, padding:"10px 12px", color:TX, fontSize:13, fontFamily:"inherit", resize:"vertical" as const, outline:"none", minHeight:78, maxHeight:200, lineHeight:1.55, boxSizing:"border-box" as const } as React.CSSProperties}
            />
            <div style={{ textAlign:"right" as const, fontSize:10, color:MT2, marginTop:2 }}>{caption.length} / 500</div>
          </div>

          {/* Guidelines */}
          <div style={{ padding:"10px 12px", borderRadius:12, background:"rgba(139,92,246,.08)", border:"1px solid rgba(139,92,246,.25)", marginBottom:14, fontSize:11, color:MT, lineHeight:1.6 }}>
            <strong style={{ color:"rgba(167,139,250,1)", fontWeight:800 }}>Community guidelines:</strong> only your own art or properly attributed fan art. No NSFW, hate speech, or unrelated content. Posts are reviewed before appearing. Violations get hidden after 3 reports.
          </div>

          {/* Nickname prompt or submit */}
          {pickingNick ? (
            <div>
              <div style={{ fontSize:12, fontWeight:700, color:TX, marginBottom:6 }}>Pick a nickname (shown on your posts)</div>
              <div style={{ display:"flex", gap:6 }}>
                <input
                  value={nickDraft}
                  onChange={(e) => setNickDraft(e.target.value.slice(0, 20))}
                  placeholder="e.g. OtakuPrime"
                  style={{ flex:1, background:BG3, border:`1px solid ${BD}`, borderRadius:12, padding:"10px 12px", color:TX, fontSize:13, fontFamily:"inherit", outline:"none" } as React.CSSProperties}
                />
                <button
                  onClick={confirmNick}
                  disabled={nickDraft.trim().length < 2}
                  style={{ padding:"10px 16px", borderRadius:12, border:"none", background: nickDraft.trim().length >= 2 ? `linear-gradient(135deg, ${OR}, #cc5610)` : BG4, color: nickDraft.trim().length >= 2 ? "#fff" : MT2, fontSize:13, fontWeight:800, cursor: nickDraft.trim().length >= 2 ? "pointer" : "default", fontFamily:"inherit" } as React.CSSProperties}
                >Save</button>
              </div>
            </div>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={submitting || !file || rateLimited}
              style={{ width:"100%", padding:"14px 18px", borderRadius:14, border:"none", background: (file && !submitting && !rateLimited) ? `linear-gradient(135deg, ${OR}, #cc5610)` : BG4, color: (file && !submitting && !rateLimited) ? "#fff" : MT2, fontSize:14.5, fontWeight:800, cursor: (file && !submitting && !rateLimited) ? "pointer" : "default", fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center", gap:8, boxShadow: (file && !submitting && !rateLimited) ? `0 8px 24px -6px rgba(255,107,26,.5)` : "none" } as React.CSSProperties}
            >
              {submitting ? "Uploading…" : rateLimited ? `Wait ${Math.ceil(5 - minutesSinceLastUpload)} min` : "Post art for review"}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

// ── Art feed view ──────────────────────────────────────────────────────────────
function ArtView({ allAnime, onOpenAnime, onToast }: { allAnime: Anime[]; onOpenAnime: (a: Anime) => void; onToast: (m: string) => void }) {
  const [posts, setPosts] = useState<ArtPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activePost, setActivePost] = useState<ArtPost | null>(null);
  const [showUpload, setShowUpload] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const p = await fetchArtPosts();
      setPosts(p);
    } catch (e: any) {
      // Detect "table doesn't exist" so we can show a friendly setup notice
      const msg = e?.message || "";
      if (msg.includes("404") || msg.includes("relation") || msg.includes("does not exist")) {
        setError("setup");
      } else {
        setError("network");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handlePostUpdated = (updated: ArtPost) => {
    setPosts((all) => all.map((p) => p.id === updated.id ? updated : p));
    setActivePost(updated);
  };

  return (
    <div style={{ padding:"4px 16px 24px" }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"flex-end", justifyContent:"space-between", padding:"8px 0 14px" }}>
        <div>
          <div style={{ fontSize:18, fontWeight:900, letterSpacing:"-.4px", color:TX }}>Art feed</div>
          <div style={{ fontSize:11.5, color:MT, marginTop:2 }}>Fan art, edits & illustrations from the community</div>
        </div>
        <div style={{ display:"flex", gap:6 }}>
          <button aria-label="Refresh art" onClick={load}
            style={{ background:BG3, border:`1px solid ${BD}`, color:MT, borderRadius:10, padding:"8px 11px", cursor:"pointer", display:"flex", alignItems:"center" } as React.CSSProperties}>
            <Icon name="refresh" size={14} color={MT}/>
          </button>
          <button aria-label="Share your art" onClick={() => { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); setShowUpload(true); }}
            style={{ background:`linear-gradient(135deg, ${OR}, #cc5610)`, border:"none", color:"#fff", borderRadius:10, padding:"8px 14px", cursor:"pointer", display:"flex", alignItems:"center", gap:5, fontFamily:"inherit", fontSize:12.5, fontWeight:800, boxShadow:`0 4px 14px -2px rgba(255,107,26,.45)` } as React.CSSProperties}>
            <Icon name="upcoming" size={14} color="#fff"/>
            <span>Post art</span>
          </button>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div style={{ display:"grid", gridTemplateColumns:"repeat(2, 1fr)", gap:6 }}>
          {[0,1,2,3,4,5].map((i) => <div key={i} className="anical-skel" style={{ aspectRatio:"1", borderRadius:10 }}/>)}
        </div>
      ) : error === "setup" ? (
        <div style={{ padding:"32px 22px", textAlign:"center" as const, background:"rgba(139,92,246,.06)", border:"1px solid rgba(139,92,246,.28)", borderRadius:18 } as React.CSSProperties}>
          <div style={{ width:64, height:64, borderRadius:"50%", background:"rgba(139,92,246,.15)", display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 14px" } as React.CSSProperties}>
            <Icon name="settings" size={28} color="rgba(167,139,250,1)"/>
          </div>
          <div style={{ fontSize:16, fontWeight:800, color:TX, marginBottom:6 }}>Art feed setup pending</div>
          <div style={{ fontSize:12.5, color:MT, lineHeight:1.65, maxWidth:300, margin:"0 auto 10px" }}>
            The art tables haven't been created in Supabase yet. The developer needs to run the one-time migration to enable this feature.
          </div>
        </div>
      ) : error === "network" ? (
        <div style={{ textAlign:"center" as const, padding:"40px 20px", color:MT }}>
          <Icon name="bellOff" size={42} color={MT2}/>
          <div style={{ fontSize:14, fontWeight:700, color:TX, marginTop:10, marginBottom:6 }}>Couldn't load art</div>
          <button onClick={load} style={{ marginTop:8, padding:"8px 18px", borderRadius:99, background:BG3, border:`1px solid ${BD}`, color:OR, fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"inherit" } as React.CSSProperties}>Try again</button>
        </div>
      ) : posts.length === 0 ? (
        <div style={{ padding:"36px 20px", textAlign:"center" as const, background:`linear-gradient(145deg, ${BG2}, ${BG3})`, border:`1px solid ${BD}`, borderRadius:18 } as React.CSSProperties}>
          <div style={{ width:64, height:64, borderRadius:"50%", background:OR2, display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 14px", border:`1px solid ${OR3}` } as React.CSSProperties}>
            <Icon name="upcoming" size={28} color={OR}/>
          </div>
          <div style={{ fontSize:16, fontWeight:800, color:TX, marginBottom:6 }}>Be the first</div>
          <div style={{ fontSize:12.5, color:MT, lineHeight:1.65, maxWidth:280, margin:"0 auto 16px" }}>
            No approved posts yet. Share your fan art and start the gallery.
          </div>
          <button onClick={() => setShowUpload(true)}
            style={{ padding:"10px 20px", borderRadius:99, border:"none", background:`linear-gradient(135deg, ${OR}, #cc5610)`, color:"#fff", fontSize:13, fontWeight:800, cursor:"pointer", fontFamily:"inherit", boxShadow:`0 6px 18px -4px rgba(255,107,26,.5)` } as React.CSSProperties}>
            Post the first art
          </button>
        </div>
      ) : (
        <div style={{ display:"grid", gridTemplateColumns:"repeat(2, 1fr)", gap:6 }}>
          {posts.map((p, i) => (
            <button key={p.id}
              onClick={() => { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); setActivePost(p); }}
              aria-label={`View art by ${p.nickname}${p.anime_title ? `, tagged ${p.anime_title}` : ""}`}
              style={{ position:"relative", padding:0, border:`1px solid ${BD}`, borderRadius:10, background:BG3, cursor:"pointer", overflow:"hidden", aspectRatio:"1", animation:`cardIn .35s ${Math.min(i*30, 400)}ms both` } as React.CSSProperties}>
              <img src={p.image_url} alt={p.caption || "Fan art"} loading="lazy" decoding="async"
                style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" } as React.CSSProperties}/>
              <div style={{ position:"absolute", inset:0, background:"linear-gradient(180deg, transparent 55%, rgba(0,0,0,.78))" }}/>
              <div style={{ position:"absolute", bottom:6, left:8, right:8, display:"flex", alignItems:"center", gap:6, fontSize:11, fontWeight:700, color:"#fff" }}>
                <Icon name="heartFilled" size={11} color="#fff"/>
                <span>{p.likes}</span>
                <Icon name="community" size={11} color="#fff" strokeWidth={2.2}/>
                <span>{p.comment_count}</span>
                {p.anime_title && <span style={{ marginLeft:"auto", maxWidth:90, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" as const, fontSize:9.5, opacity:.9 }}>{p.anime_title}</span>}
              </div>
            </button>
          ))}
        </div>
      )}

      {activePost && (
        <ArtPostSheet post={activePost} onClose={() => setActivePost(null)} onUpdated={handlePostUpdated}
          onOpenAnime={onOpenAnime} allAnime={allAnime} onToast={onToast}/>
      )}
      <ArtUploadSheet open={showUpload} onClose={() => setShowUpload(false)} allAnime={allAnime} onUploaded={load} onToast={onToast}/>
    </div>
  );
}

// ── Community view ─────────────────────────────────────────────────────────────
function CommunityView({ favAnime, allAnime, onOpenCommunity, onOpenAnime, onToast }: { favAnime: Anime[]; allAnime: Anime[]; onOpenCommunity: (a: Anime) => void; onOpenAnime: (a: Anime) => void; onToast: (m: string) => void }) {
  const [subView, setSubView] = useState<"discussions" | "art">(() => LS.get<"discussions" | "art">("anical_community_sub", "discussions"));
  useEffect(() => { LS.set("anical_community_sub", subView); }, [subView]);
  return (
    <div>
      {/* Sub-tabs */}
      <div style={{ display:"flex", gap:6, padding:"10px 16px 8px" }}>
        {([
          { id: "discussions" as const, icon: "community" as const, label: "Discussions" },
          { id: "art" as const, icon: "upcoming" as const, label: "Art" },
        ]).map((t) => {
          const active = subView === t.id;
          return (
            <button
              key={t.id}
              aria-pressed={active}
              onClick={() => { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); setSubView(t.id); }}
              style={{ flex:1, padding:"10px 14px", borderRadius:12, border:`1px solid ${active ? OR : BD}`, background: active ? OR2 : BG3, color: active ? OR : MT, fontSize:13, fontWeight:800, cursor:"pointer", fontFamily:"inherit", display:"inline-flex", alignItems:"center", justifyContent:"center", gap:7, transition:"all .18s", boxShadow: active ? `0 4px 14px -4px rgba(255,107,26,.35)` : "none" } as React.CSSProperties}
            >
              <Icon name={t.icon} size={15} color={active ? OR : MT}/>
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* Active sub-view */}
      <div key={subView} style={{ animation:"viewIn .25s cubic-bezier(.2,.7,.2,1) both" } as React.CSSProperties}>
        {subView === "discussions"
          ? <DiscussionsView favAnime={favAnime} allAnime={allAnime} onOpenCommunity={onOpenCommunity}/>
          : <ArtView allAnime={allAnime} onOpenAnime={onOpenAnime} onToast={onToast}/>}
      </div>
    </div>
  );
}

// ── Discussions view (extracted from old CommunityView) ────────────────────────
function DiscussionsView({ favAnime, allAnime, onOpenCommunity }: { favAnime: Anime[]; allAnime: Anime[]; onOpenCommunity: (a: Anime) => void }) {
  const [threads, setThreads] = useState<CommunityThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try { const t = await fetchCommunityThreads(); setThreads(t); } catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = search.trim()
    ? threads.filter((t) => t.anime_title.toLowerCase().includes(search.toLowerCase()))
    : threads;

  // Favorite anime that don't yet have a thread
  const threadIds = new Set(threads.map((t) => t.anime_id));
  const favWithoutThreads = favAnime.filter((a) => !threadIds.has(a.id));

  return (
    <div style={{ padding:"4px 16px 24px" }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"flex-end", justifyContent:"space-between", padding:"12px 0 14px" }}>
        <div>
          <div style={{ fontSize:22, fontWeight:900, letterSpacing:"-.5px" }}>Community</div>
          <div style={{ fontSize:12, color:MT, marginTop:2 }}>Per-anime discussion threads</div>
        </div>
        <button onClick={load} style={{ background:BG3, border:`1px solid ${BD}`, color:MT, borderRadius:10, padding:"7px 12px", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit" }}>↻</button>
      </div>

      {/* Search */}
      <div style={{ position:"relative", marginBottom:16 }}>
        <div style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)", pointerEvents:"none", color:MT2, display:"flex" }}>
          <Icon name="search" size={14} color={MT2} strokeWidth={2}/>
        </div>
        <input
          aria-label="Search anime communities"
          style={{ width:"100%", background:"rgba(255,255,255,0.06)", border:`1px solid ${search ? "rgba(255,107,26,.35)" : "rgba(255,255,255,0.09)"}`, borderRadius:12, padding:"10px 36px 10px 34px", color:TX, fontSize:14, fontFamily:"inherit", outline:"none", boxSizing:"border-box" } as React.CSSProperties}
          placeholder="Search anime communities…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && <button aria-label="Clear search" onClick={() => setSearch("")} style={{ position:"absolute", right:10, top:"50%", transform:"translateY(-50%)", background:"rgba(255,255,255,.12)", border:"none", color:MT, width:24, height:24, borderRadius:"50%", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"inherit" }}><Icon name="close" size={11} color={MT} strokeWidth={2.4}/></button>}
      </div>

      {/* Your Shows (fav anime) */}
      {favAnime.length > 0 && !search && (
        <div style={{ marginBottom:20 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10, fontSize:11, fontWeight:700, color:OR, textTransform:"uppercase" as const, letterSpacing:".8px" }}>
            <span>⭐</span><span>Your Shows</span>
            <div style={{ flex:1, height:1, background:BD }}/>
          </div>
          <div style={{ display:"flex", gap:8, overflowX:"auto", paddingBottom:4, scrollbarWidth:"none" } as React.CSSProperties}>
            {favAnime.slice(0, 10).map((a) => {
              const thread = threads.find((t) => t.anime_id === a.id);
              return (
                <div key={a.id}
                  onClick={() => onOpenCommunity(a)}
                  style={{ flexShrink:0, width:90, cursor:"pointer" }}>
                  <div style={{ position:"relative", width:90, height:120, borderRadius:10, overflow:"hidden", background:BG4, border:`1px solid ${thread ? "rgba(255,107,26,.3)" : BD}`, marginBottom:5 }}>
                    {a.image_url
                      ? <img src={a.image_url} alt="" style={{ width:"100%", height:"100%", objectFit:"cover" }}/>
                      : <div style={{ width:"100%", height:"100%", display:"flex", alignItems:"center", justifyContent:"center", fontSize:24 }}>🎬</div>}
                    {thread && (
                      <div style={{ position:"absolute", top:5, right:5, background:OR, borderRadius:99, fontSize:9, fontWeight:800, padding:"2px 6px", color:"#fff" }}>
                        {thread.post_count}
                      </div>
                    )}
                    <div style={{ position:"absolute", bottom:5, left:0, right:0, textAlign:"center", fontSize:9, fontWeight:800, color:"rgba(255,255,255,.65)" }}>💬</div>
                  </div>
                  <div style={{ fontSize:10, fontWeight:600, color:TX, lineHeight:1.3, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" as const, textAlign:"center" }}>{a.title}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Active threads */}
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10, fontSize:11, fontWeight:700, color:MT, textTransform:"uppercase" as const, letterSpacing:".8px" }}>
        <span>💬</span><span>Active Discussions</span>
        {!loading && <span style={{ fontSize:10, padding:"2px 7px", borderRadius:99, background:BG3, border:`1px solid ${BD}`, color:MT }}>{filtered.length}</span>}
        <div style={{ flex:1, height:1, background:BD }}/>
      </div>

      {loading ? (
        [0,1,2,3,4].map((i) => (
          <div key={i} style={{ display:"flex", gap:12, padding:12, background:BG2, border:`1px solid ${BD}`, borderRadius:14, marginBottom:8 }}>
            <div className="anical-skel" style={{ width:44, height:44, borderRadius:"50%", flexShrink:0 }}/>
            <div style={{ flex:1, display:"flex", flexDirection:"column", gap:7, justifyContent:"center" }}>
              <div className="anical-skel" style={{ height:13, borderRadius:4, width:"60%" }}/>
              <div className="anical-skel" style={{ height:10, borderRadius:4, width:"35%" }}/>
            </div>
          </div>
        ))
      ) : filtered.length === 0 ? (
        <div style={{ textAlign:"center", padding:"40px 20px", color:MT }}>
          <div style={{ fontSize:48, marginBottom:12 }}>💬</div>
          <div style={{ fontSize:15, fontWeight:700, marginBottom:6 }}>No discussions yet</div>
          <div style={{ fontSize:12, color:MT2 }}>Open any anime and tap 💬 Community to start the first thread.</div>
        </div>
      ) : (
        filtered.map((t, i) => {
          const favMatch = favAnime.find((a) => a.id === t.anime_id);
          // Look up full anime data (schedule > favs) to get genres, image, etc.
          const animeData = allAnime.find((a) => a.id === t.anime_id) ?? favMatch;
          const genres = animeData?.genres?.slice(0, 2) ?? [];
          return (
            <div key={t.anime_id}
              onClick={() => onOpenCommunity({ id:t.anime_id, title:t.anime_title, image_url: animeData?.image_url ?? null, genres: animeData?.genres })}
              style={{ display:"flex", alignItems:"center", gap:12, padding:"11px 14px", background:BG2, border:`1px solid ${BD}`, borderRadius:14, marginBottom:8, cursor:"pointer", animation:`cardIn .35s ${Math.min(i*30,300)}ms both`, transition:"transform .15s" }}
              className="anical-card">
              {animeData?.image_url
                ? <img src={animeData.image_url} alt="" style={{ width:44, height:44, borderRadius:"50%", objectFit:"cover", flexShrink:0, border:`1px solid ${BD2}` }}/>
                : <div style={{ width:44, height:44, borderRadius:"50%", background:`linear-gradient(135deg, #7c3aed, #4f46e5)`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, flexShrink:0 }}>💬</div>}
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:13, fontWeight:700, color:TX, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" as const }}>{t.anime_title}</div>
                <div style={{ fontSize:10, color:MT2, marginTop:2 }}>{formatNewsAge(t.last_post)} · {t.post_count} post{t.post_count === 1 ? "" : "s"}</div>
                {genres.length > 0 && (
                  <div style={{ display:"flex", gap:4, marginTop:4, flexWrap:"wrap" }}>
                    {genres.map((g) => (
                      <span key={g} style={{ fontSize:9, fontWeight:700, padding:"2px 6px", borderRadius:4, background:BG3, border:`1px solid ${BD}`, color:MT, letterSpacing:".2px" }}>{g}</span>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ flexShrink:0, background:"rgba(139,92,246,.15)", border:"1px solid rgba(139,92,246,.3)", borderRadius:8, padding:"4px 9px", fontSize:11, fontWeight:800, color:"rgba(167,139,250,1)" }}>
                {t.post_count}
              </div>
            </div>
          );
        })
      )}

      {/* Suggest starting threads for favorites */}
      {!loading && favWithoutThreads.length > 0 && !search && (
        <div style={{ marginTop:16 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10, fontSize:11, fontWeight:700, color:MT2, textTransform:"uppercase" as const, letterSpacing:".8px" }}>
            <span>🌱</span><span>Start a thread</span>
            <div style={{ flex:1, height:1, background:BD }}/>
          </div>
          {favWithoutThreads.slice(0, 4).map((a, i) => (
            <div key={a.id}
              onClick={() => onOpenCommunity(a)}
              style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 14px", background:BG2, border:`1px solid ${BD}`, borderRadius:12, marginBottom:6, cursor:"pointer", animation:`cardIn .3s ${i*30}ms both` }}
              className="anical-card">
              {a.image_url
                ? <img src={a.image_url} alt="" style={{ width:36, height:36, borderRadius:8, objectFit:"cover", flexShrink:0 }}/>
                : <div style={{ width:36, height:36, borderRadius:8, background:BG4, display:"flex", alignItems:"center", justifyContent:"center", fontSize:16, flexShrink:0 }}>🎬</div>}
              <div style={{ flex:1, fontSize:13, fontWeight:600, color:MT }}>{a.title}</div>
              <div style={{ fontSize:11, color:MT2 }}>Be first →</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── News view ──────────────────────────────────────────────────────────────────
const RUMOR_KEYWORDS = ["rumor", "rumour", "leak", "leaked", "allegedly", "unconfirmed", "insider", "report claims", "reportedly", "source says", "sources say", "it is said"];

function NewsView({ favAnime, noSpoiler }: { favAnime: any[]; noSpoiler: boolean }) {
  const [annNews, setAnnNews] = useState<NewsItem[]>([]);
  const [favNews, setFavNews] = useState<NewsItem[]>([]);
  const [annLoading, setAnnLoading] = useState(true);
  const [favLoading, setFavLoading] = useState(true);
  const [annError, setAnnError] = useState(false);
  const [detailNews, setDetailNews] = useState<NewsItem | null>(null);
  const [rumorRevealed, setRumorRevealed] = useState(false);

  const loadAnn = () => {
    setAnnLoading(true); setAnnError(false);
    const cached = LS.get<{ ts: number; data: NewsItem[] } | null>("anical_ann_news", null);
    if (cached && Date.now() - cached.ts < NEWS_TTL) { setAnnNews(cached.data); setAnnLoading(false); return; }
    fetchAnnNews()
      .then((items) => { setAnnNews(items); LS.set("anical_ann_news", { ts: Date.now(), data: items }); })
      .catch(() => setAnnError(true))
      .finally(() => setAnnLoading(false));
  };

  useEffect(() => { loadAnn(); }, []);

  useEffect(() => {
    if (favAnime.length === 0) { setFavLoading(false); return; }
    const top = favAnime.slice(0, 3);
    const key = `anical_fav_news_${top.map((a: any) => a.id).join("_")}`;
    const cached = LS.get<{ ts: number; data: NewsItem[] } | null>(key, null);
    if (cached && Date.now() - cached.ts < NEWS_TTL) { setFavNews(cached.data); setFavLoading(false); return; }
    Promise.all(top.map((a: any) => fetchAnimeNewsItems(a)))
      .then((results) => { const all = results.flat(); setFavNews(all); LS.set(key, { ts: Date.now(), data: all }); })
      .finally(() => setFavLoading(false));
  }, [favAnime]);

  const SectionHeader = ({ icon, title, count, accent }: { icon: IconName; title: string; count?: number; accent?: boolean }) => (
    <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:12, fontSize:12, fontWeight:700, color: accent ? OR : MT, textTransform:"uppercase" as const, letterSpacing:".8px" }}>
      <Icon name={icon} size={15} color={accent ? OR : MT} strokeWidth={2.2}/>
      <span>{title}</span>
      {count !== undefined && <span style={{ fontSize:10, padding:"2px 7px", borderRadius:99, background: accent ? OR2 : BG3, border:`1px solid ${accent ? OR3 : BD}`, color: accent ? OR : MT }}>{count}</span>}
      <div style={{ flex:1, height:1, background:BD }}/>
    </div>
  );

  return (
    <div style={{ padding:"4px 16px 24px" }}>
      <div style={{ display:"flex", alignItems:"flex-end", justifyContent:"space-between", padding:"12px 0 16px" }}>
        <div>
          <div style={{ fontSize:22, fontWeight:900, letterSpacing:"-.5px" }}>News</div>
          <div style={{ fontSize:12, color:MT, marginTop:2 }}>Industry news & updates for your shows</div>
        </div>
        <button aria-label="Refresh news" onClick={() => { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); loadAnn(); }}
          style={{ background:BG3, border:`1px solid ${BD}`, color:MT, borderRadius:10, padding:"8px 12px", cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center" }}>
          <Icon name="refresh" size={16} color={MT}/>
        </button>
      </div>

      {/* ── Your Shows News ── */}
      {favAnime.length > 0 && (
        <div style={{ marginBottom:28 }}>
          <SectionHeader icon="starFilled" title="Your Shows" count={favNews.length} accent/>
          {favLoading ? [0,1,2].map((i) => <NewsSkeleton key={i}/>) :
           favNews.length === 0 ? <div style={{ textAlign:"center", padding:"20px 0", color:MT, fontSize:13 }}>No recent news for your shows.</div> :
           favNews.map((n, i) => <NewsCard key={n.id} item={n} delay={i * 25} onOpen={setDetailNews}/>)}
        </div>
      )}

      {/* ── Industry News ── */}
      <div>
        <SectionHeader icon="trending" title="Industry News" count={!annLoading ? annNews.length : undefined}/>
        {annLoading ? [0,1,2,3].map((i) => <NewsSkeleton key={i}/>) :
         annError ? (
           <div style={{ textAlign:"center", padding:"32px 0", color:MT, display:"flex", flexDirection:"column", alignItems:"center", gap:10 }}>
             <div style={{ fontSize:32 }}>📡</div>
             <div style={{ fontSize:13 }}>Couldn't reach the news feed.</div>
             <button onClick={loadAnn} style={{ background:BG3, border:`1px solid ${OR}`, color:OR, borderRadius:8, padding:"7px 16px", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit" }}>Retry</button>
           </div>
         ) :
         annNews.filter((n) => !RUMOR_KEYWORDS.some((kw) => n.title.toLowerCase().includes(kw) || (n.excerpt || "").toLowerCase().includes(kw)))
           .map((n, i) => <NewsCard key={n.id} item={n} delay={i * 20} onOpen={setDetailNews}/>)}
      </div>

      {/* ── Rumors & Leaks ── */}
      {(() => {
        const rumors = annNews.filter((n) =>
          RUMOR_KEYWORDS.some((kw) => n.title.toLowerCase().includes(kw) || (n.excerpt || "").toLowerCase().includes(kw))
        );
        if (rumors.length === 0 && !annLoading) return null;
        const blocked = noSpoiler && !rumorRevealed;
        return (
          <div style={{ marginTop:24 }}>
            <SectionHeader icon="spoiler" title="Rumors & Leaks" count={!annLoading ? rumors.length : undefined}/>
            {blocked ? (
              <div style={{ borderRadius:14, border:`1px solid rgba(139,92,246,.35)`, background:"rgba(139,92,246,.07)", padding:"20px 16px", textAlign:"center" }}>
                <div style={{ fontSize:26, marginBottom:8 }}>🙈</div>
                <div style={{ fontSize:13, fontWeight:700, color:TX, marginBottom:4 }}>No-spoiler mode is on</div>
                <div style={{ fontSize:12, color:MT, marginBottom:14, lineHeight:1.5 }}>
                  Rumors & leaks are hidden to keep your experience spoiler-free.<br/>
                  Toggle the <strong style={{ color:"rgba(167,139,250,1)" }}>eye icon</strong> in the header to show them globally, or tap below to reveal once.
                </div>
                <button
                  onClick={() => setRumorRevealed(true)}
                  style={{ background:"rgba(139,92,246,.18)", border:"1px solid rgba(139,92,246,.4)", color:"rgba(167,139,250,1)", borderRadius:10, padding:"9px 20px", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}
                >
                  Reveal rumors for this session
                </button>
              </div>
            ) : (
              annLoading ? [0,1].map((i) => <NewsSkeleton key={i}/>) :
              rumors.length === 0 ? (
                <div style={{ textAlign:"center", padding:"20px 0", color:MT, fontSize:13 }}>No rumors in the current feed.</div>
              ) : rumors.map((n, i) => (
                <NewsCard key={n.id} item={n} delay={i * 25} onOpen={setDetailNews}/>
              ))
            )}
          </div>
        );
      })()}

      {/* ── News detail sheet ── */}
      {detailNews && <NewsDetailSheet item={detailNews} onClose={() => setDetailNews(null)}/>}
    </div>
  );
}

// ── Fav card ───────────────────────────────────────────────────────────────────
function FavCard({ anime, delay, tz, notifEnabled, perAnimeNotif, toggleAnimeNotif, onOpen, onRemove, tick }: any) {
  void tick;
  const next: Date | null = anime.__next;
  const now = new Date();
  const diffMs = next ? next.getTime() - now.getTime() : null;
  const isLive = diffMs !== null && diffMs < 0 && diffMs > -30 * 60_000;
  const isSoon = diffMs !== null && diffMs > 0 && diffMs < 12 * 3600_000;
  const countdown = next ? formatCountdown(next, now) : null;
  const localTime = jstToLocal(anime.broadcast_time, tz);
  const dayLabel = anime.broadcast_day ? (DAY_SHORT[DAYS.indexOf(anime.broadcast_day as any)] || anime.broadcast_day.slice(0, 3)) : null;

  const accentColor = isLive ? GR : isSoon ? OR : BD;
  const cardBg = isLive ? "rgba(34,197,94,.07)" : isSoon ? OR2 : BG2;
  const cardBorder = isLive ? "rgba(34,197,94,.35)" : isSoon ? OR3 : BD;

  return (
    <div onClick={() => onOpen(anime)} style={{ position:"relative", display:"flex", gap:12, padding:12, background:cardBg, border:`1px solid ${cardBorder}`, borderRadius:14, cursor:"pointer", overflow:"hidden", animation:`cardIn .35s ${Math.min(delay, 360)}ms both` }}>
      {/* Timing accent bar at top */}
      <div style={{ position:"absolute", top:0, left:0, right:0, height:2, background: accentColor, opacity: isLive || isSoon ? 1 : 0 }}/>
      {isLive && <div className="anical-pulse" style={{ position:"absolute", top:12, right:12, width:7, height:7, borderRadius:"50%", background:GR }}/>}
      <div style={{ position:"relative", flexShrink:0, width:68, height:92, borderRadius:10, overflow:"hidden", background:BG4 }}>
        {anime.image_url
          ? <img src={anime.image_url} alt="" loading="lazy" style={{ width:"100%", height:"100%", objectFit:"cover" }}/>
          : <div style={{ width:"100%", height:"100%", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22 }}>🎬</div>}
        <div style={{ position:"absolute", inset:0, background:"linear-gradient(180deg, transparent 50%, rgba(0,0,0,.75))" }}/>
        {anime.score && <div style={{ position:"absolute", bottom:4, left:4, right:4, fontSize:10, fontWeight:800, color:"#fff", textAlign:"center" }}>★ {anime.score}</div>}
      </div>
      <div style={{ flex:1, minWidth:0, display:"flex", flexDirection:"column", justifyContent:"space-between", padding:"2px 0" }}>
        <div>
          <div style={{ fontSize:14, fontWeight:700, lineHeight:1.25, color:TX, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" as const, marginBottom:6 }}>{anime.title}</div>
          <div style={{ display:"flex", gap:5, flexWrap:"wrap" as const, alignItems:"center" }}>
            {countdown && (
              <span style={{ fontSize:11, fontWeight:800, padding:"3px 9px", borderRadius:99, background: isLive ? "rgba(34,197,94,.18)" : isSoon ? OR2 : BG3, color: isLive ? GR : isSoon ? OR : MT, border:`1px solid ${isLive ? "rgba(34,197,94,.4)" : isSoon ? OR3 : BD}`, letterSpacing:".2px" }}>
                {isLive ? "● LIVE NOW" : countdown}
              </span>
            )}
            {dayLabel && <span style={{ fontSize:10, color:MT, fontWeight:700, textTransform:"uppercase", letterSpacing:".6px", padding:"3px 7px", borderRadius:6, background:BG3, border:`1px solid ${BD}` }}>{dayLabel}</span>}
            {anime.genres?.[0] && <span style={{ fontSize:10, color:MT, padding:"3px 7px", borderRadius:6, background:BG3, border:`1px solid ${BD}` }}>{anime.genres[0]}</span>}
          </div>
        </div>
        {anime.broadcast_time && (
          <div style={{ fontSize:11, fontWeight:600, marginTop:8, display:"flex", alignItems:"center", gap:4 }}>
            <span style={{ color:OR, fontWeight:700 }}>{localTime}</span>
            <span style={{ color:MT2 }}>· {anime.broadcast_time} JST</span>
            {anime.episodes && <span style={{ color:MT2 }}>· {anime.episodes} eps</span>}
          </div>
        )}
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:6, alignItems:"center", paddingTop:2 }}>
        <button onClick={(e) => { e.stopPropagation(); toggleAnimeNotif(); }} style={{ background: notifEnabled && perAnimeNotif ? OR2 : "none", border:`1px solid ${notifEnabled && perAnimeNotif ? OR3 : BD}`, color: notifEnabled && perAnimeNotif ? OR : MT2, fontSize:14, cursor:"pointer", fontFamily:"inherit", padding:"5px 7px", lineHeight:1, borderRadius:8, opacity: notifEnabled ? 1 : .4 }}>
          {perAnimeNotif ? "🔔" : "🔕"}
        </button>
        <button onClick={(e) => { e.stopPropagation(); onRemove(); }} style={{ background:"none", border:`1px solid ${BD}`, color:MT2, fontSize:13, cursor:"pointer", fontFamily:"inherit", padding:"4px 7px", lineHeight:1, borderRadius:8 }}>✕</button>
      </div>
    </div>
  );
}

// ── My List view ───────────────────────────────────────────────────────────────
function MyListView({ favAnime, todayDayIdx, tz, favs, totalAnime, airingToday, topGenre, notifSettings, setNotifSettings, notifPerm, requestNotifPerm, testNotif, onOpen, toggleFav, installPwa, downloadExtension, tick }: any) {
  const now = new Date();
  const withNext = favAnime.map((a: any) => ({ ...a, __next: nextJstAiringDate(a.broadcast_day, a.broadcast_time) }))
    .sort((a: any, b: any) => {
      if (!a.__next && !b.__next) return 0;
      if (!a.__next) return 1; if (!b.__next) return -1;
      return a.__next.getTime() - b.__next.getTime();
    });

  const myTodayCount = favAnime.filter((a: any) => a.dayIdx === todayDayIdx).length;
  const myPerDay = DAYS.map((_, i) => favAnime.filter((a: any) => a.dayIdx === i).length);

  const buckets: Record<string, any[]> = { live:[], soon:[], today:[], week:[], later:[], unknown:[] };
  for (const a of withNext) {
    if (!a.__next) { buckets.unknown.push(a); continue; }
    const diff = a.__next.getTime() - now.getTime();
    if (diff < 0 && diff > -30 * 60_000) buckets.live.push(a);
    else if (diff < 0) buckets.later.push(a);
    else if (diff < 12 * 3600_000) buckets.soon.push(a);
    else if (diff < 24 * 3600_000) buckets.today.push(a);
    else if (diff < 7 * 24 * 3600_000) buckets.week.push(a);
    else buckets.later.push(a);
  }

  const sections = [
    { key:"live",    title:"Airing now",       emoji:"🔴", items:buckets.live,    accent:true },
    { key:"soon",    title:"Next 12 hours",    emoji:"⏰", items:buckets.soon,    accent:true },
    { key:"today",   title:"Later today",      emoji:"🌅", items:buckets.today },
    { key:"week",    title:"This week",        emoji:"📅", items:buckets.week },
    { key:"later",   title:"Coming up",        emoji:"🗓️", items:buckets.later },
    { key:"unknown", title:"Schedule unknown", emoji:"❓", items:buckets.unknown },
  ];

  const notifEnabled = notifSettings.enabled && notifPerm === "granted";

  return (
    <div style={{ padding:"4px 16px 24px" }}>
      {/* Hero */}
      <div style={{ position:"relative", overflow:"hidden", background:`linear-gradient(135deg, ${OR} 0%, #b84c0f 100%)`, borderRadius:18, padding:"20px 18px", marginBottom:14, boxShadow:`0 16px 40px -12px rgba(255,107,26,.5)` }}>
        <div style={{ position:"absolute", top:-30, right:-30, width:140, height:140, borderRadius:"50%", background:"rgba(255,255,255,.1)" }}/>
        <div style={{ position:"absolute", bottom:-50, right:30, width:90, height:90, borderRadius:"50%", background:"rgba(255,255,255,.07)" }}/>
        <div style={{ position:"relative" }}>
          <div style={{ fontSize:11, fontWeight:700, color:"rgba(255,255,255,.75)", letterSpacing:"1.2px", textTransform:"uppercase", marginBottom:4 }}>My Watchlist</div>
          <div style={{ fontSize:46, fontWeight:900, color:"#fff", lineHeight:1, letterSpacing:"-2px" }}>
            {favs.length}<span style={{ fontSize:18, fontWeight:700, opacity:.75, marginLeft:8 }}>shows</span>
          </div>
          <div style={{ fontSize:13, color:"rgba(255,255,255,.9)", marginTop:8, fontWeight:500 }}>
            {buckets.live.length > 0 ? `🔴 ${buckets.live.length} airing right now`
              : buckets.soon.length > 0 ? `⏰ ${buckets.soon.length} up in the next 12 hours`
              : myTodayCount > 0 ? `📡 ${myTodayCount} of your shows air today`
              : favs.length > 0 ? "Nothing from your list airs today"
              : "Add shows to start tracking them"}
          </div>
        </div>
      </div>

      {/* Personal stats — all user-specific */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:10 }}>
        {[
          { v: favs.length,                                              l:"Tracking",  icon:"⭐" },
          { v: myTodayCount > 0 ? myTodayCount : "–",                   l:"Today",     icon:"📡" },
          { v: topGenre,                                                 l:"Top Genre", icon:"🎭", small: typeof topGenre === "string" && topGenre.length > 6 },
        ].map((stat, i) => (
          <div key={i} style={{ background:BG2, border:`1px solid ${BD}`, borderRadius:14, padding:"14px 10px", display:"flex", flexDirection:"column", gap:4 }}>
            <div style={{ fontSize:16, opacity:.65 }}>{stat.icon}</div>
            <div style={{ fontSize: stat.small ? 13 : 24, fontWeight:800, color:TX, lineHeight:1.1, whiteSpace:"nowrap" as const, overflow:"hidden", textOverflow:"ellipsis" }}>{stat.v}</div>
            <div style={{ fontSize:10, color:MT, fontWeight:600, textTransform:"uppercase" as const, letterSpacing:".5px" }}>{stat.l}</div>
          </div>
        ))}
      </div>

      {/* Weekly activity strip */}
      <div style={{ display:"flex", gap:4, marginBottom:10 }}>
        {DAYS.map((d, i) => {
          const count = myPerDay[i];
          const isToday = i === todayDayIdx;
          return (
            <div key={d} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:3, padding:"7px 2px", borderRadius:10, background: isToday ? OR2 : count > 0 ? BG3 : BG2, border:`1px solid ${isToday ? OR3 : count > 0 ? BD2 : "transparent"}`, transition:"background .2s" }}>
              <div style={{ fontSize:8, fontWeight:800, color:isToday ? OR : MT, textTransform:"uppercase" as const, letterSpacing:".5px" }}>{DAY_SHORT[i].slice(0,2)}</div>
              <div style={{ fontSize:count > 0 ? 15 : 11, fontWeight:800, color:count > 0 ? (isToday ? OR : TX) : MT2, lineHeight:1 }}>{count > 0 ? count : "·"}</div>
            </div>
          );
        })}
      </div>

      {/* Global season context */}
      <div style={{ textAlign:"center", fontSize:11, color:MT2, marginBottom:18, padding:"6px 0", borderBottom:`1px solid ${BD}` }}>
        {totalAnime} shows in the current season · {airingToday} airing today
      </div>

      {favAnime.length > 0 && (
        <NotifBanner notifPerm={notifPerm} notifEnabled={notifEnabled} notifSettings={notifSettings} setNotifSettings={setNotifSettings} requestNotifPerm={requestNotifPerm} testNotif={testNotif}/>
      )}

      <div style={{ display:"flex", alignItems:"baseline", justifyContent:"space-between", marginTop:20, marginBottom:12 }}>
        <div style={{ fontSize:17, fontWeight:800, letterSpacing:"-.3px" }}>Watchlist</div>
        {favAnime.length > 0 && <div style={{ fontSize:11, color:MT2, fontWeight:600 }}>{favAnime.length} title{favAnime.length===1?"":"s"}</div>}
      </div>

      {favAnime.length === 0 ? (
        <div style={{ padding:"40px 20px", textAlign:"center", borderRadius:18, background:`linear-gradient(145deg, ${BG2}, ${BG3})`, border:`1px solid ${BD}` }}>
          <div style={{ fontSize:52, marginBottom:12 }}>⭐</div>
          <div style={{ fontSize:16, fontWeight:800, marginBottom:8 }}>Your watchlist is empty</div>
          <div style={{ fontSize:13, color:MT, lineHeight:1.65, marginBottom:16 }}>
            Tap <span style={{ color:OR, fontWeight:700 }}>☆</span> on any anime in the Schedule<br/>to start tracking it here.
          </div>
          <div style={{ padding:"10px 14px", background:OR2, border:`1px solid ${OR3}`, borderRadius:12, fontSize:12, color:OR, fontWeight:600, lineHeight:1.5 }}>
            You'll see live countdowns and can get notified when your shows air.
          </div>
        </div>
      ) : (
        sections.filter((sec) => sec.items.length > 0).map((sec) => (
          <div key={sec.key} style={{ marginBottom:20 }}>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10, fontSize:12, fontWeight:700, color: sec.accent ? OR : MT, textTransform:"uppercase" as const, letterSpacing:".8px" }}>
              <span style={{ fontSize:14 }}>{sec.emoji}</span>
              <span>{sec.title}</span>
              <span style={{ fontSize:10, padding:"2px 7px", borderRadius:99, background: sec.accent ? OR2 : BG3, border:`1px solid ${sec.accent ? OR3 : BD}`, color: sec.accent ? OR : MT }}>{sec.items.length}</span>
              <div style={{ flex:1, height:1, background:BD }}/>
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr", gap:8 }}>
              {sec.items.map((a: any, i: number) => (
                <FavCard key={a.id} anime={a} delay={i * 30} tz={tz} notifEnabled={notifEnabled}
                  perAnimeNotif={notifSettings.perAnime[a.id] !== false}
                  toggleAnimeNotif={() => setNotifSettings((s: NotifSettings) => ({ ...s, perAnime: { ...s.perAnime, [a.id]: s.perAnime[a.id] === false } }))}
                  onOpen={onOpen} onRemove={() => toggleFav(a.id)} tick={tick}/>
              ))}
            </div>
          </div>
        ))
      )}

      {/* Settings now lives in the header gear → SettingsSheet. */}

    </div>
  );
}

// Reusable settings row with an iOS-style toggle. Keeps the look consistent across the panel.
function SettingRow({ icon, label, description, checked, onToggle, toggleLabel, last }: { icon: IconName; label: string; description: string; checked: boolean; onToggle: () => void; toggleLabel: string; last?: boolean }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:14, padding:"14px 16px", borderBottom: last ? "none" : `1px solid ${BD}` }}>
      <div style={{ width:36, height:36, borderRadius:10, background:BG3, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, color: checked ? OR : MT }}>
        <Icon name={icon} size={18} color={checked ? OR : MT}/>
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:13.5, fontWeight:700, color:TX, letterSpacing:"-.05px" }}>{label}</div>
        <div style={{ fontSize:11, color:MT, marginTop:2 }}>{description}</div>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={toggleLabel}
        onClick={onToggle}
        style={{
          flexShrink:0, position:"relative",
          width:44, height:26, borderRadius:99,
          border:"none", padding:0, cursor:"pointer", fontFamily:"inherit",
          background: checked ? `linear-gradient(135deg, ${OR}, #cc5610)` : BG4,
          transition:"background .22s",
          boxShadow: checked ? `0 0 12px rgba(255,107,26,.3)` : "none",
        } as React.CSSProperties}
      >
        <div style={{
          position:"absolute", top:2, left: checked ? 20 : 2,
          width:22, height:22, borderRadius:"50%",
          background:"#fff", transition:"left .22s cubic-bezier(.2,.7,.2,1)",
          boxShadow:"0 2px 4px rgba(0,0,0,.25)",
        } as React.CSSProperties}/>
      </button>
    </div>
  );
}

// ── Bottom nav ─────────────────────────────────────────────────────────────────
// Scrollable, interactive, icon-driven. Each tab uses SVG icons that fill in
// when active. Animated underline glides between tabs. The Community tab is
// hidden when the user opts out in settings.
type NavId = "schedule"|"month"|"community"|"news"|"stats";

function BottomNav({ view, setView, favCount, hideCommunity }: { view: string; setView: (v: NavId) => void; favCount: number; hideCommunity: boolean }) {
  type Tab = { id: NavId; icon: IconName; activeIcon?: IconName; label: string; accent?: string };
  const allTabs: Tab[] = [
    { id:"schedule",  icon:"calendar",  label:"Schedule"  },
    { id:"month",     icon:"upcoming",  label:"Upcoming"  },
    { id:"community", icon:"community", label:"Community" },
    { id:"news",      icon:"news",      label:"News"      },
    { id:"stats",     icon:"star", activeIcon:"starFilled", label:"My List", accent: OR },
  ];
  const tabs: Tab[] = allTabs.filter((t) => !(t.id === "community" && hideCommunity));

  return (
    <nav
      className="anical-bottom-nav"
      aria-label="Primary navigation"
      style={{
        position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)",
        width:"100%", maxWidth:480, zIndex:100,
        background:"var(--c-nav)", backdropFilter:"blur(28px) saturate(1.5)",
        borderTop:`1px solid ${BD}`,
        display:"flex", overflowX:"auto", scrollbarWidth:"none",
        WebkitOverflowScrolling:"touch",
      } as React.CSSProperties}
    >
      {tabs.map((tab) => {
        const active = view === tab.id;
        const iconName = active && tab.activeIcon ? tab.activeIcon : tab.icon;
        const color = active ? OR : MT2;
        return (
          <button
            key={tab.id}
            className="anical-navbtn"
            aria-label={`Open ${tab.label}`}
            aria-current={active ? "page" : undefined}
            onClick={() => { if (!active) Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); setView(tab.id); }}
            style={{
              flex:"1 0 auto", minWidth:72,
              background:"none", border:"none", cursor:"pointer", fontFamily:"inherit",
              display:"flex", flexDirection:"column", alignItems:"center", gap:4,
              padding:"10px 6px 12px", position:"relative",
              transition:"transform .15s",
            } as React.CSSProperties}
          >
            {/* Top accent bar */}
            <div style={{
              position:"absolute", top:0, left:"50%",
              transform:`translateX(-50%) scaleX(${active ? 1 : 0})`,
              width:32, height:3, background:OR, borderRadius:"0 0 3px 3px",
              transformOrigin:"center", transition:"transform .25s cubic-bezier(.2,.7,.2,1)",
            } as React.CSSProperties}/>

            {/* Active glow pill behind icon */}
            <div style={{
              position:"relative",
              width:38, height:38, borderRadius:12,
              display:"flex", alignItems:"center", justifyContent:"center",
              background: active ? "rgba(255,107,26,.12)" : "transparent",
              border: active ? `1px solid ${OR3}` : "1px solid transparent",
              transition:"all .22s cubic-bezier(.2,.7,.2,1)",
              transform: active ? "scale(1)" : "scale(.95)",
            }}>
              <Icon name={iconName} size={20} color={color} strokeWidth={active ? 2.2 : 1.9}/>
              {/* Badge */}
              {tab.id === "stats" && favCount > 0 && (
                <span style={{
                  position:"absolute", top:-3, right:-4,
                  background:OR, color:"#fff",
                  fontSize:9, fontWeight:800, padding:"1px 5px",
                  borderRadius:99, lineHeight:1.4,
                  animation: `popIn .3s cubic-bezier(.2,.7,.2,1) both`,
                  border:`2px solid ${BG}`,
                } as React.CSSProperties}>{favCount}</span>
              )}
            </div>

            <span style={{
              fontSize:10, fontWeight:700, letterSpacing:".5px", textTransform:"uppercase",
              color: active ? OR : MT2, transition:"color .2s",
              whiteSpace:"nowrap",
            } as React.CSSProperties}>{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}


// ── Settings sheet ─────────────────────────────────────────────────────────────
// Opens from the header gear. Houses all global preferences in one place so the
// header stays uncluttered and My List stops being a junk-drawer for settings.
function SettingsSheet({ open, onClose, dark, setDark, noSpoiler, setNoSpoiler, hideCommunity, setHideCommunity, streamOffsetMin, setStreamOffsetMin, onShowOnboarding }: {
  open: boolean;
  onClose: () => void;
  dark: boolean;
  setDark: (fn: (v: boolean) => boolean) => void;
  noSpoiler: boolean;
  setNoSpoiler: (fn: (v: boolean) => boolean) => void;
  hideCommunity: boolean;
  setHideCommunity: (fn: (v: boolean) => boolean) => void;
  streamOffsetMin: number;
  setStreamOffsetMin: (n: number) => void;
  onShowOnboarding: () => void;
}) {
  if (!open) return null;
  return (
    <>
      <div
        onClick={onClose}
        style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.82)", zIndex:300, animation:"fadeIn .22s ease-out", backdropFilter:"blur(6px)" } as React.CSSProperties}
      />
      <div role="dialog" aria-modal="true" aria-label="Settings"
        style={{ position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)", width:"100%", maxWidth:480, background:BG2, borderRadius:"22px 22px 0 0", border:`1px solid ${BD}`, borderBottom:"none", maxHeight:"88vh", overflowY:"auto", zIndex:301, animation:"sheetUpScale .4s cubic-bezier(.2,.85,.2,1) both" } as React.CSSProperties}
      >
        <div style={{ width:40, height:4, background:BD2, borderRadius:2, margin:"14px auto 0" }}/>

        {/* Header */}
        <div style={{ padding:"16px 22px 8px", display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:36, height:36, borderRadius:10, background:`linear-gradient(135deg, ${OR}, #cc5610)`, display:"flex", alignItems:"center", justifyContent:"center", boxShadow:`0 4px 14px rgba(255,107,26,.35)` }}>
            <Icon name="settings" size={18} color="#fff"/>
          </div>
          <div>
            <div style={{ fontSize:20, fontWeight:900, color:TX, letterSpacing:"-.5px" }}>Settings</div>
            <div style={{ fontSize:11.5, color:MT, marginTop:1 }}>Customize your AniCal experience</div>
          </div>
          <button
            aria-label="Close settings"
            onClick={onClose}
            style={{ marginLeft:"auto", width:34, height:34, borderRadius:"50%", background:BG3, border:`1px solid ${BD}`, color:MT, display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", fontFamily:"inherit" } as React.CSSProperties}
          >
            <Icon name="close" size={16} color={MT}/>
          </button>
        </div>

        {/* Body */}
        <div style={{ padding:"14px 22px 36px" }}>
          {/* Appearance */}
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8, fontSize:11, fontWeight:700, color:MT2, textTransform:"uppercase" as const, letterSpacing:".8px" }}>
            <Icon name={dark ? "moon" : "sun"} size={12} color={MT2}/>
            <span>Appearance</span>
          </div>
          <div style={{ background:BG2, border:`1px solid ${BD}`, borderRadius:14, overflow:"hidden", marginBottom:18 }}>
            <SettingRow
              icon={dark ? "moon" : "sun"}
              label="Theme"
              description={dark ? "Dark mode is on" : "Light mode is on"}
              checked={!dark}
              onToggle={() => { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); setDark((v) => !v); }}
              toggleLabel={dark ? "Switch to light" : "Switch to dark"}
              last
            />
          </div>

          {/* Content */}
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8, fontSize:11, fontWeight:700, color:MT2, textTransform:"uppercase" as const, letterSpacing:".8px" }}>
            <Icon name="eye" size={12} color={MT2}/>
            <span>Content</span>
          </div>
          <div style={{ background:BG2, border:`1px solid ${BD}`, borderRadius:14, overflow:"hidden", marginBottom:18 }}>
            <SettingRow
              icon={noSpoiler ? "spoiler" : "eye"}
              label="No-spoiler mode"
              description={noSpoiler ? "Trailers & rumors hidden" : "Trailers & rumors visible"}
              checked={noSpoiler}
              onToggle={() => { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); setNoSpoiler((v) => !v); }}
              toggleLabel="Toggle no-spoiler"
              last
            />
          </div>

          {/* Schedule */}
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8, fontSize:11, fontWeight:700, color:MT2, textTransform:"uppercase" as const, letterSpacing:".8px" }}>
            <Icon name="clock" size={12} color={MT2}/>
            <span>Schedule</span>
          </div>
          <div style={{ background:BG2, border:`1px solid ${BD}`, borderRadius:14, padding:"14px 16px", marginBottom:8 }}>
            <div style={{ display:"flex", alignItems:"flex-start", gap:14, marginBottom:12 }}>
              <div style={{ width:36, height:36, borderRadius:10, background:BG3, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, color: streamOffsetMin > 0 ? OR : MT }}>
                <Icon name="clock" size={18} color={streamOffsetMin > 0 ? OR : MT}/>
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:13.5, fontWeight:700, color:TX, letterSpacing:"-.05px" }}>Streaming offset</div>
                <div style={{ fontSize:11, color:MT, marginTop:2, lineHeight:1.5 }}>
                  MAL airing times are the Japanese TV broadcast. Crunchyroll & friends usually publish later — shift the times to match your platform.
                </div>
              </div>
            </div>
            <div style={{ display:"flex", flexWrap:"wrap" as const, gap:6 }}>
              {STREAM_OFFSET_OPTIONS.map((opt) => {
                const active = streamOffsetMin === opt.minutes;
                return (
                  <button
                    key={opt.minutes}
                    aria-pressed={active}
                    aria-label={`${opt.label}: ${opt.description}`}
                    onClick={() => { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); setStreamOffsetMin(opt.minutes); }}
                    style={{ padding:"7px 12px", borderRadius:99, border:`1px solid ${active ? OR : BD}`, background: active ? OR2 : BG3, color: active ? OR : MT, fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:"inherit", letterSpacing:".2px", transition:"all .15s" } as React.CSSProperties}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{ fontSize:10.5, color:MT2, marginBottom:18, paddingLeft:4, lineHeight:1.5 }}>
            {streamOffsetMin === 0 ? "Showing Japan TV broadcast times." : `All times shifted +${streamOffsetMin} min from Japan TV.`}
          </div>

          {/* Navigation */}
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8, fontSize:11, fontWeight:700, color:MT2, textTransform:"uppercase" as const, letterSpacing:".8px" }}>
            <Icon name="community" size={12} color={MT2}/>
            <span>Navigation</span>
          </div>
          <div style={{ background:BG2, border:`1px solid ${BD}`, borderRadius:14, overflow:"hidden", marginBottom:18 }}>
            <SettingRow
              icon="community"
              label="Community tab"
              description={hideCommunity ? "Hidden from bottom nav" : "Visible in bottom nav"}
              checked={!hideCommunity}
              onToggle={() => { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); setHideCommunity((v) => !v); }}
              toggleLabel="Toggle community visibility"
              last
            />
          </div>

          {/* About */}
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8, fontSize:11, fontWeight:700, color:MT2, textTransform:"uppercase" as const, letterSpacing:".8px" }}>
            <Icon name="news" size={12} color={MT2}/>
            <span>About</span>
          </div>
          <div style={{ background:BG2, border:`1px solid ${BD}`, borderRadius:14, overflow:"hidden" }}>
            <button
              onClick={() => { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); onClose(); setTimeout(onShowOnboarding, 200); }}
              style={{ width:"100%", padding:"14px 16px", background:"transparent", border:"none", display:"flex", alignItems:"center", gap:14, cursor:"pointer", fontFamily:"inherit", textAlign:"left" as const, color:TX } as React.CSSProperties}
            >
              <div style={{ width:36, height:36, borderRadius:10, background:BG3, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                <Icon name="play" size={16} color={OR}/>
              </div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:13.5, fontWeight:700, color:TX, letterSpacing:"-.05px" }}>Replay welcome tour</div>
                <div style={{ fontSize:11, color:MT, marginTop:2 }}>See the 4-step intro again</div>
              </div>
              <Icon name="chevronRight" size={14} color={MT2}/>
            </button>
          </div>

          <div style={{ textAlign:"center", marginTop:24, fontSize:11, color:MT2 }}>
            AniCal · made with ♥ for anime fans
          </div>
        </div>
      </div>
    </>
  );
}

// ── Onboarding (first launch only) ─────────────────────────────────────────────
const ONBOARDING_STEPS = [
  {
    emoji: "📋",
    title: "Track every show",
    desc: "AniCal pulls live data from MyAnimeList & the official anime industry feed. Tap the star to add a show to your watchlist.",
    accent: OR,
  },
  {
    emoji: "🔔",
    title: "Never miss an episode",
    desc: "Get a heads-up notification when an episode drops in your timezone. Lead time is fully configurable.",
    accent: "#a78bfa",
  },
  {
    emoji: "💬",
    title: "Anonymous community",
    desc: "Pick a nickname, share reactions, and discuss episodes with other fans — no signup, no tracking.",
    accent: "#22c55e",
  },
  {
    emoji: "🍥",
    title: "Watch anywhere",
    desc: "One tap opens Crunchyroll, Netflix, HIDIVE or Hulu — directly in their native app if installed.",
    accent: "#F47521",
  },
];

function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const s = ONBOARDING_STEPS[step];
  const isLast = step === ONBOARDING_STEPS.length - 1;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to AniCal"
      style={{
        position:"fixed", inset:0, zIndex:9000, background:BG,
        display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
        padding:"24px 22px 32px", textAlign:"center",
        paddingTop:"calc(env(safe-area-inset-top, 0px) + 24px)",
        paddingBottom:"calc(env(safe-area-inset-bottom, 0px) + 32px)",
      }}
    >
      <div style={{ position:"absolute", inset:0, background:`radial-gradient(circle at 50% 30%, ${s.accent}33, transparent 60%)`, pointerEvents:"none", transition:"background .4s" }}/>

      {/* Skip */}
      <button
        aria-label="Skip onboarding"
        onClick={onDone}
        style={{ position:"absolute", top:"calc(env(safe-area-inset-top, 0px) + 14px)", right:18, background:"none", border:"none", color:MT2, fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit", padding:8 }}
      >
        Skip
      </button>

      {/* Content */}
      <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", maxWidth:340, animation:"fadeIn .35s" } as React.CSSProperties} key={step}>
        <div
          style={{
            width:120, height:120, borderRadius:30, background:`linear-gradient(135deg, ${s.accent}, ${s.accent}aa)`,
            display:"flex", alignItems:"center", justifyContent:"center", marginBottom:32,
            boxShadow:`0 12px 40px -8px ${s.accent}66`, animation:"popIn .4s cubic-bezier(.2,.7,.2,1)",
          }}
        >
          <span style={{ fontSize:64, lineHeight:1 }}>{s.emoji}</span>
        </div>
        <h2 style={{ fontSize:26, fontWeight:900, color:TX, letterSpacing:"-.5px", margin:"0 0 12px", lineHeight:1.2 }}>{s.title}</h2>
        <p style={{ fontSize:14, color:MT, lineHeight:1.65, margin:0 }}>{s.desc}</p>
      </div>

      {/* Dots */}
      <div style={{ display:"flex", gap:8, marginBottom:24 }}>
        {ONBOARDING_STEPS.map((_, i) => (
          <div key={i} style={{ width: i === step ? 24 : 8, height:8, borderRadius:99, background: i === step ? s.accent : BD2, transition:"all .25s" }}/>
        ))}
      </div>

      {/* Buttons */}
      <div style={{ display:"flex", gap:10, width:"100%", maxWidth:340 }}>
        {step > 0 && (
          <button
            aria-label="Previous step"
            onClick={() => { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); setStep((v) => Math.max(0, v - 1)); }}
            style={{ flex:1, padding:"14px 18px", borderRadius:14, border:`1px solid ${BD}`, background:BG3, color:MT, fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}
          >
            Back
          </button>
        )}
        <button
          aria-label={isLast ? "Get started with AniCal" : "Next step"}
          onClick={() => { Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {}); if (isLast) onDone(); else setStep((v) => v + 1); }}
          style={{ flex:2, padding:"14px 18px", borderRadius:14, border:"none", background:`linear-gradient(135deg, ${s.accent}, ${s.accent}cc)`, color:"#fff", fontSize:14, fontWeight:800, cursor:"pointer", fontFamily:"inherit", boxShadow:`0 8px 24px -6px ${s.accent}aa`, transition:"transform .12s" }}
        >
          {isLast ? "Let's go ✨" : "Next →"}
        </button>
      </div>
    </div>
  );
}

// ── Pull indicator ─────────────────────────────────────────────────────────────
function PullIndicator({ visible, spinning }: { visible: boolean; spinning: boolean }) {
  const show = visible || spinning;
  return (
    <div style={{ position:"fixed", top:66, left:"50%", transform:`translateX(-50%) translateY(${show ? 0 : -120}px) scale(${show ? 1 : 0.5})`, opacity: show ? 1 : 0, pointerEvents:"none", transition:"transform .3s cubic-bezier(.2,.7,.2,1), opacity .25s", zIndex:60, width:36, height:36, borderRadius:"50%", background:`linear-gradient(135deg, ${OR}, #cc5610)`, display:"flex", alignItems:"center", justifyContent:"center", boxShadow:`0 4px 20px rgba(255,107,26,.5)` }}>
      <span style={{ fontSize:18, color:"#fff", lineHeight:1, display:"block", animation: spinning ? "spin .65s linear infinite" : "none" }}>↻</span>
    </div>
  );
}

// ── Root app ───────────────────────────────────────────────────────────────────
export default function AniCal() {
  const todayDayIdx = (new Date().getDay() + 6) % 7;

  const [boot, setBoot] = useState<BootStage>("splash");
  const [splashFading, setSplashFading] = useState(false);
  const [splashVisible, setSplashVisible] = useState(true);
  const [schedule, setSchedule] = useState<Schedule>({});
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadMsg, setLoadMsg] = useState("Starting up…");
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"schedule"|"month"|"community"|"news"|"stats">("schedule");
  const [selectedDay, setSelectedDay] = useState(todayDayIdx);
  const [favs, setFavs] = useState<number[]>([]);
  const [favFilter, setFavFilter] = useState(false);
  const [search, setSearch] = useState("");
  const [genreFilter, setGenreFilter] = useState<string | null>(null);
  const [detailAnime, setDetailAnime] = useState<Anime | null>(null);
  const [communityAnime, setCommunityAnime] = useState<Anime | null>(null);
  const [toast, setToast] = useState({ show: false, msg: "" });
  const [dark, setDark] = useState<boolean>(() => {
    const d = LS.get<boolean>("anical_dark", true);
    document.documentElement.classList.toggle("light", !d);
    return d;
  });
  const [noSpoiler, setNoSpoiler] = useState<boolean>(() => LS.get<boolean>("anical_no_spoiler", false));
  const [hideCommunity, setHideCommunity] = useState<boolean>(() => LS.get<boolean>("anical_hide_community", false));
  const [streamOffsetMin, setStreamOffsetMin] = useState<number>(() => LS.get<number>("anical_stream_offset_min", 0));
  const [ratingFilter, setRatingFilter] = useState<number>(0); // 0 = no filter; 7/8/9 = ≥ that score
  const [showOnboarding, setShowOnboarding] = useState<boolean>(() => !LS.get<boolean>("anical_onboarded_v1", false));
  const [showSettings, setShowSettings] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const tz = "auto";
  const [notifSettings, setNotifSettings] = useState<NotifSettings>(DEFAULT_NOTIF);
  const [notifPerm, setNotifPerm] = useState<"granted"|"denied"|"default"|"unsupported">("default");
  const [tick, setTick] = useState(0);
  const [pullVisible, setPullVisible] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const dayNavRef = useRef<HTMLDivElement>(null);
  const isLoadingRef = useRef(false);
  const pullStartY = useRef<number | null>(null);
  const pullCurrentY = useRef(0);
  const didHealRef = useRef(false);

  // ── Splash ──
  useEffect(() => {
    const cached = LS.get<{ ts: number; data: Schedule } | null>("anical_schedule_cache", null);
    const haveFresh = cached && Date.now() - cached.ts < CACHE_TTL;
    const showDuration = haveFresh ? 2200 : 2800;
    const t1 = window.setTimeout(() => setSplashFading(true), showDuration - 500);
    const t2 = window.setTimeout(() => {
      setSplashVisible(false);
      setBoot(haveFresh ? "ready" : "loading");
      if (haveFresh && cached) { setSchedule(cached.data); setLastUpdated(new Date(cached.ts)); }
    }, showDuration);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  // ── Persistence ──
  useEffect(() => { setFavs(LS.get<number[]>("anical_favs", [])); }, []);
  useEffect(() => { LS.set("anical_favs", favs); }, [favs]);
  useEffect(() => { setNotifSettings(LS.get<NotifSettings>("anical_notif", DEFAULT_NOTIF)); }, []);
  useEffect(() => { LS.set("anical_notif", notifSettings); }, [notifSettings]);
  useEffect(() => {
    document.documentElement.classList.toggle("light", !dark);
    LS.set("anical_dark", dark);
  }, [dark]);
  useEffect(() => { LS.set("anical_no_spoiler", noSpoiler); }, [noSpoiler]);
  useEffect(() => {
    LS.set("anical_hide_community", hideCommunity);
    // If the user hides Community while they're on that tab, send them to Schedule
    if (hideCommunity && view === "community") setView("schedule");
  }, [hideCommunity, view]);
  useEffect(() => { LS.set("anical_stream_offset_min", streamOffsetMin); }, [streamOffsetMin]);

  // ── Init ──
  useEffect(() => { notif.getPermission().then((p) => setNotifPerm(p as any)); }, []);
  useEffect(() => { const id = setInterval(() => setTick((t) => t + 1), 30_000); return () => clearInterval(id); }, []);
  useEffect(() => {
    const handler = (e: any) => { e.preventDefault(); setInstallPrompt(e); };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  // ── Actions ──
  const showToast = useCallback((msg: string) => {
    setToast({ show: true, msg });
    setTimeout(() => setToast((t) => ({ ...t, show: false })), 2000);
  }, []);

  const toggleFav = useCallback((id: number) => {
    Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {});
    setFavs((prev) => {
      const adding = !prev.includes(id);
      showToast(adding ? "Added to favorites ★" : "Removed from favorites");
      return adding ? [...prev, id] : prev.filter((f) => f !== id);
    });
  }, [showToast]);

  const requestNotifPerm = useCallback(async () => {
    const p = await notif.requestPermission();
    setNotifPerm(p as any);
    return p;
  }, []);

  const testNotif = useCallback(async () => {
    showToast("Test notification in 1.5s");
    await notif.testFire("AniCal", "Your favorites will alert you like this 🔔");
  }, [showToast]);

  // Background-heal days that have zero results (likely rate-limit failures in a prior fetch)
  const healEmptyDays = useCallback(async (base: Schedule) => {
    const empty = DAYS.filter((d) => !base[d] || base[d].length === 0);
    if (empty.length === 0) return;
    const patch: Schedule = {};
    for (const day of empty) {
      await new Promise((r) => setTimeout(r, 700));
      try {
        const data = await fetchDay(day);
        if (data.length > 0) patch[day] = data;
      } catch {}
    }
    if (Object.keys(patch).length === 0) return;
    setSchedule((prev) => {
      const next = { ...prev, ...patch };
      const cached = LS.get<{ ts: number; data: Schedule } | null>("anical_schedule_cache", null);
      LS.set("anical_schedule_cache", { ts: cached?.ts ?? Date.now(), data: next });
      return next;
    });
  }, []);

  const loadSchedule = useCallback(async (force = false, silent = false) => {
    if (!force) {
      const cached = LS.get<{ ts: number; data: Schedule } | null>("anical_schedule_cache", null);
      if (cached && Date.now() - cached.ts < CACHE_TTL) {
        setSchedule(cached.data);
        setLastUpdated(new Date(cached.ts));
        setBoot("ready");
        // Silently re-fetch any days that are cached as empty (past rate-limit failures)
        setTimeout(() => healEmptyDays(cached.data), 1800);
        return;
      }
    }
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;
    if (!silent) setBoot("loading");
    setError(null);
    setLoadProgress(0);
    const result: Schedule = {};
    try {
      for (let i = 0; i < DAYS.length; i++) {
        setLoadMsg(`Loading ${capitalize(DAYS[i])}… (${i + 1}/${DAYS.length})`);
        setLoadProgress(Math.round((i / DAYS.length) * 90));
        try { result[DAYS[i]] = await fetchDay(DAYS[i]); } catch { result[DAYS[i]] = []; }
        // 650 ms gap keeps us well under Jikan's 3 req/s rate limit
        if (i < DAYS.length - 1) await new Promise((r) => setTimeout(r, 650));
      }
      setLoadProgress(100);
      setSchedule(result);
      const ts = Date.now();
      setLastUpdated(new Date(ts));
      LS.set("anical_schedule_cache", { data: result, ts });
      setTimeout(() => setBoot("ready"), 250);
      // Heal any days that still came back empty despite retries (e.g. API outage mid-load)
      setTimeout(() => healEmptyDays(result), 2500);
    } catch (e: any) {
      if (!silent) { setError(e.message || "Failed to load"); setBoot("error"); }
    } finally {
      isLoadingRef.current = false;
    }
  }, [healEmptyDays]);

  useEffect(() => { if (boot === "loading") loadSchedule(); }, [boot, loadSchedule]);

  // Heal empty days once on first "ready" — handles the case where the splash screen
  // loaded data directly from cache (bypassing loadSchedule's own heal timer).
  useEffect(() => {
    if (boot !== "ready" || didHealRef.current) return;
    didHealRef.current = true;
    setTimeout(() => healEmptyDays(schedule), 2200);
  }, [boot, schedule, healEmptyDays]);

  useEffect(() => {
    if (!dayNavRef.current || view !== "schedule") return;
    const pill = dayNavRef.current.querySelector(`[data-day="${selectedDay}"]`) as HTMLElement | null;
    pill?.scrollIntoView({ inline: "center", behavior: "smooth", block: "nearest" });
  }, [selectedDay, view]);

  // ── Pull-to-refresh handlers ──
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 0) return;
    if (window.scrollY === 0) pullStartY.current = e.touches[0].clientY;
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (pullStartY.current === null || e.touches.length === 0) return;
    if (window.scrollY > 0) { pullStartY.current = null; setPullVisible(false); return; }
    const dy = e.touches[0].clientY - pullStartY.current;
    pullCurrentY.current = dy;
    setPullVisible(dy > PULL_THRESHOLD * 0.45);
  }, []);

  const onTouchEnd = useCallback(async () => {
    const dy = pullCurrentY.current;
    pullStartY.current = null;
    pullCurrentY.current = 0;
    setPullVisible(false);
    if (dy >= PULL_THRESHOLD && !isLoadingRef.current && boot === "ready") {
      setRefreshing(true);
      showToast("Refreshing schedule…");
      await loadSchedule(true, true);
      setRefreshing(false);
    }
  }, [boot, loadSchedule, showToast]);

  // ── Derived ──
  const getFiltered = useCallback((dayIdx: number) => {
    const seen = new Set<number>();
    let list = (schedule[DAYS[dayIdx]] || []).filter((a) => { if (seen.has(a.id)) return false; seen.add(a.id); return true; });
    if (favFilter) list = list.filter((a) => favs.includes(a.id));
    if (genreFilter) list = list.filter((a) => (a.genres || []).includes(genreFilter));
    if (ratingFilter > 0) list = list.filter((a) => (a.score ?? 0) >= ratingFilter);
    if (search) { const q = search.toLowerCase(); list = list.filter((a) => a.title.toLowerCase().includes(q)); }
    return list.sort((a, b) => (a.broadcast_time || "").localeCompare(b.broadcast_time || ""));
  }, [schedule, favFilter, genreFilter, ratingFilter, search, favs]);

  // Top genres across the whole week — used for filter chips
  const topGenres = useMemo(() => {
    const map: Record<string, number> = {};
    Object.values(schedule).flat().forEach((a) => (a.genres || []).forEach((g) => { map[g] = (map[g] || 0) + 1; }));
    return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([g]) => g);
  }, [schedule]);

  const favAnime = useMemo(() =>
    DAYS.flatMap((d, i) => (schedule[d] || []).filter((a) => favs.includes(a.id)).map((a) => ({ ...a, dayIdx: i })))
      .filter((a, i, arr) => arr.findIndex((x) => x.id === a.id) === i),
    [schedule, favs]);

  // Full flat list of every anime in the schedule — used by CommunityView for genre tag lookups
  const allAnime = useMemo(() =>
    DAYS.flatMap((d) => schedule[d] || [])
      .filter((a, i, arr) => arr.findIndex((x) => x.id === a.id) === i),
    [schedule]);

  useEffect(() => {
    if (boot !== "ready") return;
    if (notifPerm !== "granted" || !notifSettings.enabled) { notif.cancelAll(); return; }
    const entries: ScheduleEntry[] = favAnime.flatMap((a) => {
      if (notifSettings.perAnime[a.id] === false) return [];
      const airAt = nextJstAiringDate(a.broadcast_day, a.broadcast_time);
      if (!airAt) return [];
      const fireAt = new Date(airAt.getTime() - notifSettings.leadMinutes * 60_000);
      if (fireAt.getTime() < Date.now() + 5_000) return [];
      return [{ id: a.id, title: a.title, fireAt, body: notifSettings.leadMinutes === 0 ? "Airing now on Crunchyroll" : `Starts in ${notifSettings.leadMinutes} min · ${a.broadcast_time} JST`, url: a.mal_url || undefined }];
    });
    notif.schedule(entries).catch(() => {});
  }, [boot, favAnime, notifSettings, notifPerm]);

  const downloadExtension = () => {
    fetch("./anical-extension.zip")
      .then((r) => { if (!r.ok) throw new Error("Download failed"); return r.blob(); })
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "anical-extension.zip";
        a.click();
        URL.revokeObjectURL(a.href);
        showToast("Extension downloaded ✓");
      })
      .catch((e) => showToast(e.message));
  };

  const installPwa = async () => {
    if (!installPrompt) { showToast("Use browser menu → Install / Add to Home Screen"); return; }
    installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  const totalAnime = useMemo(() => Object.values(schedule).flat().length, [schedule]);
  const airingToday = useMemo(() => getFiltered(todayDayIdx).length, [getFiltered, todayDayIdx]);
  const topGenre = useMemo(() => {
    const map: Record<string, number> = {};
    favAnime.forEach((a) => (a.genres || []).forEach((g) => { map[g] = (map[g] || 0) + 1; }));
    return Object.entries(map).sort((a, b) => b[1] - a[1])[0]?.[0] || "—";
  }, [favAnime]);

  // ── Render ──
  return (
    <>
      <style>{GLOBAL_CSS}</style>

      {splashVisible && <Splash fadingOut={splashFading}/>}

      {!splashVisible && showOnboarding && (
        <Onboarding onDone={() => { setShowOnboarding(false); LS.set("anical_onboarded_v1", true); }}/>
      )}

      {boot === "loading" && (
        <div style={{ fontFamily:"'Outfit',system-ui,sans-serif", background:BG, minHeight:"100vh", color:TX, maxWidth:480, margin:"0 auto", position:"relative" }}>
          <LoadingView progress={loadProgress} msg={loadMsg}/>
        </div>
      )}

      {boot === "error" && (
        <div style={{ fontFamily:"'Outfit',system-ui,sans-serif", background:BG, minHeight:"100vh", color:TX, maxWidth:480, margin:"0 auto", position:"relative" }}>
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"60px 24px", gap:14, minHeight:"60vh", textAlign:"center" }}>
            <div style={{ fontSize:64, marginBottom:8 }}>{typeof navigator !== "undefined" && !navigator.onLine ? "📡" : "⚠️"}</div>
            <div style={{ fontSize:20, fontWeight:800, letterSpacing:"-.3px" }}>{typeof navigator !== "undefined" && !navigator.onLine ? "You're offline" : "Couldn't load schedule"}</div>
            <div style={{ fontSize:13, color:MT, lineHeight:1.65, maxWidth:300 }}>
              {typeof navigator !== "undefined" && !navigator.onLine
                ? "AniCal needs an internet connection to load fresh anime data. Once you're back online, tap retry."
                : "MyAnimeList might be rate-limiting us, or there's a network issue. Give it another go in a few seconds."}
            </div>
            {error && <div style={{ fontSize:11, color:MT2, fontStyle:"italic", maxWidth:280, marginTop:-4 }}>{error}</div>}
            <button
              aria-label="Retry loading schedule"
              style={{ background:`linear-gradient(135deg, ${OR}, #cc5610)`, border:"none", color:"#fff", borderRadius:12, padding:"12px 28px", fontSize:14, fontWeight:800, cursor:"pointer", fontFamily:"inherit", marginTop:8, boxShadow:`0 6px 20px -4px rgba(255,107,26,.5)` }}
              onClick={() => { Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {}); loadSchedule(true); }}
            >↻ Try again</button>
          </div>
        </div>
      )}

      {boot === "ready" && (
        <div
          style={{ fontFamily:"'Outfit',system-ui,sans-serif", background:BG, minHeight:"100vh", color:TX, maxWidth:480, margin:"0 auto", position:"relative" }}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          {/* ── Premium Header ── */}
          <div style={{ position:"sticky", top:0, zIndex:50, background:"var(--c-hdr)", backdropFilter:"blur(32px) saturate(1.6)", borderBottom:`1px solid ${BD}`, paddingTop:"env(safe-area-inset-top, 0px)" } as React.CSSProperties}>
            {/* Brand row */}
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"14px 16px 10px" }}>
              <div style={{ display:"flex", alignItems:"center", gap:9 }}>
                <div style={{ width:32, height:32, borderRadius:10, background:`linear-gradient(135deg, ${OR} 0%, #e05010 100%)`, display:"flex", alignItems:"center", justifyContent:"center", boxShadow:`0 4px 14px rgba(255,107,26,.38)` }}>
                  <svg width={17} height={17} viewBox="0 0 26 26" fill="none">
                    <path d="M13 3.5l2.2 6.3h6.6l-5.3 3.9 2 6.3L13 16.2l-5.5 3.8 2-6.3L4.2 9.8h6.6L13 3.5z" fill="#fff"/>
                  </svg>
                </div>
                <div style={{ lineHeight:1 }}>
                  <span style={{ fontSize:19, fontWeight:900, letterSpacing:"-0.8px", color:TX }}>Ani</span><span style={{ fontSize:19, fontWeight:900, letterSpacing:"-0.8px", color:OR }}>Cal</span>
                </div>
              </div>
              <div style={{ display:"flex", gap:7, alignItems:"center" }}>
                {/* Favs filter — only on schedule */}
                {view === "schedule" && (
                  <button
                    aria-label={favFilter ? "Showing favorites only — tap to show all" : "Show only favorites"}
                    aria-pressed={favFilter}
                    onClick={() => { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); setFavFilter((v) => !v); }}
                    style={{ display:"inline-flex", alignItems:"center", gap:6, padding:"9px 14px", minHeight:38, borderRadius:99, border:`1px solid ${favFilter ? OR : BD}`, background: favFilter ? `linear-gradient(135deg, ${OR2}, rgba(255,107,26,0.12))` : BG3, color: favFilter ? OR : MT, fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"inherit", transition:"all .18s", boxShadow: favFilter ? `0 0 12px rgba(255,107,26,.25)` : "none", letterSpacing:".3px" } as React.CSSProperties}
                  >
                    <Icon name={favFilter ? "starFilled" : "star"} size={14} color={favFilter ? OR : MT}/>
                    <span>Favs</span>
                  </button>
                )}
                {/* No-spoiler toggle — quick access privacy switch */}
                <button
                  aria-label={noSpoiler ? "No-spoiler mode on — tap to disable" : "Enable no-spoiler mode (hide trailers and rumors)"}
                  aria-pressed={noSpoiler}
                  onClick={() => { setNoSpoiler((v) => !v); Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); }}
                  title={noSpoiler ? "No-spoiler on — trailers hidden" : "No-spoiler off — trailers shown"}
                  style={{ width:38, height:38, borderRadius:"50%", border:`1px solid ${noSpoiler ? "rgba(139,92,246,.5)" : BD}`, background: noSpoiler ? "rgba(139,92,246,.14)" : BG3, color: noSpoiler ? "rgba(167,139,250,1)" : MT, cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center", transition:"all .18s", flexShrink:0 } as React.CSSProperties}
                >
                  <Icon name={noSpoiler ? "eyeOff" : "eye"} size={17} color={noSpoiler ? "rgba(167,139,250,1)" : MT}/>
                </button>
                {/* Settings — opens the full settings sheet (theme, community visibility, etc.) */}
                <button
                  aria-label="Open settings"
                  onClick={() => { Haptics.impact({ style: ImpactStyle.Light }).catch(() => {}); setShowSettings(true); }}
                  title="Settings"
                  style={{ width:38, height:38, borderRadius:"50%", border:`1px solid ${BD}`, background:BG3, color:MT, cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center", transition:"all .18s", flexShrink:0 } as React.CSSProperties}
                >
                  <Icon name="settings" size={17} color={MT}/>
                </button>
              </div>
            </div>

            {/* Search bar — only on schedule */}
            {view === "schedule" && (
            <div style={{ padding:"0 16px 10px", position:"relative" } as React.CSSProperties}>
              <div style={{ position:"absolute", left:28, top:"50%", transform:"translateY(-50%)", pointerEvents:"none", color:MT2, display:"flex" }}>
                <Icon name="search" size={15} color={MT2} strokeWidth={2}/>
              </div>
              <input
                aria-label="Search anime"
                style={{ width:"100%", background:"rgba(255,255,255,0.06)", border:`1px solid ${search ? "rgba(255,107,26,0.35)" : "rgba(255,255,255,0.09)"}`, borderRadius:14, padding:"10px 36px 10px 36px", color:TX, fontSize:14, fontFamily:"inherit", outline:"none", boxSizing:"border-box", transition:"border-color .2s", letterSpacing:".1px" } as React.CSSProperties}
                placeholder="Search anime…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button
                  aria-label="Clear search"
                  onClick={() => setSearch("")}
                  style={{ position:"absolute", right:28, top:"50%", transform:"translateY(-50%)", background:"rgba(255,255,255,0.12)", border:"none", color:MT, width:24, height:24, borderRadius:"50%", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"inherit" } as React.CSSProperties}
                ><Icon name="close" size={11} color={MT} strokeWidth={2.4}/></button>
              )}
            </div>
            )}

            {/* Status line */}
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 16px 10px" }}>
              <div style={{ display:"flex", alignItems:"center", gap:5, fontSize:9.5, color:"rgba(255,255,255,0.22)", fontWeight:500, letterSpacing:".3px" }}>
                <span style={{ fontSize:10 }}>🌐</span>
                <span>{getDeviceTz().replace(/_/g, " ")}</span>
              </div>
              {lastUpdated && (
                <div style={{ fontSize:9.5, color:"rgba(255,255,255,0.2)", fontWeight:500, letterSpacing:".3px" }}>
                  Updated {lastUpdated.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" })}
                </div>
              )}
            </div>

            {/* Bottom fade edge */}
            <div style={{ position:"absolute", bottom:-18, left:0, right:0, height:18, background:"linear-gradient(to bottom, rgba(9,9,15,0.35), transparent)", pointerEvents:"none" } as React.CSSProperties}/>
          </div>

          {/* Pull-to-refresh indicator */}
          <PullIndicator visible={pullVisible} spinning={refreshing}/>

          {/* Main content — each view fades+rises in on tab switch */}
          <div style={{ padding:"0 0 88px" }}>
            <div key={view} style={{ animation:"viewIn .28s cubic-bezier(.2,.7,.2,1) both" } as React.CSSProperties}>
              {view === "schedule" && (
                <ScheduleView
                  anime={getFiltered(selectedDay)}
                  selectedDay={selectedDay}
                  setSelectedDay={setSelectedDay}
                  todayDayIdx={todayDayIdx}
                  dayNavRef={dayNavRef}
                  schedule={schedule}
                  favs={favs}
                  favFilter={favFilter}
                  search={search}
                  tz={tz}
                  onOpen={setDetailAnime}
                  onToggleFav={toggleFav}
                  tick={tick}
                  topGenres={topGenres}
                  genreFilter={genreFilter}
                  setGenreFilter={setGenreFilter}
                  ratingFilter={ratingFilter}
                  setRatingFilter={setRatingFilter}
                  streamOffsetMin={streamOffsetMin}
                />
              )}
              {view === "month" && (
                <MonthView
                  schedule={schedule}
                  favs={favs}
                  onOpen={(a) => setDetailAnime(a)}
                />
              )}
              {view === "community" && (
                <CommunityView favAnime={favAnime} allAnime={allAnime}
                  onOpenCommunity={(a) => setCommunityAnime(a)}
                  onOpenAnime={(a) => setDetailAnime(a)}
                  onToast={showToast}/>
              )}
              {view === "news" && (
                <NewsView favAnime={favAnime} noSpoiler={noSpoiler}/>
              )}
              {view === "stats" && (
                <MyListView
                  favAnime={favAnime} todayDayIdx={todayDayIdx} tz={tz} favs={favs}
                  totalAnime={totalAnime} airingToday={airingToday} topGenre={topGenre}
                  notifSettings={notifSettings} setNotifSettings={setNotifSettings}
                  notifPerm={notifPerm} requestNotifPerm={requestNotifPerm} testNotif={testNotif}
                  onOpen={setDetailAnime} toggleFav={toggleFav}
                  installPwa={installPwa} downloadExtension={downloadExtension} tick={tick}
                />
              )}
            </div>
          </div>

          {/* Bottom navigation */}
          <BottomNav view={view} setView={setView} favCount={favs.length} hideCommunity={hideCommunity}/>

          {/* Settings sheet — opens from the header gear button */}
          <SettingsSheet
            open={showSettings}
            onClose={() => setShowSettings(false)}
            dark={dark} setDark={setDark}
            noSpoiler={noSpoiler} setNoSpoiler={setNoSpoiler}
            hideCommunity={hideCommunity} setHideCommunity={setHideCommunity}
            streamOffsetMin={streamOffsetMin} setStreamOffsetMin={setStreamOffsetMin}
            onShowOnboarding={() => setShowOnboarding(true)}
          />

          {/* Detail sheet */}
          {detailAnime && (
            <DetailSheet anime={detailAnime} favorites={favs} tz={tz} noSpoiler={noSpoiler}
              onClose={() => setDetailAnime(null)}
              onToggleFav={(id: number) => { toggleFav(id); setDetailAnime((a) => (a ? { ...a } : null)); }}
              onOpenCommunity={(a) => { setDetailAnime(null); setCommunityAnime(a); }}
              onToast={showToast}/>
          )}

          {/* Community thread sheet */}
          {communityAnime && (
            <CommunitySheet anime={communityAnime} onClose={() => setCommunityAnime(null)}/>
          )}

          {/* Toast */}
          <div style={{ position:"fixed", bottom:100, left:"50%", transform:`translateX(-50%) translateY(${toast.show ? 0 : 12}px)`, background:"var(--c-toast)", border:`1px solid ${BD2}`, backdropFilter:"blur(16px)", borderRadius:10, padding:"9px 20px", fontSize:13, fontWeight:600, color:TX, opacity: toast.show ? 1 : 0, transition:"all .3s cubic-bezier(.2,.7,.2,1)", pointerEvents:"none", zIndex:300, whiteSpace:"nowrap" } as React.CSSProperties}>
            {toast.msg}
          </div>
        </div>
      )}
    </>
  );
}

