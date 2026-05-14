import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Capacitor } from "@capacitor/core";
import * as notif from "@/lib/notifications";
import type { ScheduleEntry } from "@/lib/notifications";

const IS_NATIVE = Capacitor.isNativePlatform(); // true on Android & iOS

function openUrl(url: string) {
  // '_system' routes through the OS intent/universal-link handler so the
  // Crunchyroll app opens automatically if it's installed on the device.
  window.open(url, IS_NATIVE ? "_system" : "_blank");
}

// ── Constants ───────────────────────────────────────────────────────────────
const DAYS = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"] as const;
const DAY_SHORT = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const LEAD_OPTIONS = [0, 5, 10, 15, 30, 60];
const CACHE_TTL = 4 * 3600 * 1000;

const OR  = "#F47521";
const OR2 = "rgba(244,117,33,0.15)";
const OR3 = "rgba(244,117,33,0.35)";
const BG  = "#0d0d12";
const BG2 = "#141419";
const BG3 = "#1b1b23";
const BG4 = "#22222c";
const BD  = "#2c2c38";
const BD2 = "#38384a";
const TX  = "#f0f0f8";
const MT  = "#8888a8";
const MT2 = "#55556a";
const GR  = "#22c55e";

// ── Types ────────────────────────────────────────────────────────────────────
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

const DEFAULT_NOTIF: NotifSettings = { enabled: false, leadMinutes: 10, perAnime: {} };

// ── Timezone presets ─────────────────────────────────────────────────────────
const TZ_PRESETS: { label: string; tz: string }[] = [
  { label: "🌐 Auto (device)", tz: "auto" },
  { label: "🇯🇵 Japan (JST)", tz: "Asia/Tokyo" },
  { label: "🇺🇸 US East (NY)", tz: "America/New_York" },
  { label: "🇺🇸 US Central", tz: "America/Chicago" },
  { label: "🇺🇸 US West (LA)", tz: "America/Los_Angeles" },
  { label: "🇬🇧 UK (London)", tz: "Europe/London" },
  { label: "🇩🇪 CET (Berlin)", tz: "Europe/Berlin" },
  { label: "🇪🇸 Madrid", tz: "Europe/Madrid" },
  { label: "🇮🇳 India (IST)", tz: "Asia/Kolkata" },
  { label: "🇮🇩 Jakarta (WIB)", tz: "Asia/Jakarta" },
  { label: "🇸🇬 Singapore", tz: "Asia/Singapore" },
  { label: "🇵🇭 Manila", tz: "Asia/Manila" },
  { label: "🇰🇷 Seoul (KST)", tz: "Asia/Seoul" },
  { label: "🇨🇳 Shanghai", tz: "Asia/Shanghai" },
  { label: "🇹🇭 Bangkok", tz: "Asia/Bangkok" },
  { label: "🇦🇺 Sydney", tz: "Australia/Sydney" },
  { label: "🇧🇷 São Paulo", tz: "America/Sao_Paulo" },
  { label: "🇲🇽 Mexico City", tz: "America/Mexico_City" },
  { label: "🇦🇪 Dubai", tz: "Asia/Dubai" },
];

// ── Utilities ────────────────────────────────────────────────────────────────
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

// localStorage + chrome.storage bridge
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

// ── Styles ───────────────────────────────────────────────────────────────────
const S = {
  app: { fontFamily:"'Outfit',system-ui,sans-serif", background:BG, minHeight:"100vh", color:TX, maxWidth:480, margin:"0 auto", position:"relative" as const },
  header: { position:"sticky" as const, top:0, zIndex:50, background:BG, borderBottom:`1px solid ${BD}`, padding:"14px 16px 0" },
  headerTop: { display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 },
  logo: { display:"flex", alignItems:"center", gap:8, fontSize:20, fontWeight:800, letterSpacing:"-0.5px" },
  logoAccent: { color:OR },
  actions: { display:"flex", gap:8 },
  iconBtn: { background:BG3, border:`1px solid ${BD}`, color:MT, borderRadius:8, padding:"6px 12px", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit" },
  iconBtnActive: { background:OR2, border:`1px solid ${OR3}`, color:OR },
  tabs: { display:"flex", gap:0, margin:"0 -16px", padding:"0 16px", overflowX:"auto" as const, scrollbarWidth:"none" as const },
  tab: { flexShrink:0, padding:"8px 22px", fontSize:14, fontWeight:600, color:MT, border:"none", background:"none", cursor:"pointer", fontFamily:"inherit", borderBottom:`2px solid transparent` },
  tabActive: { color:TX, borderBottom:`2px solid ${OR}` },
  searchWrap: { padding:"10px 16px", background:BG },
  searchInput: { width:"100%", background:BG3, border:`1px solid ${BD}`, borderRadius:8, padding:"9px 14px", color:TX, fontSize:14, fontFamily:"inherit", outline:"none", boxSizing:"border-box" as const },
  main: { padding:"0 0 80px" },
  dayNav: { display:"flex", gap:6, padding:"12px 16px", overflowX:"auto" as const, scrollbarWidth:"none" as const, background:BG },
  dayPill: (active: boolean, today: boolean) => ({
    flexShrink:0, display:"flex", flexDirection:"column" as const, alignItems:"center", gap:2,
    padding:"8px 12px", borderRadius:8, border:`1px solid ${active ? OR : today ? OR3 : BD}`,
    cursor:"pointer", background: active ? OR : BG2, minWidth:52, transition:"all .2s",
  }),
  dayPillName: (active: boolean, today: boolean) => ({ fontSize:10, fontWeight:700, letterSpacing:".8px", textTransform:"uppercase" as const, color: active ? "rgba(255,255,255,.8)" : today ? OR : MT }),
  dayPillNum: (active: boolean) => ({ fontSize:18, fontWeight:700, color: active ? "#fff" : TX }),
  dayPillCount: (active: boolean) => ({ fontSize:10, fontWeight:500, color: active ? "rgba(255,255,255,.6)" : MT2 }),
  listWrap: { padding:"0 16px 16px" },
  timeLabel: { fontSize:11, fontWeight:700, color:MT, letterSpacing:".6px", textTransform:"uppercase" as const, padding:"12px 0 6px", display:"flex", alignItems:"center", gap:8 },
  timeLabelLine: { flex:1, height:1, background:BD },
  localTime: { color:OR, fontSize:10, fontWeight:600 },
  card: (fav: boolean, now: boolean) => ({
    background: fav ? `rgba(244,117,33,.07)` : BG2,
    border: `1px solid ${fav ? OR3 : now ? "rgba(34,197,94,.35)" : BD}`,
    borderRadius:12, display:"flex", gap:12, padding:12, marginBottom:8,
    cursor:"pointer", position:"relative" as const, overflow:"hidden" as const, transition:"transform .15s, border-color .2s",
  }),
  thumb: { width:52, height:72, borderRadius:6, objectFit:"cover" as const, flexShrink:0, background:BG4 },
  thumbPlaceholder: { width:52, height:72, borderRadius:6, flexShrink:0, background:BG4, display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, color:MT2 },
  cardInfo: { flex:1, minWidth:0, display:"flex", flexDirection:"column" as const, gap:4 },
  cardTitle: { fontSize:14, fontWeight:700, lineHeight:1.3, color:TX, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" as const },
  cardMeta: { display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" as const },
  score: { fontSize:12, fontWeight:700, color:OR },
  epBadge: { fontSize:11, color:MT, background:BG4, padding:"2px 6px", borderRadius:4, fontWeight:600 },
  genre: { fontSize:11, color:MT },
  airRow: { fontSize:12, fontWeight:600, color:TX, display:"flex", alignItems:"center", gap:4, marginTop:2 },
  airJst: { fontSize:10, color:MT, fontWeight:400 },
  airLocal: { fontSize:11, color:OR, fontWeight:600 },
  favBtn: (fav: boolean) => ({ flexShrink:0, alignSelf:"flex-start" as const, background:"none", border:"none", cursor:"pointer", fontSize:20, padding:2, lineHeight:1, color: fav ? OR : MT2, fontFamily:"inherit" }),
  pulse: { position:"absolute" as const, top:8, right:8, width:7, height:7, borderRadius:"50%", background:GR },
  empty: { textAlign:"center" as const, padding:"48px 20px", color:MT, display:"flex", flexDirection:"column" as const, alignItems:"center", gap:10 },
  emptyIcon: { fontSize:36 },
  emptyText: { fontSize:14, lineHeight:1.5 },
  monthWrap: { padding:"0 16px 16px" },
  monthNav: { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 0" },
  monthLabel: { fontSize:17, fontWeight:700 },
  monthNavBtn: { background:BG3, border:`1px solid ${BD}`, color:MT, borderRadius:8, padding:"6px 14px", fontSize:16, cursor:"pointer", fontFamily:"inherit" },
  monthGridHeader: { display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:4, marginBottom:4 },
  monthGridHeaderCell: { textAlign:"center" as const, fontSize:10, fontWeight:700, color:MT, letterSpacing:".8px", padding:"4px 0", textTransform:"uppercase" as const },
  monthGrid: { display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:4, marginBottom:20 },
  monthCell: (today: boolean, inMonth: boolean, hasAnime: boolean) => ({
    aspectRatio:"1", borderRadius:6, border:`1px solid ${today ? OR : hasAnime ? BD2 : "transparent"}`,
    display:"flex", flexDirection:"column" as const, alignItems:"center", justifyContent:"center",
    gap:2, cursor: hasAnime ? "pointer" : "default", padding:2,
    background: inMonth ? BG2 : "transparent", opacity: inMonth ? 1 : .25,
  }),
  monthCellNum: (today: boolean) => ({ fontSize:12, fontWeight:700, color: today ? OR : TX, lineHeight:1 }),
  monthDots: { display:"flex", flexWrap:"wrap" as const, gap:2, justifyContent:"center", maxWidth:32 },
  dot: (fav: boolean) => ({ width:5, height:5, borderRadius:"50%", background: fav ? OR : BD2 }),
  monthCount: { fontSize:9, color:MT2, fontWeight:600 },
  sheetBackdrop: { position:"fixed" as const, inset:0, background:"rgba(0,0,0,.75)", zIndex:200, animation:"fadeIn .2s ease-out" },
  sheetContent: { position:"fixed" as const, bottom:0, left:"50%", transform:"translateX(-50%)", width:"100%", maxWidth:480, background:BG2, borderRadius:"20px 20px 0 0", border:`1px solid ${BD}`, borderBottom:"none", maxHeight:"85vh", overflowY:"auto" as const, zIndex:201, animation:"sheetUp .3s cubic-bezier(.2,.7,.2,1)" },
  sheetHandle: { width:40, height:4, background:BD2, borderRadius:2, margin:"12px auto 0" },
  sheetBody: { padding:"16px 20px 40px" },
  sheetImg: { width:"100%", height:200, objectFit:"cover" as const, objectPosition:"top", borderRadius:12, marginBottom:16, background:BG4 },
  sheetTitle: { fontSize:20, fontWeight:800, lineHeight:1.2, marginBottom:8 },
  sheetMeta: { display:"flex", gap:8, flexWrap:"wrap" as const, marginBottom:12 },
  badge: (accent: boolean) => ({ fontSize:11, fontWeight:600, padding:"3px 8px", borderRadius:4, background: accent ? OR2 : BG4, color: accent ? OR : MT, border:`1px solid ${accent ? OR3 : BD}` }),
  airtimeBox: { background:BG3, border:`1px solid ${BD}`, borderRadius:8, padding:"12px 14px", marginBottom:12 },
  airtimeTitle: { fontSize:11, fontWeight:700, color:MT, textTransform:"uppercase" as const, letterSpacing:".6px", marginBottom:6 },
  airtimeRow: { display:"flex", justifyContent:"space-between", alignItems:"center" },
  airtimeItem: { display:"flex", flexDirection:"column" as const, alignItems:"center", gap:2 },
  airtimeVal: { fontSize:16, fontWeight:700 },
  airtimeSub: { fontSize:10, color:MT },
  synopsis: { fontSize:13, lineHeight:1.65, color:MT, marginBottom:16 },
  sheetActions: { display:"flex", gap:8 },
  sheetFavBtn: (fav: boolean) => ({ flex:1, padding:12, borderRadius:8, border:`1px solid ${fav ? OR : BD}`, background: fav ? OR2 : BG3, color: fav ? OR : MT, fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }),
  sheetCrBtn: { flex:1.5, padding:12, borderRadius:8, border:"none", background:OR, color:"#fff", fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center", gap:6 },
  toast: (show: boolean) => ({ position:"fixed" as const, bottom:84, left:"50%", transform:`translateX(-50%) translateY(${show ? 0 : 12}px)`, background:BG3, border:`1px solid ${BD2}`, borderRadius:8, padding:"8px 18px", fontSize:13, fontWeight:600, color:TX, opacity: show ? 1 : 0, transition:"all .3s", pointerEvents:"none" as const, zIndex:300, whiteSpace:"nowrap" as const }),
  installBtn: { background:OR, color:"#fff", border:"none", borderRadius:999, padding:"10px 16px", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"inherit", boxShadow:"0 6px 20px rgba(244,117,33,.4)" },
  ghostBtn: { background:BG3, color:TX, border:`1px solid ${BD}`, borderRadius:999, padding:"10px 16px", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"inherit" },
};

// ── Global CSS ────────────────────────────────────────────────────────────────
const GLOBAL_CSS = `
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  ::-webkit-scrollbar{display:none}
  input::placeholder{color:${MT2}}
  body{margin:0;background:${BG}}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes orbit{from{transform:rotate(0) translateX(56px) rotate(0)}to{transform:rotate(360deg) translateX(56px) rotate(-360deg)}}
  @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
  @keyframes slideUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
  @keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
  @keyframes barWave{0%,100%{transform:scaleY(.3)}50%{transform:scaleY(1)}}
  @keyframes fadeIn{from{opacity:0}to{opacity:1}}
  @keyframes fadeOut{from{opacity:1}to{opacity:0}}
  @keyframes sheetUp{from{transform:translate(-50%,30px);opacity:0}to{transform:translate(-50%,0);opacity:1}}
  @keyframes cardIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
  @keyframes ripple{0%{transform:scale(0);opacity:.6}80%{opacity:.15}100%{transform:scale(3);opacity:0}}
  @keyframes logoEnter{0%{transform:scale(2.2);opacity:0;filter:blur(20px)}55%{transform:scale(.92);opacity:1;filter:blur(0)}100%{transform:scale(1);opacity:1;filter:blur(0)}}
  @keyframes logoEnterRing{0%{transform:scale(2.6);opacity:0}55%{opacity:.6}100%{transform:scale(1);opacity:0}}
  @keyframes wordmark{0%{opacity:0;letter-spacing:6px}100%{opacity:1;letter-spacing:-.5px}}
  @keyframes shimmerSkel{0%{background-position:-300px 0}100%{background-position:300px 0}}
  @keyframes splashFadeOut{from{opacity:1}to{opacity:0}}
  .anical-bar{width:5px;border-radius:3px;background:linear-gradient(180deg,${OR},#ff9558);transform-origin:bottom center;animation:barWave 1.1s ease-in-out infinite}
  .anical-skel{background:linear-gradient(90deg,${BG2} 0%,${BG3} 50%,${BG2} 100%);background-size:300px 100%;animation:shimmerSkel 1.4s linear infinite}
  .anical-card:active{transform:scale(.985)}
  .anical-fade-out{animation:splashFadeOut 500ms ease-in forwards}
`;

// ── Logo ─────────────────────────────────────────────────────────────────────
function StarLogo({ size = 26, color = OR }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" fill="none">
      <circle cx="13" cy="13" r="12" fill={color} opacity=".15"/>
      <path d="M13 3.5l2.2 6.3h6.6l-5.3 3.9 2 6.3L13 16.2l-5.5 3.8 2-6.3L4.2 9.8h6.6L13 3.5z" fill={color}/>
    </svg>
  );
}

// ── Splash screen ─────────────────────────────────────────────────────────────
function Splash({ fadingOut }: { fadingOut: boolean }) {
  return (
    <div
      className={fadingOut ? "anical-fade-out" : ""}
      style={{ position:"fixed", inset:0, zIndex:9999, background:BG, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", overflow:"hidden" }}
    >
      <div style={{ position:"absolute", inset:0, background:`radial-gradient(circle at 50% 45%, rgba(244,117,33,.18), transparent 55%)`, pointerEvents:"none" }}/>
      <div style={{ position:"relative", width:160, height:160, display:"flex", alignItems:"center", justifyContent:"center" }}>
        {[0, .25, .5].map((d) => (
          <div key={d} style={{ position:"absolute", inset:24, borderRadius:"50%", border:`2px solid ${OR3}`, animation:`ripple 2s ${d}s ease-out infinite` }}/>
        ))}
        <div style={{ position:"absolute", inset:0, borderRadius:"50%", border:`2px solid ${OR}`, animation:"logoEnterRing 1.1s cubic-bezier(.2,.7,.2,1) both" }}/>
        <div style={{ width:96, height:96, borderRadius:"50%", background:`radial-gradient(circle, ${OR} 0%, #c95a13 100%)`, boxShadow:`0 0 40px ${OR3}, 0 0 80px rgba(244,117,33,.18)`, display:"flex", alignItems:"center", justifyContent:"center", animation:"logoEnter 1.1s cubic-bezier(.2,.8,.2,1) both" }}>
          <svg width="52" height="52" viewBox="0 0 26 26" fill="none">
            <path d="M13 3.5l2.2 6.3h6.6l-5.3 3.9 2 6.3L13 16.2l-5.5 3.8 2-6.3L4.2 9.8h6.6L13 3.5z" fill="#fff"/>
          </svg>
        </div>
      </div>
      <div style={{ marginTop:32, fontSize:30, fontWeight:800, letterSpacing:"-.5px", animation:"wordmark .9s .35s cubic-bezier(.2,.7,.2,1) both" }}>
        Ani<span style={{ color:OR }}>Cal</span>
      </div>
      <div style={{ marginTop:8, fontSize:11, color:MT, letterSpacing:"3px", textTransform:"uppercase", animation:"fadeIn .5s .8s both" }}>
        Anime, on your time
      </div>
    </div>
  );
}

// ── Skeleton loading ──────────────────────────────────────────────────────────
function SkeletonCard({ delay = 0 }: { delay?: number }) {
  return (
    <div style={{ ...S.card(false, false), opacity:0, animation:`cardIn .5s ${delay}ms cubic-bezier(.2,.7,.2,1) both` }}>
      <div className="anical-skel" style={{ width:52, height:72, borderRadius:6, flexShrink:0 }}/>
      <div style={{ flex:1, display:"flex", flexDirection:"column", gap:6, justifyContent:"center" }}>
        <div className="anical-skel" style={{ height:14, borderRadius:4, width:"80%" }}/>
        <div className="anical-skel" style={{ height:10, borderRadius:4, width:"55%" }}/>
        <div className="anical-skel" style={{ height:10, borderRadius:4, width:"35%" }}/>
      </div>
    </div>
  );
}

function LoadingView({ progress, msg }: { progress: number; msg: string }) {
  return (
    <div style={{ minHeight:"100vh", paddingBottom:60, background:BG }}>
      <div style={{ padding:"18px 16px 0", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:40, height:40, borderRadius:"50%", background:`radial-gradient(circle, ${OR}, #c95a13)`, display:"flex", alignItems:"center", justifyContent:"center", boxShadow:`0 0 24px ${OR3}`, animation:"float 3.5s ease-in-out infinite" }}>
            <svg width="22" height="22" viewBox="0 0 26 26"><path d="M13 3.5l2.2 6.3h6.6l-5.3 3.9 2 6.3L13 16.2l-5.5 3.8 2-6.3L4.2 9.8h6.6L13 3.5z" fill="#fff"/></svg>
          </div>
          <div>
            <div style={{ fontSize:20, fontWeight:800, letterSpacing:"-.5px" }}>Ani<span style={{ color:OR }}>Cal</span></div>
            <div style={{ fontSize:11, color:MT, marginTop:2 }}>{msg}</div>
          </div>
        </div>
        <div style={{ fontSize:11, color:MT2, fontWeight:700, letterSpacing:".5px" }}>{progress}%</div>
      </div>
      <div style={{ height:3, background:BG3, marginTop:16, position:"relative", overflow:"hidden" }}>
        <div style={{ position:"absolute", inset:0, width:`${progress}%`, background:`linear-gradient(90deg, ${OR}, #ff9558, ${OR})`, backgroundSize:"200% 100%", animation:"shimmer 2s linear infinite", transition:"width .4s cubic-bezier(.4,0,.2,1)", boxShadow:`0 0 12px ${OR3}` }}/>
      </div>
      <div style={{ display:"flex", gap:6, padding:"14px 16px", overflowX:"hidden" }}>
        {DAYS.map((d, i) => {
          const done = (progress / 100) * DAYS.length > i;
          return (
            <div key={d} style={{ flexShrink:0, minWidth:52, height:60, borderRadius:8, border:`1px solid ${done ? OR3 : BD}`, background: done ? OR2 : BG2, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:2, padding:"6px 10px", transition:"all .35s", animation:`cardIn .3s ${i * 40}ms both` }}>
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

// ── Anime card ────────────────────────────────────────────────────────────────
function AnimeCard({ anime, favorites, onOpen, onToggleFav, selectedDayIdx, todayDayIdx, tz }: {
  anime: Anime & { __tz?: string };
  favorites: number[];
  onOpen: (a: Anime) => void;
  onToggleFav: (id: number) => void;
  selectedDayIdx: number;
  todayDayIdx: number;
  tz: string;
}) {
  const isFav = favorites.includes(anime.id);
  const [imgFailed, setImgFailed] = useState(false);
  const now = new Date();
  let isNow = false;
  if (anime.broadcast_time && selectedDayIdx === todayDayIdx) {
    const [h, m] = anime.broadcast_time.split(":").map(Number);
    const utcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h - 9, m);
    const diff = (utcMs - now.getTime()) / 60_000;
    isNow = diff > -30 && diff <= 0;
  }
  const localTime = jstToLocal(anime.broadcast_time, tz);
  return (
    <div className="anical-card" style={S.card(isFav, isNow)} onClick={() => onOpen(anime)}>
      {isNow && <div style={S.pulse}/>}
      {anime.image_url && !imgFailed
        ? <img src={anime.image_url} alt="" style={S.thumb} loading="lazy" onError={() => setImgFailed(true)}/>
        : <div style={S.thumbPlaceholder}>🎬</div>}
      <div style={S.cardInfo}>
        <div style={S.cardTitle}>{anime.title}</div>
        <div style={S.cardMeta}>
          {anime.score && <span style={S.score}>★ {anime.score}</span>}
          {anime.episodes && <span style={S.epBadge}>{anime.episodes} eps</span>}
          {anime.genres?.[0] && <span style={S.genre}>{anime.genres[0]}</span>}
        </div>
        {anime.broadcast_time && (
          <div style={S.airRow}>
            <span>{anime.broadcast_time}</span>
            <span style={S.airJst}>JST</span>
            {localTime && <span style={S.airLocal}>→ {localTime}</span>}
          </div>
        )}
      </div>
      <button style={S.favBtn(isFav)} onClick={(e) => { e.stopPropagation(); onToggleFav(anime.id); }}>
        {isFav ? "★" : "☆"}
      </button>
    </div>
  );
}

// ── Detail sheet ──────────────────────────────────────────────────────────────
function DetailSheet({ anime, favorites, onClose, onToggleFav, tz }: { anime: Anime | null; favorites: number[]; onClose: () => void; onToggleFav: (id: number) => void; tz: string }) {
  if (!anime) return null;
  const isFav = favorites.includes(anime.id);
  const localTime = jstToLocal(anime.broadcast_time, tz);
  return (
    <>
      <div style={S.sheetBackdrop} onClick={onClose}/>
      <div style={S.sheetContent}>
        <div style={S.sheetHandle}/>
        <div style={S.sheetBody}>
          {anime.image_url && <img src={anime.image_url} alt="" style={S.sheetImg}/>}
          <div style={S.sheetTitle}>{anime.title}</div>
          <div style={S.sheetMeta}>
            {anime.score && <span style={S.badge(true)}>★ {anime.score}</span>}
            {anime.year && <span style={S.badge(false)}>{anime.year}</span>}
            {anime.season && <span style={S.badge(false)}>{capitalize(anime.season)}</span>}
            {anime.episodes && <span style={S.badge(false)}>{anime.episodes} eps</span>}
            {anime.genres?.slice(0, 3).map((g) => <span key={g} style={S.badge(false)}>{g}</span>)}
          </div>
          {anime.broadcast_time && (
            <div style={S.airtimeBox}>
              <div style={S.airtimeTitle}>📅 Airing Time</div>
              <div style={S.airtimeRow}>
                <div style={S.airtimeItem}><div style={S.airtimeVal}>{anime.broadcast_time}</div><div style={S.airtimeSub}>Japan (JST)</div></div>
                <div style={{ color:MT, fontSize:22 }}>→</div>
                <div style={S.airtimeItem}><div style={{ ...S.airtimeVal, color:OR }}>{localTime || "—"}</div><div style={S.airtimeSub}>Your time</div></div>
                <div style={S.airtimeItem}><div style={{ ...S.airtimeVal, fontSize:14 }}>{capitalize(anime.broadcast_day || "")}</div><div style={S.airtimeSub}>Day</div></div>
              </div>
            </div>
          )}
          <div style={S.synopsis}>{anime.synopsis || "No synopsis available."}</div>
          <div style={S.sheetActions}>
            <button style={S.sheetFavBtn(isFav)} onClick={() => onToggleFav(anime.id)}>
              {isFav ? "★ Favorited" : "☆ Add to Favorites"}
            </button>
            <button style={S.sheetCrBtn} onClick={() => openUrl(`https://www.crunchyroll.com/search?q=${encodeURIComponent(anime.title)}`)}>
              ▶ Crunchyroll
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Schedule view ─────────────────────────────────────────────────────────────
function ScheduleView({ anime, selectedDay, setSelectedDay, todayDayIdx, dayNavRef, schedule, favs, favFilter, search, tz, onOpen, onToggleFav }: {
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
}) {
  const today = new Date();
  const getCount = (i: number) => {
    let list = schedule[DAYS[i]] || [];
    if (favFilter) list = list.filter((a) => favs.includes(a.id));
    if (search) { const q = search.toLowerCase(); list = list.filter((a) => a.title.toLowerCase().includes(q)); }
    return list.length;
  };

  const groups: Record<string, Anime[]> = {};
  anime.forEach((a) => { const k = a.broadcast_time || "?"; if (!groups[k]) groups[k] = []; groups[k].push(a); });
  const now = new Date();

  return (
    <>
      <div style={S.dayNav} ref={dayNavRef}>
        {DAYS.map((d, i) => {
          const date = new Date(today); date.setDate(today.getDate() - todayDayIdx + i);
          const active = i === selectedDay, isToday = i === todayDayIdx;
          return (
            <div key={d} data-day={i} style={S.dayPill(active, isToday)} onClick={() => setSelectedDay(i)}>
              <div style={S.dayPillName(active, isToday)}>{DAY_SHORT[i]}</div>
              <div style={S.dayPillNum(active)}>{date.getDate()}</div>
              <div style={S.dayPillCount(active)}>{getCount(i)}</div>
            </div>
          );
        })}
      </div>

      <div style={S.listWrap}>
        {anime.length === 0 ? (
          <div style={S.empty}>
            <div style={S.emptyIcon}>{favFilter ? "⭐" : "📭"}</div>
            <div style={S.emptyText}>{favFilter ? "No favorites airing.\nTurn off filter to see all." : "Nothing scheduled."}</div>
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
                <div style={S.timeLabel}>
                  <span>{time !== "?" ? `${time} JST` : "Time Unknown"}</span>
                  {isNow && <span style={S.localTime}>🟢 AIRING NOW</span>}
                  {!isNow && localStr && <span style={S.localTime}>→ {localStr} local</span>}
                  <div style={S.timeLabelLine}/>
                </div>
                {items.map((a) => (
                  <AnimeCard key={a.id} anime={a} favorites={favs} selectedDayIdx={selectedDay} todayDayIdx={todayDayIdx} tz={tz} onOpen={onOpen} onToggleFav={onToggleFav}/>
                ))}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

// ── Month view ────────────────────────────────────────────────────────────────
function MonthView({ monthOffset, setMonthOffset, schedule, favs, favFilter, search, tz, onOpen, onToggleFav, todayDayIdx }: {
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
}) {
  const [selectedMonthDay, setSelectedMonthDay] = useState(todayDayIdx);
  const now = new Date();
  const monthDate = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const [mYear, mMon] = [monthDate.getFullYear(), monthDate.getMonth()];
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

  const selectedAnime = getFiltered(selectedMonthDay);
  const groups: Record<string, Anime[]> = {};
  selectedAnime.forEach((a) => { const k = a.broadcast_time || "?"; if (!groups[k]) groups[k] = []; groups[k].push(a); });

  return (
    <div style={S.monthWrap}>
      <div style={S.monthNav}>
        <button style={S.monthNavBtn} onClick={() => setMonthOffset((v) => v - 1)}>‹</button>
        <span style={S.monthLabel}>{MONTHS[mMon]} {mYear}</span>
        <button style={S.monthNavBtn} onClick={() => setMonthOffset((v) => v + 1)}>›</button>
      </div>
      <div style={S.monthGridHeader}>
        {["Su","Mo","Tu","We","Th","Fr","Sa"].map((d) => <div key={d} style={S.monthGridHeaderCell}>{d}</div>)}
      </div>
      <div style={S.monthGrid}>
        {cells.map((date, ci) => {
          const inMonth = date.getMonth() === mMon;
          const isToday = inMonth && date.getDate() === now.getDate() && date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
          const dayIdx = (date.getDay() + 6) % 7;
          const dayAnime = inMonth ? getFiltered(dayIdx) : [];
          return (
            <div key={ci} style={S.monthCell(isToday, inMonth, dayAnime.length > 0)} onClick={() => inMonth && setSelectedMonthDay(dayIdx)}>
              <div style={S.monthCellNum(isToday)}>{date.getDate()}</div>
              <div style={S.monthDots}>{dayAnime.slice(0, 6).map((a, j) => <div key={j} style={S.dot(favs.includes(a.id))}/>)}</div>
              {dayAnime.length > 6 && <div style={S.monthCount}>+{dayAnime.length - 6}</div>}
            </div>
          );
        })}
      </div>
      <div style={{ borderTop:`1px solid ${BD}`, paddingTop:12 }}>
        <div style={{ fontSize:15, fontWeight:700, marginBottom:12 }}>{DAY_SHORT[selectedMonthDay]}'s Anime ({selectedAnime.length})</div>
        {selectedAnime.length === 0 ? (
          <div style={S.empty}><div style={S.emptyIcon}>📭</div><div style={S.emptyText}>Nothing scheduled.</div></div>
        ) : (
          Object.entries(groups).map(([time, items]) => (
            <div key={time}>
              <div style={S.timeLabel}>
                <span>{time !== "?" ? `${time} JST` : "Time Unknown"}</span>
                <div style={S.timeLabelLine}/>
              </div>
              {items.map((a) => (
                <AnimeCard key={a.id} anime={a} favorites={favs} selectedDayIdx={selectedMonthDay} todayDayIdx={todayDayIdx} tz={tz} onOpen={onOpen} onToggleFav={onToggleFav}/>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── Notification banner ───────────────────────────────────────────────────────
function NotifBanner({ notifPerm, notifEnabled, notifSettings, setNotifSettings, requestNotifPerm, testNotif }: any) {
  if (notifPerm === "unsupported") return null;
  return (
    <div style={{ background: notifEnabled ? "rgba(34,197,94,.08)" : OR2, border:`1px solid ${notifEnabled ? "rgba(34,197,94,.3)" : OR3}`, borderRadius:14, padding:"12px 14px", display:"flex", flexDirection:"column", gap:10 }}>
      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
        <div style={{ fontSize:22 }}>{notifEnabled ? "🔔" : "🔕"}</div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:13, fontWeight:700, color: notifEnabled ? GR : OR }}>
            {notifEnabled ? "Notifications on" : "Get notified when anime airs"}
          </div>
          <div style={{ fontSize:11, color:MT, marginTop:2 }}>
            {notifEnabled
              ? `Alert ${notifSettings.leadMinutes === 0 ? "at airtime" : `${notifSettings.leadMinutes} min before`}`
              : notifPerm === "denied" ? "Notifications blocked. Enable in browser settings." : "Reminders for everything on your watchlist."}
          </div>
        </div>
        {!notifEnabled && notifPerm !== "denied" && (
          <button onClick={async () => { const g = (await requestNotifPerm()) === "granted"; if (g) setNotifSettings((s: NotifSettings) => ({ ...s, enabled: true })); }}
            style={{ background:OR, color:"#fff", border:"none", borderRadius:8, padding:"7px 12px", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap" }}>
            Turn on
          </button>
        )}
        {notifEnabled && (
          <button onClick={() => setNotifSettings((s: NotifSettings) => ({ ...s, enabled: false }))}
            style={{ background:"none", color:MT, border:`1px solid ${BD}`, borderRadius:8, padding:"7px 10px", fontSize:11, fontWeight:600, cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap" }}>
            Off
          </button>
        )}
      </div>
      {notifEnabled && (
        <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
          <span style={{ fontSize:10, color:MT, fontWeight:700, textTransform:"uppercase", letterSpacing:".5px", marginRight:4 }}>Alert</span>
          {LEAD_OPTIONS.map((m) => {
            const sel = notifSettings.leadMinutes === m;
            return (
              <button key={m} onClick={() => setNotifSettings((s: NotifSettings) => ({ ...s, leadMinutes: m }))}
                style={{ fontSize:11, fontWeight:700, padding:"4px 9px", borderRadius:99, background: sel ? OR : BG3, border:`1px solid ${sel ? OR : BD}`, color: sel ? "#fff" : MT, cursor:"pointer", fontFamily:"inherit" }}>
                {m === 0 ? "at airtime" : `${m}m before`}
              </button>
            );
          })}
          <button onClick={testNotif} style={{ marginLeft:"auto", fontSize:11, fontWeight:600, padding:"4px 9px", borderRadius:99, background:"none", border:`1px solid ${BD}`, color:MT, cursor:"pointer", fontFamily:"inherit" }}>Test</button>
        </div>
      )}
    </div>
  );
}

// ── Fav card ──────────────────────────────────────────────────────────────────
function FavCard({ anime, delay, tz, notifEnabled, perAnimeNotif, toggleAnimeNotif, onOpen, onRemove, tick }: any) {
  void tick;
  const next: Date | null = anime.__next;
  const now = new Date();
  const isLive = next && next.getTime() - now.getTime() < 0 && now.getTime() - next.getTime() < 30 * 60_000;
  const countdown = next ? formatCountdown(next, now) : null;
  const localTime = jstToLocal(anime.broadcast_time, tz);
  return (
    <div onClick={() => onOpen(anime)} style={{ position:"relative", display:"flex", gap:12, padding:10, background: isLive ? "rgba(34,197,94,.07)" : BG2, border:`1px solid ${isLive ? "rgba(34,197,94,.35)" : BD}`, borderRadius:14, cursor:"pointer", overflow:"hidden", animation:`cardIn .35s ${Math.min(delay, 360)}ms both` }}>
      {isLive && <div style={{ position:"absolute", top:8, right:8, width:7, height:7, borderRadius:"50%", background:GR, boxShadow:`0 0 8px ${GR}` }}/>}
      <div style={{ position:"relative", flexShrink:0, width:64, height:88, borderRadius:10, overflow:"hidden", background:BG4 }}>
        {anime.image_url
          ? <img src={anime.image_url} alt="" loading="lazy" style={{ width:"100%", height:"100%", objectFit:"cover" }}/>
          : <div style={{ width:"100%", height:"100%", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22 }}>🎬</div>}
        <div style={{ position:"absolute", inset:0, background:"linear-gradient(180deg, transparent 50%, rgba(0,0,0,.7))" }}/>
        {anime.score && <div style={{ position:"absolute", bottom:4, left:4, right:4, fontSize:10, fontWeight:800, color:"#fff" }}>★ {anime.score}</div>}
      </div>
      <div style={{ flex:1, minWidth:0, display:"flex", flexDirection:"column", justifyContent:"space-between", padding:"2px 0" }}>
        <div>
          <div style={{ fontSize:14, fontWeight:700, lineHeight:1.25, color:TX, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical", marginBottom:4 }}>{anime.title}</div>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap", alignItems:"center" }}>
            {countdown && (
              <span style={{ fontSize:11, fontWeight:800, padding:"2px 8px", borderRadius:99, background: isLive ? "rgba(34,197,94,.15)" : OR2, color: isLive ? GR : OR, border:`1px solid ${isLive ? "rgba(34,197,94,.35)" : OR3}`, letterSpacing:".2px", textTransform: isLive ? "uppercase" : "none" }}>
                {isLive ? "● LIVE" : countdown}
              </span>
            )}
            {anime.broadcast_day && (
              <span style={{ fontSize:10, color:MT, fontWeight:600, textTransform:"uppercase", letterSpacing:".4px" }}>
                {DAY_SHORT[DAYS.indexOf(anime.broadcast_day as any)] || anime.broadcast_day.slice(0, 3)}
              </span>
            )}
            {anime.genres?.[0] && <span style={{ fontSize:10, color:MT, padding:"2px 7px", borderRadius:99, background:BG3, border:`1px solid ${BD}` }}>{anime.genres[0]}</span>}
          </div>
        </div>
        {anime.broadcast_time && (
          <div style={{ fontSize:11, color:MT, fontWeight:600, marginTop:6 }}>
            <span style={{ color:OR }}>{localTime}</span>
            <span style={{ color:MT2 }}> · {anime.broadcast_time} JST</span>
          </div>
        )}
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:4, alignItems:"center" }}>
        <button onClick={(e) => { e.stopPropagation(); toggleAnimeNotif(); }} style={{ background: notifEnabled && perAnimeNotif ? OR2 : "none", border:`1px solid ${notifEnabled && perAnimeNotif ? OR3 : BD}`, color: notifEnabled && perAnimeNotif ? OR : MT2, fontSize:14, cursor:"pointer", fontFamily:"inherit", padding:"4px 6px", lineHeight:1, borderRadius:8, opacity: notifEnabled ? 1 : .5 }}>
          {perAnimeNotif ? "🔔" : "🔕"}
        </button>
        <button onClick={(e) => { e.stopPropagation(); onRemove(); }} style={{ background:"none", border:"none", color:MT2, fontSize:18, cursor:"pointer", fontFamily:"inherit", padding:"2px 6px", lineHeight:1 }}>✕</button>
      </div>
    </div>
  );
}

// ── My List view ──────────────────────────────────────────────────────────────
function MyListView({ favAnime, todayDayIdx, tz, favs, totalAnime, airingToday, topGenre, notifSettings, setNotifSettings, notifPerm, requestNotifPerm, testNotif, onOpen, toggleFav, installPwa, downloadExtension, tick }: any) {
  const now = new Date();
  const withNext = favAnime.map((a: any) => ({ ...a, __next: nextJstAiringDate(a.broadcast_day, a.broadcast_time) }))
    .sort((a: any, b: any) => {
      if (!a.__next && !b.__next) return 0;
      if (!a.__next) return 1; if (!b.__next) return -1;
      return a.__next.getTime() - b.__next.getTime();
    });

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
      <div style={{ position:"relative", overflow:"hidden", background:`linear-gradient(135deg, ${OR} 0%, #c43d0d 100%)`, borderRadius:18, padding:"20px 18px", marginBottom:16, boxShadow:`0 12px 32px -10px ${OR3}` }}>
        <div style={{ position:"absolute", top:-30, right:-30, width:140, height:140, borderRadius:"50%", background:"rgba(255,255,255,.12)" }}/>
        <div style={{ position:"absolute", bottom:-50, right:30, width:90, height:90, borderRadius:"50%", background:"rgba(255,255,255,.08)" }}/>
        <div style={{ position:"relative" }}>
          <div style={{ fontSize:11, fontWeight:700, color:"rgba(255,255,255,.85)", letterSpacing:"1px", textTransform:"uppercase", marginBottom:4 }}>Your collection</div>
          <div style={{ fontSize:42, fontWeight:900, color:"#fff", lineHeight:1, letterSpacing:"-1.5px" }}>
            {favs.length}<span style={{ fontSize:18, fontWeight:700, opacity:.7, marginLeft:6 }}>shows</span>
          </div>
          <div style={{ fontSize:13, color:"rgba(255,255,255,.85)", marginTop:6 }}>
            {buckets.live.length > 0 ? `🔴 ${buckets.live.length} airing right now`
              : buckets.soon.length > 0 ? `⏰ ${buckets.soon.length} in the next 12 hours`
              : favAnime.filter((a: any) => a.dayIdx === todayDayIdx).length > 0 ? `📡 ${favAnime.filter((a: any) => a.dayIdx === todayDayIdx).length} airing today`
              : "No favorites airing today"}
          </div>
        </div>
      </div>

      {/* Stats tiles */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:18 }}>
        {[{ v:totalAnime, l:"Season", icon:"📺" }, { v:airingToday, l:"Today", icon:"📡" }, { v:topGenre, l:"Top genre", icon:"🎭", small:true }].map((stat, i) => (
          <div key={i} style={{ background:BG2, border:`1px solid ${BD}`, borderRadius:14, padding:"12px 10px", display:"flex", flexDirection:"column", gap:4 }}>
            <div style={{ fontSize:14, opacity:.7 }}>{stat.icon}</div>
            <div style={{ fontSize: stat.small ? 13 : 22, fontWeight:800, color:TX, lineHeight:1.1, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{stat.v}</div>
            <div style={{ fontSize:10, color:MT, fontWeight:600, textTransform:"uppercase", letterSpacing:".5px" }}>{stat.l}</div>
          </div>
        ))}
      </div>

      {favAnime.length > 0 && (
        <NotifBanner notifPerm={notifPerm} notifEnabled={notifEnabled} notifSettings={notifSettings} setNotifSettings={setNotifSettings} requestNotifPerm={requestNotifPerm} testNotif={testNotif}/>
      )}

      <div style={{ display:"flex", alignItems:"baseline", justifyContent:"space-between", marginTop:18, marginBottom:10 }}>
        <div style={{ fontSize:18, fontWeight:800, letterSpacing:"-.3px" }}>My Watchlist</div>
        {favAnime.length > 0 && <div style={{ fontSize:11, color:MT2, fontWeight:600 }}>{favAnime.length} title{favAnime.length===1?"":"s"}</div>}
      </div>

      {favAnime.length === 0 ? (
        <div style={{ padding:"40px 20px", textAlign:"center", borderRadius:14, border:`2px dashed ${BD2}`, background:BG2 }}>
          <div style={{ fontSize:48, marginBottom:8 }}>⭐</div>
          <div style={{ fontSize:14, fontWeight:700, marginBottom:4 }}>Build your watchlist</div>
          <div style={{ fontSize:12, color:MT, lineHeight:1.6 }}>Tap ☆ on any anime to track it here.<br/>You'll see countdowns and can get notified when it airs.</div>
        </div>
      ) : (
        sections.filter((sec) => sec.items.length > 0).map((sec) => (
          <div key={sec.key} style={{ marginBottom:18 }}>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10, fontSize:12, fontWeight:700, color: sec.accent ? OR : MT, textTransform:"uppercase", letterSpacing:".8px" }}>
              <span style={{ fontSize:14 }}>{sec.emoji}</span>
              <span>{sec.title}</span>
              <span style={{ fontSize:10, padding:"2px 7px", borderRadius:99, background: sec.accent ? OR2 : BG3, border:`1px solid ${sec.accent ? OR3 : BD}`, color: sec.accent ? OR : MT }}>{sec.items.length}</span>
              <div style={{ flex:1, height:1, background:BD }}/>
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr", gap:10 }}>
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

      {!IS_NATIVE && (
        <div style={{ marginTop:28, padding:"18px 16px", background:`linear-gradient(135deg, ${BG2}, ${BG3})`, border:`1px solid ${BD2}`, borderRadius:16, position:"relative", overflow:"hidden" }}>
          <div style={{ position:"absolute", top:-40, right:-30, fontSize:120, opacity:.05, transform:"rotate(15deg)" }}>📱</div>
          <div style={{ position:"relative" }}>
            <div style={{ fontSize:11, fontWeight:700, color:OR, letterSpacing:"1px", textTransform:"uppercase", marginBottom:6 }}>Pro tip</div>
            <div style={{ fontSize:16, fontWeight:800, marginBottom:6, letterSpacing:"-.3px" }}>Take AniCal everywhere</div>
            <div style={{ fontSize:12, color:MT, lineHeight:1.6, marginBottom:14 }}>Install to your home screen or grab the browser extension for one-click access from any tab.</div>
            <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
              <button style={S.installBtn} onClick={installPwa}>📱 Install app</button>
              <button style={S.ghostBtn} onClick={downloadExtension}>🧩 Extension</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Root app ──────────────────────────────────────────────────────────────────
export default function AniCal() {
  const todayDayIdx = (new Date().getDay() + 6) % 7;

  // ── State ──
  const [boot, setBoot] = useState<BootStage>("splash");
  const [splashFading, setSplashFading] = useState(false);
  const [splashVisible, setSplashVisible] = useState(true); // controls DOM presence
  const [schedule, setSchedule] = useState<Schedule>({});
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadMsg, setLoadMsg] = useState("Starting up…");
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"schedule"|"month"|"stats">("schedule");
  const [selectedDay, setSelectedDay] = useState(todayDayIdx);
  const [monthOffset, setMonthOffset] = useState(0);
  const [favs, setFavs] = useState<number[]>([]);
  const [favFilter, setFavFilter] = useState(false);
  const [search, setSearch] = useState("");
  const [detailAnime, setDetailAnime] = useState<Anime | null>(null);
  const [toast, setToast] = useState({ show: false, msg: "" });
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const [tz, setTz] = useState<string>("auto");
  const [notifSettings, setNotifSettings] = useState<NotifSettings>(DEFAULT_NOTIF);
  const [notifPerm, setNotifPerm] = useState<"granted"|"denied"|"default"|"unsupported">("default");
  const [tick, setTick] = useState(0);

  const dayNavRef = useRef<HTMLDivElement>(null);
  const isLoadingRef = useRef(false); // prevent concurrent loads

  // ── Splash lifecycle ──
  // IMPORTANT: splashVisible MUST be set to false after the fade animation so the
  // fixed overlay does not block touch events on the main app content.
  useEffect(() => {
    const cached = LS.get<{ ts: number; data: Schedule } | null>("anical_schedule_cache", null);
    const haveFresh = cached && Date.now() - cached.ts < CACHE_TTL;
    const showDuration = haveFresh ? 2200 : 2800; // longer splash as requested
    const fadeDuration = 500;

    const t1 = window.setTimeout(() => setSplashFading(true), showDuration - fadeDuration);
    const t2 = window.setTimeout(() => {
      setSplashVisible(false); // ← unmounts the overlay, unblocks all touches
      setBoot(haveFresh ? "ready" : "loading");
      if (haveFresh && cached) { setSchedule(cached.data); setLastUpdated(new Date(cached.ts)); }
    }, showDuration);

    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  // ── Persistence ──
  useEffect(() => { setFavs(LS.get<number[]>("anical_favs", [])); }, []);
  useEffect(() => { LS.set("anical_favs", favs); }, [favs]);
  useEffect(() => { setTz(LS.get<string>("anical_tz", "auto")); }, []);
  useEffect(() => { LS.set("anical_tz", tz); }, [tz]);
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

  // loadSchedule has no deps that close over boot — uses isLoadingRef guard instead
  const loadSchedule = useCallback(async (force = false) => {
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
    setBoot("loading");
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
      setError(e.message || "Failed to load");
      setBoot("error");
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

  // ── Derived data ──
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

  // Schedule notifications on changes
  useEffect(() => {
    if (boot !== "ready") return;
    if (notifPerm !== "granted" || !notifSettings.enabled) { notif.cancelAll(); return; }
    const entries: ScheduleEntry[] = favAnime.flatMap((a) => {
      if (notifSettings.perAnime[a.id] === false) return [];
      const airAt = nextJstAiringDate(a.broadcast_day, a.broadcast_time);
      if (!airAt) return [];
      const fireAt = new Date(airAt.getTime() - notifSettings.leadMinutes * 60_000);
      if (fireAt.getTime() < Date.now() + 5_000) return [];
      return [{
        id: a.id, title: a.title, fireAt,
        body: notifSettings.leadMinutes === 0 ? "Airing now on Crunchyroll" : `Starts in ${notifSettings.leadMinutes} min · ${a.broadcast_time} JST`,
        url: a.mal_url || undefined,
      }];
    });
    notif.schedule(entries).catch(() => {});
  }, [boot, favAnime, notifSettings, notifPerm]);

  // ── Misc handlers ──
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

      {/* Splash: only in DOM while splashVisible. Once false, the fixed overlay is gone. */}
      {splashVisible && <Splash fadingOut={splashFading}/>}

      {boot === "loading" && (
        <div style={S.app}><LoadingView progress={loadProgress} msg={loadMsg}/></div>
      )}

      {boot === "error" && (
        <div style={S.app}>
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"60px 20px", gap:16, minHeight:"50vh" }}>
            <div style={{ fontSize:40 }}>⚠️</div>
            <div style={{ fontSize:16, fontWeight:600 }}>Failed to load</div>
            <div style={{ fontSize:12, color:MT, textAlign:"center", lineHeight:1.6 }}>{error}</div>
            <button style={{ ...S.iconBtn, color:OR, borderColor:OR, marginTop:8 }} onClick={() => loadSchedule(true)}>Try Again</button>
          </div>
        </div>
      )}

      {boot === "ready" && (
        <div style={S.app}>
          <div style={S.header}>
            <div style={S.headerTop}>
              <div style={S.logo}>
                <StarLogo size={26}/>
                Ani<span style={S.logoAccent}>Cal</span>
                {favs.length > 0 && <span style={{ background:OR, color:"#fff", fontSize:10, fontWeight:700, padding:"1px 6px", borderRadius:4 }}>{favs.length}</span>}
              </div>
              <div style={S.actions}>
                <button style={{ ...S.iconBtn, ...(favFilter ? S.iconBtnActive : {}) }} onClick={() => setFavFilter((v) => !v)}>★ Favs</button>
                <button style={S.iconBtn} onClick={() => loadSchedule(true)}>↻</button>
              </div>
            </div>
            <div style={S.tabs}>
              {(["Schedule","Month","My List"] as const).map((label, i) => {
                const v = (["schedule","month","stats"] as const)[i];
                return <button key={label} style={{ ...S.tab, ...(view === v ? S.tabActive : {}) }} onClick={() => setView(v)}>{label}</button>;
              })}
            </div>
          </div>

          <div style={S.searchWrap}>
            <input style={S.searchInput} placeholder="Search anime…" value={search} onChange={(e) => setSearch(e.target.value)}/>
          </div>

          {lastUpdated && (
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, padding:"4px 16px 0" }}>
              <select value={tz} onChange={(e) => setTz(e.target.value)}
                style={{ background:BG3, color:TX, border:`1px solid ${BD}`, borderRadius:6, fontSize:11, padding:"4px 6px", fontFamily:"inherit", maxWidth:180 }}>
                {TZ_PRESETS.map((p) => <option key={p.tz} value={p.tz}>{p.label}{p.tz === "auto" ? ` · ${getDeviceTz()}` : ""}</option>)}
              </select>
              <div style={{ fontSize:10, color:MT2 }}>Updated {lastUpdated.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" })}</div>
            </div>
          )}

          <div style={S.main}>
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
              />
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

          {detailAnime && (
            <DetailSheet anime={detailAnime} favorites={favs} tz={tz}
              onClose={() => setDetailAnime(null)}
              onToggleFav={(id: number) => { toggleFav(id); setDetailAnime((a) => (a ? { ...a } : null)); }}/>
          )}

          <div style={S.toast(toast.show)}>{toast.msg}</div>
        </div>
      )}
    </>
  );
}
