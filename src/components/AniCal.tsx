import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import * as notif from "@/lib/notifications";
import type { ScheduleEntry } from "@/lib/notifications";

const IS_NATIVE = Capacitor.isNativePlatform();

function openUrl(url: string) {
  window.open(url, IS_NATIVE ? "_system" : "_blank");
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
const BG  = "#09090f";
const BG2 = "#111119";
const BG3 = "#17171f";
const BG4 = "#1d1d27";
const BD  = "#252533";
const BD2 = "#323244";
const TX  = "#f2f2fa";
const MT  = "#8585a8";
const MT2 = "#484862";
const GR  = "#22c55e";

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


// ── Utilities ──────────────────────────────────────────────────────────────────
function getDeviceTz(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

function capitalize(s?: string | null) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }

function jstToLocal(jstTime?: string | null, tz?: string): string | null {
  if (!jstTime) return null;
  try {
    const [h, m] = jstTime.split(":").map(Number);
    const now = new Date();
    const utcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h - 9, m);
    const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: true };
    if (tz && tz !== "auto") opts.timeZone = tz;
    return new Date(utcMs).toLocaleTimeString([], opts);
  } catch { return null; }
}

function nextJstAiringDate(broadcastDay?: string | null, broadcastTime?: string | null): Date | null {
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
  let cand = new Date(Date.UTC(jY, jMo, jD + diff, h - 9, m));
  if (cand.getTime() <= now.getTime() + 60_000) cand = new Date(Date.UTC(jY, jMo, jD + diff + 7, h - 9, m));
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
    return {
      id: el.querySelector("guid")?.textContent || Math.random().toString(),
      title: el.querySelector("title")?.textContent?.trim() || "",
      date: el.querySelector("pubDate")?.textContent || undefined,
      excerpt: raw.replace(/<[^>]+>/g, "").trim().slice(0, 500) || undefined,
      url: el.querySelector("link")?.textContent?.trim() || "",
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
  const res = await fetch(`https://api.jikan.moe/v4/schedules?filter=${day}&limit=25&sfw=false`);
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

// ── Global CSS ─────────────────────────────────────────────────────────────────
const GLOBAL_CSS = `
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
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
function AnimeCard({ anime, favorites, onOpen, onToggleFav, selectedDayIdx, todayDayIdx, tz, animDelay = 0, tick = 0 }: {
  anime: Anime;
  favorites: number[];
  onOpen: (a: Anime) => void;
  onToggleFav: (id: number) => void;
  selectedDayIdx: number;
  todayDayIdx: number;
  tz: string;
  animDelay?: number;
  tick?: number;
}) {
  void tick;
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
          ? <img src={anime.image_url} alt="" loading="lazy" style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }} onError={() => setImgFailed(true)}/>
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
            <span>{anime.broadcast_time} JST</span>
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

// ── Detail sheet ───────────────────────────────────────────────────────────────
function DetailSheet({ anime, favorites, onClose, onToggleFav, onOpenCommunity, tz }: { anime: Anime | null; favorites: number[]; onClose: () => void; onToggleFav: (id: number) => void; onOpenCommunity: (a: Anime) => void; tz: string }) {
  if (!anime) return null;
  const isFav = favorites.includes(anime.id);
  const localTime = jstToLocal(anime.broadcast_time, tz);
  return (
    <>
      <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.82)", zIndex:200, animation:"fadeIn .2s ease-out", backdropFilter:"blur(6px)" } as React.CSSProperties} onClick={onClose}/>
      <div style={{ position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)", width:"100%", maxWidth:480, background:BG2, borderRadius:"22px 22px 0 0", border:`1px solid ${BD}`, borderBottom:"none", maxHeight:"88vh", overflowY:"auto", zIndex:201, animation:"sheetUp .3s cubic-bezier(.2,.7,.2,1)" }}>
        <div style={{ width:40, height:4, background:BD2, borderRadius:2, margin:"14px auto 0" }}/>
        <div style={{ padding:"16px 20px 48px" }}>
          {anime.image_url && <img src={anime.image_url} alt="" style={{ width:"100%", height:220, objectFit:"cover", objectPosition:"top", borderRadius:14, marginBottom:16, background:BG4, display:"block" }}/>}
          <div style={{ fontSize:21, fontWeight:800, lineHeight:1.2, marginBottom:8 }}>{anime.title}</div>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:12 }}>
            {anime.score && <span style={{ fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:6, background:OR2, color:OR, border:`1px solid ${OR3}` }}>★ {anime.score}</span>}
            {anime.year && <span style={{ fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:6, background:BG4, color:MT, border:`1px solid ${BD}` }}>{anime.year}</span>}
            {anime.season && <span style={{ fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:6, background:BG4, color:MT, border:`1px solid ${BD}` }}>{capitalize(anime.season)}</span>}
            {anime.episodes && <span style={{ fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:6, background:BG4, color:MT, border:`1px solid ${BD}` }}>{anime.episodes} eps</span>}
            {anime.genres?.slice(0, 3).map((g) => <span key={g} style={{ fontSize:11, fontWeight:600, padding:"3px 9px", borderRadius:6, background:BG4, color:MT, border:`1px solid ${BD}` }}>{g}</span>)}
          </div>
          {anime.broadcast_time && (
            <div style={{ background:BG3, border:`1px solid ${BD}`, borderRadius:10, padding:"12px 14px", marginBottom:12 }}>
              <div style={{ fontSize:11, fontWeight:700, color:MT, textTransform:"uppercase", letterSpacing:".6px", marginBottom:6 }}>📅 Airing Time</div>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}><div style={{ fontSize:16, fontWeight:700 }}>{anime.broadcast_time}</div><div style={{ fontSize:10, color:MT }}>Japan (JST)</div></div>
                <div style={{ color:MT, fontSize:22 }}>→</div>
                <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}><div style={{ fontSize:16, fontWeight:700, color:OR }}>{localTime || "—"}</div><div style={{ fontSize:10, color:MT }}>Your time</div></div>
                <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}><div style={{ fontSize:14, fontWeight:700 }}>{capitalize(anime.broadcast_day || "")}</div><div style={{ fontSize:10, color:MT }}>Day</div></div>
              </div>
            </div>
          )}
          <div style={{ fontSize:13, lineHeight:1.65, color:MT, marginBottom:16 }}>{anime.synopsis || "No synopsis available."}</div>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            <div style={{ display:"flex", gap:8 }}>
              <button style={{ flex:1, padding:12, borderRadius:10, border:`1px solid ${isFav ? OR : BD}`, background: isFav ? OR2 : BG3, color: isFav ? OR : MT, fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }} onClick={() => onToggleFav(anime.id)}>
                {isFav ? "★ Favorited" : "☆ Favorite"}
              </button>
              <button
                style={{ flex:1, padding:12, borderRadius:10, border:`1px solid rgba(255,255,255,0.1)`, background:BG3, color:MT, fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center", gap:5 }}
                onClick={() => { onClose(); setTimeout(() => onOpenCommunity(anime), 120); }}
              >
                <span>💬</span><span>Community</span>
              </button>
            </div>
            <button style={{ width:"100%", padding:13, borderRadius:10, border:"none", background:`linear-gradient(135deg, ${OR}, #cc5610)`, color:"#fff", fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center", gap:6, boxShadow:`0 6px 20px -4px rgba(255,107,26,.5)` }} onClick={() => openUrl(`https://www.crunchyroll.com/search?q=${encodeURIComponent(anime.title)}`)}>
              ▶ Watch on Crunchyroll
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
    const sa = Object.values(b.reactions).reduce((x,y)=>x+y,0);
    const sb = Object.values(a.reactions).reduce((x,y)=>x+y,0);
    return sa - sb;
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
                      <Avatar nickname={post.nickname} color={post.avatar_color} size={22}/>
                      <span style={{ fontSize:12, fontWeight:700, color: post.avatar_color }}>{post.nickname}</span>
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
function ScheduleView({ anime, selectedDay, setSelectedDay, todayDayIdx, dayNavRef, schedule, favs, favFilter, search, tz, onOpen, onToggleFav, tick }: {
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
}) {
  const today = new Date();
  const swipeStartX = useRef(0);
  const swipeStartY = useRef(0);

  const getCount = (i: number) => {
    let list = schedule[DAYS[i]] || [];
    if (favFilter) list = list.filter((a) => favs.includes(a.id));
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

      <div
        style={{ padding:"0 16px 16px" }}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        {anime.length === 0 ? (
          <div style={{ textAlign:"center", padding:"48px 20px", color:MT, display:"flex", flexDirection:"column", alignItems:"center", gap:10 }}>
            <div style={{ fontSize:40 }}>{favFilter ? "⭐" : "📭"}</div>
            <div style={{ fontSize:14, lineHeight:1.5 }}>{favFilter ? "No favorites airing.\nTurn off filter to see all." : "Nothing scheduled."}</div>
          </div>
        ) : (
          Object.entries(groups).map(([time, items]) => {
            let isNow = false, localStr: string | null = null;
            if (time !== "?") {
              const [h, m] = time.split(":").map(Number);
              const utcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h - 9, m);
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
                    {isNow ? "🟢 Live" : time !== "?" ? `${time} JST` : "Time unknown"}
                  </span>
                  {!isNow && localStr && <span style={{ fontSize:10, color:OR, fontWeight:700, flexShrink:0 }}>→ {localStr}</span>}
                  <div style={{ flex:1, height:1, background:BD }}/>
                </div>
                {items.map((a, idx) => (
                  <AnimeCard key={a.id} anime={a} favorites={favs} selectedDayIdx={selectedDay} todayDayIdx={todayDayIdx} tz={tz} onOpen={onOpen} onToggleFav={onToggleFav} animDelay={idx * 30} tick={tick}/>
                ))}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

// ── Month view ─────────────────────────────────────────────────────────────────
function MonthView({ monthOffset, setMonthOffset, schedule, favs, favFilter, search, tz, onOpen, onToggleFav, todayDayIdx, onOpenCommunity }: {
  monthOffset: number;
  setMonthOffset: (fn: (v: number) => number) => void;
  schedule: Schedule;
  favs: number[];
  favFilter: boolean;
  search: string;
  tz: string;
  onOpen: (a: Anime) => void;
  onToggleFav: (id: number) => void;
  todayDayIdx: number;
  onOpenCommunity: (a: Anime) => void;
}) {
  const now = new Date();
  const [selectedDate, setSelectedDate] = useState<Date>(now);
  const selectedDayIdx = (selectedDate.getDay() + 6) % 7;

  // ── Upcoming data (self-loaded) ──
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
    setUpcomingStars((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      LS.set("anical_upcoming_stars", next);
      return next;
    });
  };

  const [calCollapsed, setCalCollapsed] = useState(false);
  const monthDate = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const [mYear, mMon] = [monthDate.getFullYear(), monthDate.getMonth()];
  const currentSeason = monthToSeason(mMon);
  const firstDow = monthDate.getDay();
  const lastDay = new Date(mYear, mMon + 1, 0).getDate();
  const cells: Date[] = [];
  for (let i = -firstDow; i < lastDay; i++) cells.push(new Date(mYear, mMon, i + 1));
  while (cells.length % 7) cells.push(new Date(mYear, mMon + 1, cells.length - lastDay - firstDow + 1));

  const getFiltered = (dayIdx: number) => {
    let list = schedule[DAYS[dayIdx]] || [];
    const seen = new Set<number>();
    list = list.filter((a) => { if (seen.has(a.id)) return false; seen.add(a.id); return true; });
    if (favFilter) list = list.filter((a) => favs.includes(a.id));
    if (search) { const q = search.toLowerCase(); list = list.filter((a) => a.title.toLowerCase().includes(q)); }
    return list.sort((a, b) => (a.broadcast_time || "").localeCompare(b.broadcast_time || ""));
  };

  const selectedAnime = getFiltered(selectedDayIdx);
  const groups: Record<string, Anime[]> = {};
  selectedAnime.forEach((a) => { const k = a.broadcast_time || "?"; if (!groups[k]) groups[k] = []; groups[k].push(a); });

  // Upcoming for this season — also include adjacent seasons from same month range
  const seasonUpcoming = upcoming.filter((a) => {
    if (!a.season || !a.year) return false;
    return a.season.toLowerCase() === currentSeason && a.year === mYear;
  });
  // Season approximate start date (1st of season start month)
  const seasonStartMonth = SEASON_MONTHS[currentSeason];
  const isSeasonStartMonth = mMon === seasonStartMonth;

  return (
    <div style={{ padding:"0 16px 16px" }}>
      {/* Month nav */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"10px 0 8px" }}>
        <button style={{ background:BG3, border:`1px solid ${BD}`, color:MT, borderRadius:8, padding:"6px 14px", fontSize:16, cursor:"pointer", fontFamily:"inherit" }} onClick={() => setMonthOffset((v) => v - 1)}>‹</button>
        <button onClick={() => setCalCollapsed(v => !v)}
          style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:1, background:"none", border:"none", cursor:"pointer", fontFamily:"inherit", padding:"4px 12px" }}>
          <span style={{ fontSize:16, fontWeight:800, color:TX, letterSpacing:"-.3px" }}>{MONTHS[mMon]} {mYear}</span>
          <span style={{ fontSize:10, color:MT }}>{SEASON_EMOJI[currentSeason]} {seasonYear(currentSeason, mYear)} · {calCollapsed ? "show ▾" : "hide ▴"}</span>
        </button>
        <button style={{ background:BG3, border:`1px solid ${BD}`, color:MT, borderRadius:8, padding:"6px 14px", fontSize:16, cursor:"pointer", fontFamily:"inherit" }} onClick={() => setMonthOffset((v) => v + 1)}>›</button>
      </div>

      {/* Calendar grid — collapsible */}
      <div style={{ overflow:"hidden", maxHeight: calCollapsed ? 0 : 540, opacity: calCollapsed ? 0 : 1, transition:"max-height .38s cubic-bezier(.4,0,.2,1), opacity .22s" } as React.CSSProperties}>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:3, marginBottom:3 }}>
          {["Su","Mo","Tu","We","Th","Fr","Sa"].map((d) => <div key={d} style={{ textAlign:"center", fontSize:9, fontWeight:800, color:MT2, letterSpacing:".8px", padding:"4px 0", textTransform:"uppercase" }}>{d}</div>)}
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:3, marginBottom:14 }}>
          {cells.map((date, ci) => {
            const inMonth = date.getMonth() === mMon;
            const isToday = inMonth && date.toDateString() === now.toDateString();
            const isSelected = inMonth && date.toDateString() === selectedDate.toDateString();
            const dayIdx = (date.getDay() + 6) % 7;
            const dayAnime = inMonth ? getFiltered(dayIdx) : [];
            const isSeasonPremiere = inMonth && isSeasonStartMonth && date.getDate() === 1 && seasonUpcoming.length > 0;
            const borderCol = isToday ? OR : isSelected ? "rgba(255,255,255,.55)" : isSeasonPremiere ? "rgba(139,92,246,.55)" : dayAnime.length > 0 ? BD2 : "transparent";
            const bgCol = inMonth ? (isToday ? `rgba(255,107,26,.14)` : isSelected ? BG4 : isSeasonPremiere ? "rgba(139,92,246,.07)" : BG3) : "transparent";
            return (
              <div key={ci}
                style={{ aspectRatio:"1", borderRadius:7, border:`1.5px solid ${borderCol}`, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:2, cursor: inMonth ? "pointer" : "default", padding:2, background: bgCol, opacity: inMonth ? 1 : .12, transition:"background .15s, border-color .15s" }}
                onClick={() => { if (inMonth) setSelectedDate(new Date(date)); }}
              >
                <div style={{ fontSize:11, fontWeight:800, color: isToday ? OR : isSelected ? TX : inMonth ? TX : MT2, lineHeight:1 }}>{date.getDate()}</div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:1.5, justifyContent:"center", maxWidth:26 }}>
                  {dayAnime.slice(0, 4).map((a, j) => <div key={j} style={{ width:4, height:4, borderRadius:"50%", background: favs.includes(a.id) ? OR : BD2 }}/>)}
                  {isSeasonPremiere && <div style={{ width:4, height:4, borderRadius:"50%", background:"rgba(139,92,246,.9)" }}/>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Upcoming this season ── */}
      {(seasonUpcoming.length > 0 || upcomingLoading) && (
        <div style={{ marginBottom:16 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
            <span style={{ fontSize:11, fontWeight:800, letterSpacing:".5px", textTransform:"uppercase", padding:"4px 10px", borderRadius:99, background:"rgba(139,92,246,.12)", color:"rgba(167,139,250,1)", border:"1px solid rgba(139,92,246,.3)", flexShrink:0 }}>
              {SEASON_EMOJI[currentSeason]} {seasonYear(currentSeason, mYear)} · Upcoming
            </span>
            <div style={{ flex:1, height:1, background:BD }}/>
            {!upcomingLoading && <span style={{ fontSize:10, color:MT2, flexShrink:0 }}>{seasonUpcoming.length} announced</span>}
          </div>
          {upcomingLoading ? (
            <div style={{ display:"flex", gap:8, overflowX:"auto", paddingBottom:4 }}>
              {[0,1,2].map(i => <div key={i} className="anical-skel" style={{ width:120, height:160, borderRadius:12, flexShrink:0 }}/>)}
            </div>
          ) : seasonUpcoming.length === 0 ? null : (
            <div style={{ display:"flex", gap:8, overflowX:"auto", paddingBottom:4, scrollbarWidth:"none" } as React.CSSProperties}>
              {seasonUpcoming.map((a, i) => {
                const starred = upcomingStars.includes(a.id);
                return (
                  <div key={a.id} style={{ flexShrink:0, width:110, background: starred ? `rgba(255,107,26,.07)` : BG2, border:`1px solid ${starred ? OR3 : "rgba(139,92,246,.2)"}`, borderRadius:12, overflow:"hidden", cursor:"pointer", animation:`cardIn .35s ${i*40}ms both`, position:"relative" }}
                    onClick={() => onOpenCommunity({ id:a.id, title:a.title, image_url:a.imageUrl ?? null })}>
                    {a.imageUrl
                      ? <img src={a.imageUrl} alt="" style={{ width:"100%", height:140, objectFit:"cover", display:"block" }}/>
                      : <div style={{ width:"100%", height:140, background:BG4, display:"flex", alignItems:"center", justifyContent:"center", fontSize:28 }}>🎬</div>}
                    <div style={{ position:"absolute", top:6, right:6 }}>
                      <button onClick={(e) => { e.stopPropagation(); toggleUpcomingStar(a.id); }}
                        style={{ background:"rgba(0,0,0,.6)", border:"none", color: starred ? OR : "rgba(255,255,255,.6)", fontSize:14, cursor:"pointer", padding:"2px 4px", lineHeight:1, borderRadius:6, fontFamily:"inherit" }}>
                        {starred ? "★" : "☆"}
                      </button>
                    </div>
                    <div style={{ padding:"6px 8px 8px" }}>
                      <div style={{ fontSize:11, fontWeight:700, lineHeight:1.3, color:TX, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" as const }}>{a.title}</div>
                      <div style={{ fontSize:9, color:"rgba(167,139,250,.8)", fontWeight:700, marginTop:3 }}>~{MONTHS[SEASON_MONTHS[currentSeason]]} {mYear}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Selected day schedule ── */}
      <div style={{ borderTop:`1px solid ${BD}`, paddingTop:12 }}>
        <div style={{ fontSize:14, fontWeight:700, marginBottom:12 }}>
          {selectedDate.toLocaleDateString([], { day:"numeric", month:"short" })}
          <span style={{ fontWeight:400, color:MT, marginLeft:6 }}>— {DAY_SHORT[selectedDayIdx]}'s shows ({selectedAnime.length})</span>
        </div>
        {selectedAnime.length === 0 ? (
          <div style={{ textAlign:"center", padding:"24px 20px", color:MT, display:"flex", flexDirection:"column", alignItems:"center", gap:8 }}>
            <div style={{ fontSize:32 }}>📭</div>
            <div style={{ fontSize:13 }}>Nothing scheduled.</div>
          </div>
        ) : (
          Object.entries(groups).map(([time, items]) => (
            <div key={time}>
              <div style={{ display:"flex", alignItems:"center", gap:8, padding:"10px 0 6px" }}>
                <span style={{ fontSize:10, fontWeight:800, letterSpacing:".5px", textTransform:"uppercase", padding:"3px 10px", borderRadius:99, background:BG3, color:MT, border:`1px solid ${BD}`, flexShrink:0 }}>
                  {time !== "?" ? `${time} JST` : "Time unknown"}
                </span>
                <div style={{ flex:1, height:1, background:BD }}/>
              </div>
              {items.map((a, idx) => (
                <AnimeCard key={a.id} anime={a} favorites={favs} selectedDayIdx={selectedDayIdx} todayDayIdx={todayDayIdx} tz={tz} onOpen={onOpen} onToggleFav={onToggleFav} animDelay={idx * 25}/>
              ))}
            </div>
          ))
        )}
      </div>
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
function NewsCard({ item, delay = 0, onOpen }: { item: NewsItem; delay?: number; onOpen: (n: NewsItem) => void }) {
  const age = formatNewsAge(item.date);
  return (
    <div
      className="anical-card"
      onClick={() => onOpen(item)}
      style={{ display:"flex", gap:10, padding:12, background:BG2, border:`1px solid ${BD}`, borderRadius:14, cursor:"pointer", marginBottom:8, overflow:"hidden", animation:`cardIn .4s ${delay}ms cubic-bezier(.2,.7,.2,1) both`, transition:"transform .15s" }}
    >
      {item.imageUrl
        ? <img src={item.imageUrl} alt="" loading="lazy" style={{ width:72, height:72, borderRadius:10, objectFit:"cover", flexShrink:0, background:BG4 }}/>
        : <div style={{ width:72, height:72, borderRadius:10, background:BG4, display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, flexShrink:0, color:MT2 }}>📰</div>}
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:5, marginBottom:5, flexWrap:"wrap" as const }}>
          <span style={{ fontSize:9, fontWeight:800, padding:"2px 6px", borderRadius:4, background:item.source==="ANN"?OR2:BG3, color:item.source==="ANN"?OR:MT, border:`1px solid ${item.source==="ANN"?OR3:BD}`, textTransform:"uppercase" as const, letterSpacing:".5px" }}>{item.source}</span>
          {item.animeTitle && <span style={{ fontSize:10, color:OR, fontWeight:700, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" as const, maxWidth:110 }}>{item.animeTitle}</span>}
          {age && <span style={{ fontSize:10, color:MT2, marginLeft:"auto", flexShrink:0 }}>{age}</span>}
        </div>
        <div style={{ fontSize:13, fontWeight:700, lineHeight:1.3, color:TX, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" as const, marginBottom:5 }}>{item.title}</div>
        {item.excerpt && <div style={{ fontSize:11, color:MT, lineHeight:1.5, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" as const }}>{item.excerpt}</div>}
        <div style={{ marginTop:5, fontSize:10, color:MT2, display:"flex", alignItems:"center", gap:3 }}>
          <span>Tap to expand</span><span style={{ fontSize:9 }}>›</span>
        </div>
      </div>
    </div>
  );
}

// ── News detail sheet ──────────────────────────────────────────────────────────
function NewsDetailSheet({ item, onClose }: { item: NewsItem; onClose: () => void }) {
  const age = formatNewsAge(item.date);
  const isANN = item.source === "ANN";
  return (
    <>
      <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.84)", zIndex:200, backdropFilter:"blur(8px)" } as React.CSSProperties} onClick={onClose}/>
      <div style={{ position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)", width:"100%", maxWidth:480, background:BG2, borderRadius:"22px 22px 0 0", border:`1px solid ${BD}`, borderBottom:"none", maxHeight:"90vh", overflowY:"auto", zIndex:201, animation:"sheetUp .3s cubic-bezier(.2,.7,.2,1)" }}>
        <div style={{ width:36, height:4, background:BD2, borderRadius:2, margin:"14px auto 0" }}/>

        {/* Hero image */}
        {item.imageUrl ? (
          <div style={{ position:"relative", margin:"14px 0 0", height:200, overflow:"hidden" }}>
            <img src={item.imageUrl} alt="" style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }}/>
            <div style={{ position:"absolute", inset:0, background:"linear-gradient(to bottom, transparent 45%, rgba(17,17,25,.95))" }}/>
            {/* Source badge over image */}
            <div style={{ position:"absolute", top:12, left:16 }}>
              <span style={{ fontSize:9, fontWeight:800, padding:"3px 8px", borderRadius:4, background: isANN ? OR : BG4, color: isANN ? "#fff" : MT, border:`1px solid ${isANN ? OR : BD}`, textTransform:"uppercase" as const, letterSpacing:".8px", backdropFilter:"blur(8px)" }}>{item.source}</span>
            </div>
          </div>
        ) : (
          <div style={{ height:8 }}/>
        )}

        <div style={{ padding: item.imageUrl ? "0 20px 48px" : "16px 20px 48px" }}>
          {/* Meta row */}
          <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" as const, marginBottom:12, marginTop: item.imageUrl ? -4 : 0 }}>
            {!item.imageUrl && <span style={{ fontSize:9, fontWeight:800, padding:"3px 8px", borderRadius:4, background:isANN?OR2:BG3, color:isANN?OR:MT, border:`1px solid ${isANN?OR3:BD}`, textTransform:"uppercase" as const, letterSpacing:".6px" }}>{item.source}</span>}
            {item.animeTitle && (
              <span style={{ fontSize:11, fontWeight:700, padding:"3px 9px", borderRadius:99, background:OR2, color:OR, border:`1px solid ${OR3}` }}>{item.animeTitle}</span>
            )}
            {age && <span style={{ fontSize:10, color:MT2, marginLeft:"auto" }}>{age}</span>}
          </div>

          {/* Title */}
          <div style={{ fontSize:20, fontWeight:800, lineHeight:1.3, color:TX, marginBottom:16 }}>{item.title}</div>

          {/* Divider */}
          <div style={{ height:1, background:BD, marginBottom:16 }}/>

          {/* Full excerpt */}
          {item.excerpt ? (
            <div style={{ fontSize:14, lineHeight:1.8, color:"rgba(242,242,250,.8)", marginBottom:28, whiteSpace:"pre-wrap" as const }}>{item.excerpt}</div>
          ) : (
            <div style={{ fontSize:13, color:MT2, marginBottom:28, fontStyle:"italic" as const }}>No preview available — open the full article to read.</div>
          )}

          {/* CTA button */}
          <button
            onClick={() => openUrl(item.url)}
            style={{ width:"100%", padding:"14px 20px", borderRadius:12, border:"none", background:`linear-gradient(135deg, ${OR}, #cc5610)`, color:"#fff", fontSize:15, fontWeight:700, cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center", gap:8, boxShadow:`0 8px 24px -6px rgba(255,107,26,.5)` } as React.CSSProperties}
          >
            <span>Read Full Article</span>
            <span style={{ fontSize:16 }}>↗</span>
          </button>

          {/* Source label */}
          <div style={{ textAlign:"center", fontSize:10, color:MT2, marginTop:10 }}>
            via {item.source === "ANN" ? "Anime News Network" : "MyAnimeList"}
          </div>
        </div>
      </div>
    </>
  );
}

// ── News skeleton ──────────────────────────────────────────────────────────────
function NewsSkeleton() {
  return (
    <div style={{ display:"flex", gap:10, padding:12, background:BG2, border:`1px solid ${BD}`, borderRadius:14, marginBottom:8 }}>
      <div className="anical-skel" style={{ width:72, height:72, borderRadius:10, flexShrink:0 }}/>
      <div style={{ flex:1, display:"flex", flexDirection:"column", gap:7, justifyContent:"center" }}>
        <div className="anical-skel" style={{ height:11, borderRadius:4, width:"20%" }}/>
        <div className="anical-skel" style={{ height:13, borderRadius:4, width:"88%" }}/>
        <div className="anical-skel" style={{ height:11, borderRadius:4, width:"65%" }}/>
      </div>
    </div>
  );
}

// ── Community view ─────────────────────────────────────────────────────────────
function CommunityView({ favAnime, onOpenCommunity }: { favAnime: Anime[]; onOpenCommunity: (a: Anime) => void }) {
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
        <div style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)", pointerEvents:"none", color:MT2, fontSize:13 }}>
          <svg width={14} height={14} viewBox="0 0 20 20" fill="none" style={{ opacity:.5 }}>
            <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.8"/>
            <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
          </svg>
        </div>
        <input
          style={{ width:"100%", background:"rgba(255,255,255,0.06)", border:`1px solid ${search ? "rgba(255,107,26,.35)" : "rgba(255,255,255,0.09)"}`, borderRadius:12, padding:"10px 12px 10px 34px", color:TX, fontSize:14, fontFamily:"inherit", outline:"none", boxSizing:"border-box" } as React.CSSProperties}
          placeholder="Search anime communities…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && <button onClick={() => setSearch("")} style={{ position:"absolute", right:10, top:"50%", transform:"translateY(-50%)", background:"rgba(255,255,255,.12)", border:"none", color:MT, width:20, height:20, borderRadius:"50%", cursor:"pointer", fontSize:10, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"inherit" }}>✕</button>}
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
          return (
            <div key={t.anime_id}
              onClick={() => onOpenCommunity({ id:t.anime_id, title:t.anime_title, image_url: favMatch?.image_url ?? null })}
              style={{ display:"flex", alignItems:"center", gap:12, padding:"11px 14px", background:BG2, border:`1px solid ${BD}`, borderRadius:14, marginBottom:8, cursor:"pointer", animation:`cardIn .35s ${Math.min(i*30,300)}ms both`, transition:"transform .15s" }}
              className="anical-card">
              {favMatch?.image_url
                ? <img src={favMatch.image_url} alt="" style={{ width:44, height:44, borderRadius:"50%", objectFit:"cover", flexShrink:0, border:`1px solid ${BD2}` }}/>
                : <div style={{ width:44, height:44, borderRadius:"50%", background:`linear-gradient(135deg, #7c3aed, #4f46e5)`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, flexShrink:0 }}>💬</div>}
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:13, fontWeight:700, color:TX, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" as const }}>{t.anime_title}</div>
                <div style={{ fontSize:10, color:MT2, marginTop:2 }}>{formatNewsAge(t.last_post)} · {t.post_count} post{t.post_count === 1 ? "" : "s"}</div>
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
function NewsView({ favAnime }: { favAnime: any[] }) {
  const [annNews, setAnnNews] = useState<NewsItem[]>([]);
  const [favNews, setFavNews] = useState<NewsItem[]>([]);
  const [annLoading, setAnnLoading] = useState(true);
  const [favLoading, setFavLoading] = useState(true);
  const [annError, setAnnError] = useState(false);
  const [detailNews, setDetailNews] = useState<NewsItem | null>(null);

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

  const SectionHeader = ({ emoji, title, count, accent }: { emoji: string; title: string; count?: number; accent?: boolean }) => (
    <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:12, fontSize:12, fontWeight:700, color: accent ? OR : MT, textTransform:"uppercase" as const, letterSpacing:".8px" }}>
      <span style={{ fontSize:14 }}>{emoji}</span><span>{title}</span>
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
        <button onClick={loadAnn} style={{ background:BG3, border:`1px solid ${BD}`, color:MT, borderRadius:10, padding:"7px 12px", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit" }}>↻</button>
      </div>

      {/* ── Your Shows News ── */}
      {favAnime.length > 0 && (
        <div style={{ marginBottom:28 }}>
          <SectionHeader emoji="⭐" title="Your Shows" count={favNews.length} accent/>
          {favLoading ? [0,1,2].map((i) => <NewsSkeleton key={i}/>) :
           favNews.length === 0 ? <div style={{ textAlign:"center", padding:"20px 0", color:MT, fontSize:13 }}>No recent news for your shows.</div> :
           favNews.map((n, i) => <NewsCard key={n.id} item={n} delay={i * 25} onOpen={setDetailNews}/>)}
        </div>
      )}

      {/* ── Industry News ── */}
      <div>
        <SectionHeader emoji="📡" title="Industry News" count={!annLoading ? annNews.length : undefined}/>
        {annLoading ? [0,1,2,3].map((i) => <NewsSkeleton key={i}/>) :
         annError ? (
           <div style={{ textAlign:"center", padding:"32px 0", color:MT, display:"flex", flexDirection:"column", alignItems:"center", gap:10 }}>
             <div style={{ fontSize:32 }}>📡</div>
             <div style={{ fontSize:13 }}>Couldn't reach the news feed.</div>
             <button onClick={loadAnn} style={{ background:BG3, border:`1px solid ${OR}`, color:OR, borderRadius:8, padding:"7px 16px", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit" }}>Retry</button>
           </div>
         ) :
         annNews.map((n, i) => <NewsCard key={n.id} item={n} delay={i * 20} onOpen={setDetailNews}/>)}
      </div>

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

    </div>
  );
}

// ── Bottom nav ─────────────────────────────────────────────────────────────────
function BottomNav({ view, setView, favCount }: { view: string; setView: (v: "schedule"|"month"|"community"|"news"|"stats") => void; favCount: number }) {
  const tabs: { id: "schedule"|"month"|"community"|"news"|"stats"; emoji: string; label: string }[] = [
    { id:"schedule",  emoji:"📋", label:"Schedule"  },
    { id:"month",     emoji:"📅", label:"Calendar"  },
    { id:"community", emoji:"💬", label:"Community" },
    { id:"news",      emoji:"📰", label:"News"      },
    { id:"stats",     emoji:"⭐", label:"My List"   },
  ];
  return (
    <nav className="anical-bottom-nav" style={{ position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)", width:"100%", maxWidth:480, zIndex:100, background:`rgba(9,9,15,0.92)`, backdropFilter:"blur(24px) saturate(1.4)", borderTop:`1px solid rgba(37,37,51,0.8)`, display:"flex" } as React.CSSProperties}>
      {tabs.map((tab) => {
        const active = view === tab.id;
        return (
          <button
            key={tab.id}
            className="anical-navbtn"
            onClick={() => setView(tab.id)}
            style={{ flex:1, background:"none", border:"none", cursor:"pointer", fontFamily:"inherit", display:"flex", flexDirection:"column", alignItems:"center", gap:3, padding:"10px 0 12px", position:"relative" }}
          >
            {active && <div style={{ position:"absolute", top:0, left:"50%", transform:"translateX(-50%)", width:28, height:3, background:OR, borderRadius:"0 0 3px 3px" }}/>}
            <span style={{ fontSize:22, filter: active ? "none" : "grayscale(1) brightness(0.45)", transition:"filter .2s", display:"block", lineHeight:1 }}>{tab.emoji}</span>
            <span style={{ fontSize:10, fontWeight:700, letterSpacing:".5px", textTransform:"uppercase", color: active ? OR : MT2, transition:"color .2s" }}>{tab.label}</span>
            {tab.id === "stats" && favCount > 0 && (
              <span style={{ position:"absolute", top:6, left:"calc(50% + 6px)", background:OR, color:"#fff", fontSize:8, fontWeight:800, padding:"1px 5px", borderRadius:99, lineHeight:1.5, animation:`popIn .3s cubic-bezier(.2,.7,.2,1) both` }}>{favCount}</span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

// ── Pull indicator ─────────────────────────────────────────────────────────────
function PullIndicator({ visible, spinning }: { visible: boolean; spinning: boolean }) {
  return (
    <div style={{ position:"fixed", top:66, left:"50%", transform:`translateX(-50%) translateY(${visible || spinning ? 0 : -64}px) scale(${visible || spinning ? 1 : 0.6})`, transition:"transform .3s cubic-bezier(.2,.7,.2,1)", zIndex:60, width:36, height:36, borderRadius:"50%", background:`linear-gradient(135deg, ${OR}, #cc5610)`, display:"flex", alignItems:"center", justifyContent:"center", boxShadow:`0 4px 20px rgba(255,107,26,.5)` }}>
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
  const [monthOffset, setMonthOffset] = useState(0);
  const [favs, setFavs] = useState<number[]>([]);
  const [favFilter, setFavFilter] = useState(false);
  const [search, setSearch] = useState("");
  const [detailAnime, setDetailAnime] = useState<Anime | null>(null);
  const [communityAnime, setCommunityAnime] = useState<Anime | null>(null);
  const [toast, setToast] = useState({ show: false, msg: "" });
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

  const loadSchedule = useCallback(async (force = false, silent = false) => {
    if (!force) {
      const cached = LS.get<{ ts: number; data: Schedule } | null>("anical_schedule_cache", null);
      if (cached && Date.now() - cached.ts < CACHE_TTL) {
        setSchedule(cached.data);
        setLastUpdated(new Date(cached.ts));
        setBoot("ready");
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
        await new Promise((r) => setTimeout(r, 350));
      }
      setLoadProgress(100);
      setSchedule(result);
      const ts = Date.now();
      setLastUpdated(new Date(ts));
      LS.set("anical_schedule_cache", { data: result, ts });
      setTimeout(() => setBoot("ready"), 250);
    } catch (e: any) {
      if (!silent) { setError(e.message || "Failed to load"); setBoot("error"); }
    } finally {
      isLoadingRef.current = false;
    }
  }, []);

  useEffect(() => { if (boot === "loading") loadSchedule(); }, [boot, loadSchedule]);

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
    if (search) { const q = search.toLowerCase(); list = list.filter((a) => a.title.toLowerCase().includes(q)); }
    return list.sort((a, b) => (a.broadcast_time || "").localeCompare(b.broadcast_time || ""));
  }, [schedule, favFilter, search, favs]);

  const favAnime = useMemo(() =>
    DAYS.flatMap((d, i) => (schedule[d] || []).filter((a) => favs.includes(a.id)).map((a) => ({ ...a, dayIdx: i })))
      .filter((a, i, arr) => arr.findIndex((x) => x.id === a.id) === i),
    [schedule, favs]);

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

      {boot === "loading" && (
        <div style={{ fontFamily:"'Outfit',system-ui,sans-serif", background:BG, minHeight:"100vh", color:TX, maxWidth:480, margin:"0 auto", position:"relative" }}>
          <LoadingView progress={loadProgress} msg={loadMsg}/>
        </div>
      )}

      {boot === "error" && (
        <div style={{ fontFamily:"'Outfit',system-ui,sans-serif", background:BG, minHeight:"100vh", color:TX, maxWidth:480, margin:"0 auto", position:"relative" }}>
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"60px 20px", gap:16, minHeight:"50vh" }}>
            <div style={{ fontSize:40 }}>⚠️</div>
            <div style={{ fontSize:16, fontWeight:600 }}>Failed to load</div>
            <div style={{ fontSize:12, color:MT, textAlign:"center", lineHeight:1.6 }}>{error}</div>
            <button style={{ background:BG3, border:`1px solid ${OR}`, color:OR, borderRadius:10, padding:"9px 20px", fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:"inherit", marginTop:8 }} onClick={() => loadSchedule(true)}>Try Again</button>
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
          <div style={{ position:"sticky", top:0, zIndex:50, background:"rgba(9,9,15,0.82)", backdropFilter:"blur(32px) saturate(1.6)", borderBottom:"1px solid rgba(255,255,255,0.055)" } as React.CSSProperties}>
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
                {/* Favs filter — only on schedule/calendar */}
                {(view === "schedule" || view === "month") && (
                  <button
                    onClick={() => setFavFilter((v) => !v)}
                    style={{ display:"flex", alignItems:"center", gap:5, padding:"7px 12px", borderRadius:20, border:`1px solid ${favFilter ? OR : "rgba(255,255,255,0.1)"}`, background: favFilter ? `linear-gradient(135deg, ${OR2}, rgba(255,107,26,0.12))` : "rgba(255,255,255,0.05)", color: favFilter ? OR : MT, fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"inherit", transition:"all .18s", boxShadow: favFilter ? `0 0 12px rgba(255,107,26,.25)` : "none", letterSpacing:".3px" } as React.CSSProperties}
                  >
                    <span style={{ fontSize:13 }}>{favFilter ? "★" : "☆"}</span>
                    <span>Favs</span>
                  </button>
                )}
                {/* Refresh — only on schedule/calendar */}
                {(view === "schedule" || view === "month") && (
                  <button
                    onClick={() => loadSchedule(true)}
                    style={{ width:34, height:34, borderRadius:"50%", border:"1px solid rgba(255,255,255,0.1)", background:"rgba(255,255,255,0.05)", color:MT, fontSize:16, cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center", transition:"all .18s" } as React.CSSProperties}
                  >↻</button>
                )}
              </div>
            </div>

            {/* Search bar — only on schedule/calendar */}
            {(view === "schedule" || view === "month") && (
            <div style={{ padding:"0 16px 10px", position:"relative" } as React.CSSProperties}>
              <div style={{ position:"absolute", left:28, top:"50%", transform:"translateY(-50%)", pointerEvents:"none", color:MT2, fontSize:14, display:"flex" }}>
                <svg width={15} height={15} viewBox="0 0 20 20" fill="none" style={{ opacity:.5 }}>
                  <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.8"/>
                  <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                </svg>
              </div>
              <input
                style={{ width:"100%", background:"rgba(255,255,255,0.06)", border:`1px solid ${search ? "rgba(255,107,26,0.35)" : "rgba(255,255,255,0.09)"}`, borderRadius:14, padding:"10px 36px 10px 36px", color:TX, fontSize:14, fontFamily:"inherit", outline:"none", boxSizing:"border-box", transition:"border-color .2s", letterSpacing:".1px" } as React.CSSProperties}
                placeholder="Search anime…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  style={{ position:"absolute", right:28, top:"50%", transform:"translateY(-50%)", background:"rgba(255,255,255,0.12)", border:"none", color:MT, width:20, height:20, borderRadius:"50%", cursor:"pointer", fontSize:10, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"inherit" } as React.CSSProperties}
                >✕</button>
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

          {/* Main content */}
          <div style={{ padding:"0 0 88px" }}>
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
              />
            )}
            {view === "month" && (
              <MonthView
                monthOffset={monthOffset}
                setMonthOffset={setMonthOffset}
                schedule={schedule}
                favs={favs}
                favFilter={favFilter}
                search={search}
                tz={tz}
                onOpen={setDetailAnime}
                onToggleFav={toggleFav}
                todayDayIdx={todayDayIdx}
                onOpenCommunity={(a) => { setCommunityAnime(a); }}
              />
            )}
            {view === "community" && (
              <CommunityView favAnime={favAnime} onOpenCommunity={(a) => setCommunityAnime(a)}/>
            )}
            {view === "news" && (
              <NewsView favAnime={favAnime}/>
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

          {/* Bottom navigation */}
          <BottomNav view={view} setView={setView} favCount={favs.length}/>

          {/* Detail sheet */}
          {detailAnime && (
            <DetailSheet anime={detailAnime} favorites={favs} tz={tz}
              onClose={() => setDetailAnime(null)}
              onToggleFav={(id: number) => { toggleFav(id); setDetailAnime((a) => (a ? { ...a } : null)); }}
              onOpenCommunity={(a) => { setDetailAnime(null); setCommunityAnime(a); }}/>
          )}

          {/* Community thread sheet */}
          {communityAnime && (
            <CommunitySheet anime={communityAnime} onClose={() => setCommunityAnime(null)}/>
          )}

          {/* Toast */}
          <div style={{ position:"fixed", bottom:100, left:"50%", transform:`translateX(-50%) translateY(${toast.show ? 0 : 12}px)`, background:`rgba(17,17,25,0.96)`, border:`1px solid ${BD2}`, backdropFilter:"blur(16px)", borderRadius:10, padding:"9px 20px", fontSize:13, fontWeight:600, color:TX, opacity: toast.show ? 1 : 0, transition:"all .3s cubic-bezier(.2,.7,.2,1)", pointerEvents:"none", zIndex:300, whiteSpace:"nowrap" } as React.CSSProperties}>
            {toast.msg}
          </div>
        </div>
      )}
    </>
  );
}

