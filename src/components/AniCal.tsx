import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Capacitor } from "@capacitor/core";
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
const PULL_THRESHOLD = 70;

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

const DEFAULT_NOTIF: NotifSettings = { enabled: false, leadMinutes: 10, perAnime: {} };


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
function AnimeCard({ anime, favorites, onOpen, onToggleFav, selectedDayIdx, todayDayIdx, tz, animDelay = 0 }: {
  anime: Anime;
  favorites: number[];
  onOpen: (a: Anime) => void;
  onToggleFav: (id: number) => void;
  selectedDayIdx: number;
  todayDayIdx: number;
  tz: string;
  animDelay?: number;
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
    <div
      className="anical-card"
      style={{
        background: isFav ? `rgba(255,107,26,.07)` : BG2,
        border:`1px solid ${isFav ? OR3 : isNow ? "rgba(34,197,94,.35)" : BD}`,
        borderRadius:14, display:"flex", gap:12, padding:12, marginBottom:8,
        cursor:"pointer", position:"relative", overflow:"hidden",
        transition:"transform .15s, box-shadow .2s",
        animation:`cardIn .4s ${animDelay}ms cubic-bezier(.2,.7,.2,1) both`,
        boxShadow: isFav ? `0 4px 20px -6px ${OR3}` : "none",
      }}
      onClick={() => onOpen(anime)}
    >
      {isNow && <div className="anical-pulse" style={{ position:"absolute", top:10, right:10, width:8, height:8, borderRadius:"50%", background:GR }}/>}
      <div style={{ position:"relative", flexShrink:0, width:72, height:100, borderRadius:8, overflow:"hidden", background:BG4 }}>
        {anime.image_url && !imgFailed
          ? <img src={anime.image_url} alt="" loading="lazy" style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }} onError={() => setImgFailed(true)}/>
          : <div style={{ width:"100%", height:"100%", display:"flex", alignItems:"center", justifyContent:"center", fontSize:26, color:MT2 }}>🎬</div>}
        <div style={{ position:"absolute", inset:0, background:"linear-gradient(180deg, transparent 45%, rgba(0,0,0,.72))" }}/>
        {anime.score && <div style={{ position:"absolute", bottom:4, left:0, right:0, textAlign:"center", fontSize:10, fontWeight:800, color:"#fff", textShadow:"0 1px 4px rgba(0,0,0,.9)" }}>★ {anime.score}</div>}
      </div>
      <div style={{ flex:1, minWidth:0, display:"flex", flexDirection:"column", gap:5, justifyContent:"center" }}>
        <div style={{ fontSize:14, fontWeight:700, lineHeight:1.3, color:TX, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" as const }}>{anime.title}</div>
        <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" as const }}>
          {anime.episodes && <span style={{ fontSize:11, color:MT, background:BG4, padding:"2px 7px", borderRadius:6, fontWeight:600 }}>{anime.episodes} eps</span>}
          {anime.genres?.[0] && <span style={{ fontSize:10, color:MT, background:BG3, padding:"2px 7px", borderRadius:99 }}>{anime.genres[0]}</span>}
        </div>
        {anime.broadcast_time && (
          <div style={{ fontSize:12, fontWeight:600, color:TX, display:"flex", alignItems:"center", gap:4, marginTop:2 }}>
            <span>{anime.broadcast_time}</span>
            <span style={{ fontSize:10, color:MT, fontWeight:400 }}>JST</span>
            {localTime && <span style={{ fontSize:11, color:OR, fontWeight:600 }}>→ {localTime}</span>}
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
function DetailSheet({ anime, favorites, onClose, onToggleFav, tz }: { anime: Anime | null; favorites: number[]; onClose: () => void; onToggleFav: (id: number) => void; tz: string }) {
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
          <div style={{ display:"flex", gap:8 }}>
            <button style={{ flex:1, padding:13, borderRadius:10, border:`1px solid ${isFav ? OR : BD}`, background: isFav ? OR2 : BG3, color: isFav ? OR : MT, fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }} onClick={() => onToggleFav(anime.id)}>
              {isFav ? "★ Favorited" : "☆ Add to Favorites"}
            </button>
            <button style={{ flex:1.5, padding:13, borderRadius:10, border:"none", background:`linear-gradient(135deg, ${OR}, #cc5610)`, color:"#fff", fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center", gap:6, boxShadow:`0 6px 20px -4px rgba(255,107,26,.5)` }} onClick={() => openUrl(`https://www.crunchyroll.com/search?q=${encodeURIComponent(anime.title)}`)}>
              ▶ Crunchyroll
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Schedule view ──────────────────────────────────────────────────────────────
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
                  <AnimeCard key={a.id} anime={a} favorites={favs} selectedDayIdx={selectedDay} todayDayIdx={todayDayIdx} tz={tz} onOpen={onOpen} onToggleFav={onToggleFav} animDelay={idx * 30}/>
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
    <div style={{ padding:"0 16px 16px" }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 0" }}>
        <button style={{ background:BG3, border:`1px solid ${BD}`, color:MT, borderRadius:8, padding:"6px 14px", fontSize:16, cursor:"pointer", fontFamily:"inherit" }} onClick={() => setMonthOffset((v) => v - 1)}>‹</button>
        <span style={{ fontSize:17, fontWeight:700 }}>{MONTHS[mMon]} {mYear}</span>
        <button style={{ background:BG3, border:`1px solid ${BD}`, color:MT, borderRadius:8, padding:"6px 14px", fontSize:16, cursor:"pointer", fontFamily:"inherit" }} onClick={() => setMonthOffset((v) => v + 1)}>›</button>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:4, marginBottom:4 }}>
        {["Su","Mo","Tu","We","Th","Fr","Sa"].map((d) => <div key={d} style={{ textAlign:"center", fontSize:10, fontWeight:700, color:MT, letterSpacing:".8px", padding:"4px 0", textTransform:"uppercase" }}>{d}</div>)}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:4, marginBottom:20 }}>
        {cells.map((date, ci) => {
          const inMonth = date.getMonth() === mMon;
          const isToday = inMonth && date.getDate() === now.getDate() && date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
          const dayIdx = (date.getDay() + 6) % 7;
          const dayAnime = inMonth ? getFiltered(dayIdx) : [];
          return (
            <div key={ci}
              style={{ aspectRatio:"1", borderRadius:8, border:`1px solid ${isToday ? OR : dayAnime.length > 0 ? BD2 : "transparent"}`, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:2, cursor: dayAnime.length > 0 ? "pointer" : "default", padding:2, background: inMonth ? (isToday ? `rgba(255,107,26,.12)` : BG2) : "transparent", opacity: inMonth ? 1 : .2, transition:"background .15s" }}
              onClick={() => inMonth && setSelectedMonthDay(dayIdx)}
            >
              <div style={{ fontSize:12, fontWeight:700, color: isToday ? OR : TX, lineHeight:1 }}>{date.getDate()}</div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:2, justifyContent:"center", maxWidth:32 }}>
                {dayAnime.slice(0, 6).map((a, j) => <div key={j} style={{ width:5, height:5, borderRadius:"50%", background: favs.includes(a.id) ? OR : BD2 }}/>)}
              </div>
              {dayAnime.length > 6 && <div style={{ fontSize:9, color:MT2, fontWeight:600 }}>+{dayAnime.length - 6}</div>}
            </div>
          );
        })}
      </div>
      <div style={{ borderTop:`1px solid ${BD}`, paddingTop:12 }}>
        <div style={{ fontSize:15, fontWeight:700, marginBottom:12 }}>{DAY_SHORT[selectedMonthDay]}'s Anime ({selectedAnime.length})</div>
        {selectedAnime.length === 0 ? (
          <div style={{ textAlign:"center", padding:"32px 20px", color:MT, display:"flex", flexDirection:"column", alignItems:"center", gap:8 }}>
            <div style={{ fontSize:36 }}>📭</div>
            <div style={{ fontSize:14 }}>Nothing scheduled.</div>
          </div>
        ) : (
          Object.entries(groups).map(([time, items]) => (
            <div key={time}>
              <div style={{ display:"flex", alignItems:"center", gap:8, padding:"12px 0 8px" }}>
                <span style={{ fontSize:10, fontWeight:800, letterSpacing:".5px", textTransform:"uppercase", padding:"3px 10px", borderRadius:99, background:BG3, color:MT, border:`1px solid ${BD}`, flexShrink:0 }}>
                  {time !== "?" ? `${time} JST` : "Time unknown"}
                </span>
                <div style={{ flex:1, height:1, background:BD }}/>
              </div>
              {items.map((a, idx) => (
                <AnimeCard key={a.id} anime={a} favorites={favs} selectedDayIdx={selectedMonthDay} todayDayIdx={todayDayIdx} tz={tz} onOpen={onOpen} onToggleFav={onToggleFav} animDelay={idx * 25}/>
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

      {!IS_NATIVE && (
        <div style={{ marginTop:28, padding:"18px 16px", background:`linear-gradient(135deg, ${BG2}, ${BG3})`, border:`1px solid ${BD2}`, borderRadius:16, position:"relative", overflow:"hidden" }}>
          <div style={{ position:"absolute", top:-40, right:-30, fontSize:120, opacity:.05, transform:"rotate(15deg)" }}>📱</div>
          <div style={{ position:"relative" }}>
            <div style={{ fontSize:11, fontWeight:700, color:OR, letterSpacing:"1px", textTransform:"uppercase" as const, marginBottom:6 }}>Pro tip</div>
            <div style={{ fontSize:16, fontWeight:800, marginBottom:6, letterSpacing:"-.3px" }}>Take AniCal everywhere</div>
            <div style={{ fontSize:12, color:MT, lineHeight:1.6, marginBottom:14 }}>Install to your home screen or grab the browser extension for one-click access from any tab.</div>
            <div style={{ display:"flex", gap:8, flexWrap:"wrap" as const }}>
              <button style={{ background:`linear-gradient(135deg, ${OR}, #cc5610)`, color:"#fff", border:"none", borderRadius:99, padding:"10px 16px", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"inherit", boxShadow:`0 6px 20px -4px rgba(255,107,26,.5)` }} onClick={installPwa}>📱 Install app</button>
              <button style={{ background:BG3, color:TX, border:`1px solid ${BD}`, borderRadius:99, padding:"10px 16px", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }} onClick={downloadExtension}>🧩 Extension</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Bottom nav ─────────────────────────────────────────────────────────────────
function BottomNav({ view, setView, favCount }: { view: string; setView: (v: "schedule"|"month"|"stats") => void; favCount: number }) {
  const tabs: { id: "schedule"|"month"|"stats"; emoji: string; label: string }[] = [
    { id:"schedule", emoji:"📋", label:"Schedule" },
    { id:"month",    emoji:"📅", label:"Calendar" },
    { id:"stats",    emoji:"⭐", label:"My List"  },
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
          {/* Frosted glass header */}
          <div style={{ position:"sticky", top:0, zIndex:50, background:`rgba(9,9,15,0.88)`, backdropFilter:"blur(24px) saturate(1.4)", borderBottom:`1px solid rgba(37,37,51,0.8)`, padding:"14px 16px 12px" } as React.CSSProperties}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, fontSize:20, fontWeight:800, letterSpacing:"-0.5px" }}>
                <StarLogo size={26}/>
                Ani<span style={{ color:OR }}>Cal</span>
              </div>
              <div style={{ display:"flex", gap:8 }}>
                <button
                  style={{ background: favFilter ? OR2 : BG3, border:`1px solid ${favFilter ? OR3 : BD}`, color: favFilter ? OR : MT, borderRadius:10, padding:"7px 13px", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit", transition:"all .15s" }}
                  onClick={() => setFavFilter((v) => !v)}
                >★ Favs</button>
                <button
                  style={{ background:BG3, border:`1px solid ${BD}`, color:MT, borderRadius:10, padding:"7px 13px", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit" }}
                  onClick={() => loadSchedule(true)}
                >↻</button>
              </div>
            </div>
          </div>

          {/* Search */}
          <div style={{ padding:"10px 16px 0" }}>
            <input
              style={{ width:"100%", background:BG3, border:`1px solid ${BD}`, borderRadius:10, padding:"10px 14px", color:TX, fontSize:14, fontFamily:"inherit", outline:"none", boxSizing:"border-box" }}
              placeholder="Search anime…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {/* Auto timezone + last updated */}
          {lastUpdated && (
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, padding:"6px 16px 0" }}>
              <div style={{ fontSize:10, color:MT, display:"flex", alignItems:"center", gap:4 }}>
                <span>🌐</span>
                <span>{getDeviceTz().replace(/_/g, " ")}</span>
              </div>
              <div style={{ fontSize:10, color:MT2 }}>Updated {lastUpdated.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" })}</div>
            </div>
          )}

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

          {/* Bottom navigation */}
          <BottomNav view={view} setView={setView} favCount={favs.length}/>

          {/* Detail sheet */}
          {detailAnime && (
            <DetailSheet anime={detailAnime} favorites={favs} tz={tz}
              onClose={() => setDetailAnime(null)}
              onToggleFav={(id: number) => { toggleFav(id); setDetailAnime((a) => (a ? { ...a } : null)); }}/>
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

