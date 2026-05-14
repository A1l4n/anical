import { useState, useEffect, useCallback, useRef } from "react";

// ── constants ──────────────────────────────────────────────────────────────
const DAYS = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"] as const;
const DAY_SHORT = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const OR = "#F47521";
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

// ── Timezone presets (country → IANA tz) ───────────────────────────────────
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

function getDeviceTz(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

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

// ── Jikan fetcher (direct, no API key needed) ──────────────────────────────
async function fetchDay(day: string): Promise<Anime[]> {
  const res = await fetch(`https://api.jikan.moe/v4/schedules?filter=${day}&limit=25&sfw=false`);
  if (!res.ok) throw new Error(`Jikan ${res.status}`);
  const json = await res.json();
  const data: any[] = json.data || [];
  const mapped = data.map((a) => ({
    id: a.mal_id,
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
  }));
  // Dedupe by id (Jikan can return the same series twice per day)
  const seen = new Set<number>();
  return mapped.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}

function jstToLocal(jstTime?: string | null, tz?: string) {
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

function capitalize(s?: string | null) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }

// localStorage helpers (SSR-safe)
const LS = {
  get<T>(k: string, fallback: T): T {
    if (typeof window === "undefined") return fallback;
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(k: string, v: unknown) {
    if (typeof window === "undefined") return;
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  },
};

// ── styles ─────────────────────────────────────────────────────────────────
const s: any = {
  app: { fontFamily:"'Outfit',system-ui,sans-serif", background:BG, minHeight:"100vh", color:TX, maxWidth:480, margin:"0 auto", position:"relative" },
  header: { position:"sticky", top:0, zIndex:50, background:BG, borderBottom:`1px solid ${BD}`, padding:"14px 16px 0" },
  headerTop: { display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 },
  logo: { display:"flex", alignItems:"center", gap:8, fontSize:20, fontWeight:800, letterSpacing:"-0.5px" },
  logoAccent: { color:OR },
  actions: { display:"flex", gap:8 },
  iconBtn: { background:BG3, border:`1px solid ${BD}`, color:MT, borderRadius:8, padding:"6px 12px", fontSize:13, fontWeight:600, cursor:"pointer", fontFamily:"inherit" },
  iconBtnActive: { background:OR2, border:`1px solid ${OR3}`, color:OR },
  tabs: { display:"flex", gap:0, margin:"0 -16px", padding:"0 16px", overflowX:"auto", scrollbarWidth:"none" },
  tab: { flexShrink:0, padding:"8px 22px", fontSize:14, fontWeight:600, color:MT, border:"none", background:"none", cursor:"pointer", fontFamily:"inherit", borderBottom:`2px solid transparent` },
  tabActive: { color:TX, borderBottom:`2px solid ${OR}` },
  searchWrap: { padding:"10px 16px", background:BG },
  searchInput: { width:"100%", background:BG3, border:`1px solid ${BD}`, borderRadius:8, padding:"9px 14px", color:TX, fontSize:14, fontFamily:"inherit", outline:"none", boxSizing:"border-box" },
  main: { padding:"0 0 80px" },
  loadBox: { display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"60px 20px", gap:16 },
  spinner: { width:36, height:36, border:`3px solid ${BD2}`, borderTopColor:OR, borderRadius:"50%", animation:"spin .7s linear infinite" },
  loadTitle: { fontSize:16, fontWeight:600 },
  loadSub: { fontSize:12, color:MT, textAlign:"center", lineHeight:1.6, whiteSpace:"pre-line" },
  progressWrap: { width:200, height:3, background:BD, borderRadius:2, overflow:"hidden" },
  progressBar: (pct: number) => ({ height:"100%", background:OR, borderRadius:2, width:`${pct}%`, transition:"width .4s" }),
  dayNav: { display:"flex", gap:6, padding:"12px 16px", overflowX:"auto", scrollbarWidth:"none", background:BG },
  dayPill: (active: boolean, today: boolean) => ({
    flexShrink:0, display:"flex", flexDirection:"column", alignItems:"center", gap:2,
    padding:"8px 12px", borderRadius:8, border:`1px solid ${active ? OR : today ? OR3 : BD}`,
    cursor:"pointer", background: active ? OR : BG2, minWidth:52,
  }),
  dayPillName: (active: boolean, today: boolean) => ({ fontSize:10, fontWeight:700, letterSpacing:".8px", textTransform:"uppercase", color: active ? "rgba(255,255,255,.8)" : today ? OR : MT }),
  dayPillNum: (active: boolean) => ({ fontSize:18, fontWeight:700, color: active ? "#fff" : TX }),
  dayPillCount: (active: boolean) => ({ fontSize:10, fontWeight:500, color: active ? "rgba(255,255,255,.6)" : MT2 }),
  listWrap: { padding:"0 16px 16px" },
  timeLabel: { fontSize:11, fontWeight:700, color:MT, letterSpacing:".6px", textTransform:"uppercase", padding:"12px 0 6px", display:"flex", alignItems:"center", gap:8 },
  timeLabelLine: { flex:1, height:1, background:BD },
  localTime: { color:OR, fontSize:10, fontWeight:600 },
  card: (fav: boolean, now: boolean) => ({
    background: fav ? `rgba(244,117,33,.07)` : BG2,
    border: `1px solid ${fav ? OR3 : now ? "rgba(34,197,94,.35)" : BD}`,
    borderRadius:12, display:"flex", gap:12, padding:12, marginBottom:8,
    cursor:"pointer", position:"relative", overflow:"hidden",
  }),
  thumb: { width:52, height:72, borderRadius:6, objectFit:"cover", flexShrink:0, background:BG4 },
  thumbPlaceholder: { width:52, height:72, borderRadius:6, flexShrink:0, background:BG4, display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, color:MT2 },
  cardInfo: { flex:1, minWidth:0, display:"flex", flexDirection:"column", gap:4 },
  cardTitle: { fontSize:14, fontWeight:700, lineHeight:1.3, color:TX, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical" },
  cardMeta: { display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" },
  score: { fontSize:12, fontWeight:700, color:OR },
  epBadge: { fontSize:11, color:MT, background:BG4, padding:"2px 6px", borderRadius:4, fontWeight:600 },
  genre: { fontSize:11, color:MT },
  airRow: { fontSize:12, fontWeight:600, color:TX, display:"flex", alignItems:"center", gap:4, marginTop:2 },
  airJst: { fontSize:10, color:MT, fontWeight:400 },
  airLocal: { fontSize:11, color:OR, fontWeight:600 },
  favBtn: (fav: boolean) => ({ flexShrink:0, alignSelf:"flex-start", background:"none", border:"none", cursor:"pointer", fontSize:20, padding:2, lineHeight:1, color: fav ? OR : MT2, fontFamily:"inherit" }),
  pulse: { position:"absolute", top:8, right:8, width:7, height:7, borderRadius:"50%", background:GR },
  empty: { textAlign:"center", padding:"48px 20px", color:MT, display:"flex", flexDirection:"column", alignItems:"center", gap:10 },
  emptyIcon: { fontSize:36 },
  emptyText: { fontSize:14, lineHeight:1.5 },
  monthWrap: { padding:"0 16px 16px" },
  monthNav: { display:"flex", alignItems:"center", justifyContent:"space-between", padding:"12px 0" },
  monthLabel: { fontSize:17, fontWeight:700 },
  monthNavBtn: { background:BG3, border:`1px solid ${BD}`, color:MT, borderRadius:8, padding:"6px 14px", fontSize:16, cursor:"pointer", fontFamily:"inherit" },
  monthGridHeader: { display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:4, marginBottom:4 },
  monthGridHeaderCell: { textAlign:"center", fontSize:10, fontWeight:700, color:MT, letterSpacing:".8px", padding:"4px 0", textTransform:"uppercase" },
  monthGrid: { display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:4, marginBottom:20 },
  monthCell: (today: boolean, inMonth: boolean, hasAnime: boolean) => ({
    aspectRatio:"1", borderRadius:6, border:`1px solid ${today ? OR : hasAnime ? BD2 : "transparent"}`,
    display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center",
    gap:2, cursor: hasAnime ? "pointer" : "default", padding:2,
    background: inMonth ? BG2 : "transparent", opacity: inMonth ? 1 : .25,
  }),
  monthCellNum: (today: boolean) => ({ fontSize:12, fontWeight:700, color: today ? OR : TX, lineHeight:1 }),
  monthDots: { display:"flex", flexWrap:"wrap", gap:2, justifyContent:"center", maxWidth:32 },
  dot: (fav: boolean) => ({ width:5, height:5, borderRadius:"50%", background: fav ? OR : BD2 }),
  monthCount: { fontSize:9, color:MT2, fontWeight:600 },
  statsWrap: { padding:16 },
  statGrid: { display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:20 },
  statCard: { background:BG2, border:`1px solid ${BD}`, borderRadius:12, padding:"14px 16px", display:"flex", flexDirection:"column", gap:4 },
  statVal: { fontSize:28, fontWeight:800, color:OR },
  statLabel: { fontSize:12, color:MT, fontWeight:500 },
  favCard: { background:BG2, border:`1px solid ${OR3}`, borderRadius:12, display:"flex", alignItems:"center", gap:12, padding:"10px 12px", marginBottom:8, cursor:"pointer" },
  favThumb: { width:36, height:50, borderRadius:6, objectFit:"cover", background:BG4, flexShrink:0 },
  favInfo: { flex:1, minWidth:0 },
  favName: { fontSize:13, fontWeight:700, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" },
  favDay: { fontSize:11, color:MT, marginTop:2 },
  favRemove: { background:"none", border:"none", color:MT2, fontSize:18, cursor:"pointer", fontFamily:"inherit", padding:4 },
  sheetBackdrop: { position:"fixed", inset:0, background:"rgba(0,0,0,.75)", zIndex:200 },
  sheetContent: { position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)", width:"100%", maxWidth:480, background:BG2, borderRadius:"20px 20px 0 0", border:`1px solid ${BD}`, borderBottom:"none", maxHeight:"85vh", overflowY:"auto", zIndex:201 },
  sheetHandle: { width:40, height:4, background:BD2, borderRadius:2, margin:"12px auto 0" },
  sheetBody: { padding:"16px 20px 40px" },
  sheetImg: { width:"100%", height:200, objectFit:"cover", objectPosition:"top", borderRadius:12, marginBottom:16, background:BG4 },
  sheetTitle: { fontSize:20, fontWeight:800, lineHeight:1.2, marginBottom:8 },
  sheetMeta: { display:"flex", gap:8, flexWrap:"wrap", marginBottom:12 },
  badge: (accent: boolean) => ({ fontSize:11, fontWeight:600, padding:"3px 8px", borderRadius:4, background: accent ? OR2 : BG4, color: accent ? OR : MT, border:`1px solid ${accent ? OR3 : BD}` }),
  airtimeBox: { background:BG3, border:`1px solid ${BD}`, borderRadius:8, padding:"12px 14px", marginBottom:12 },
  airtimeTitle: { fontSize:11, fontWeight:700, color:MT, textTransform:"uppercase", letterSpacing:".6px", marginBottom:6 },
  airtimeRow: { display:"flex", justifyContent:"space-between", alignItems:"center" },
  airtimeItem: { display:"flex", flexDirection:"column", alignItems:"center", gap:2 },
  airtimeVal: { fontSize:16, fontWeight:700 },
  airtimeSub: { fontSize:10, color:MT },
  synopsis: { fontSize:13, lineHeight:1.65, color:MT, marginBottom:16 },
  sheetActions: { display:"flex", gap:8 },
  sheetFavBtn: (fav: boolean) => ({ flex:1, padding:12, borderRadius:8, border:`1px solid ${fav ? OR : BD}`, background: fav ? OR2 : BG3, color: fav ? OR : MT, fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }),
  sheetCrBtn: { flex:1.5, padding:12, borderRadius:8, border:"none", background:OR, color:"#fff", fontSize:14, fontWeight:700, cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", justifyContent:"center", gap:6 },
  toast: (show: boolean) => ({ position:"fixed", bottom:84, left:"50%", transform:`translateX(-50%) translateY(${show ? 0 : 12}px)`, background:BG3, border:`1px solid ${BD2}`, borderRadius:8, padding:"8px 18px", fontSize:13, fontWeight:600, color:TX, opacity: show ? 1 : 0, transition:"all .3s", pointerEvents:"none", zIndex:300, whiteSpace:"nowrap" }),
  installBar: { position:"fixed", bottom:16, left:"50%", transform:"translateX(-50%)", display:"flex", gap:8, zIndex:150 },
  installBtn: { background:OR, color:"#fff", border:"none", borderRadius:999, padding:"10px 16px", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"inherit", boxShadow:"0 6px 20px rgba(244,117,33,.4)" },
  ghostBtn: { background:BG3, color:TX, border:`1px solid ${BD}`, borderRadius:999, padding:"10px 16px", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"inherit" },
};

function AnimeCard({ anime, favorites, onOpen, onToggleFav, selectedDayIdx }: any) {
  const isFav = favorites.includes(anime.id);
  const now = new Date();
  const todayDayIdx = (now.getDay() + 6) % 7;
  let isNow = false;
  if (anime.broadcast_time && selectedDayIdx === todayDayIdx) {
    const [h, m] = anime.broadcast_time.split(":").map(Number);
    const utcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h - 9, m);
    const diff = (utcMs - now.getTime()) / 60000;
    isNow = diff > -30 && diff <= 0;
  }
  const localTime = jstToLocal(anime.broadcast_time, anime.__tz);
  const [imgFailed, setImgFailed] = useState(false);

  return (
    <div style={s.card(isFav, isNow)} onClick={() => onOpen(anime)}>
      {isNow && <div style={s.pulse}/>}
      {anime.image_url && !imgFailed
        ? <img src={anime.image_url} alt="" style={s.thumb} loading="lazy" onError={() => setImgFailed(true)}/>
        : <div style={s.thumbPlaceholder}>🎬</div>}
      <div style={s.cardInfo}>
        <div style={s.cardTitle}>{anime.title}</div>
        <div style={s.cardMeta}>
          {anime.score && <span style={s.score}>★ {anime.score}</span>}
          {anime.episodes && <span style={s.epBadge}>{anime.episodes} eps</span>}
          {anime.genres?.[0] && <span style={s.genre}>{anime.genres[0]}</span>}
        </div>
        {anime.broadcast_time && (
          <div style={s.airRow}>
            <span>{anime.broadcast_time}</span>
            <span style={s.airJst}>JST</span>
            {localTime && <span style={s.airLocal}>→ {localTime}</span>}
          </div>
        )}
      </div>
      <button style={s.favBtn(isFav)} onClick={(e) => { e.stopPropagation(); onToggleFav(anime.id); }}>
        {isFav ? "★" : "☆"}
      </button>
    </div>
  );
}

function DetailSheet({ anime, favorites, onClose, onToggleFav, tz }: any) {
  if (!anime) return null;
  const isFav = favorites.includes(anime.id);
  const localTime = jstToLocal(anime.broadcast_time, tz);
  return (
    <>
      <div style={s.sheetBackdrop} onClick={onClose}/>
      <div style={s.sheetContent}>
        <div style={s.sheetHandle}/>
        <div style={s.sheetBody}>
          {anime.image_url && <img src={anime.image_url} alt="" style={s.sheetImg}/>}
          <div style={s.sheetTitle}>{anime.title}</div>
          <div style={s.sheetMeta}>
            {anime.score && <span style={s.badge(true)}>★ {anime.score}</span>}
            {anime.year && <span style={s.badge(false)}>{anime.year}</span>}
            {anime.season && <span style={s.badge(false)}>{capitalize(anime.season)}</span>}
            {anime.episodes && <span style={s.badge(false)}>{anime.episodes} eps</span>}
            {anime.genres?.slice(0,3).map((g: string) => <span key={g} style={s.badge(false)}>{g}</span>)}
          </div>
          {anime.broadcast_time && (
            <div style={s.airtimeBox}>
              <div style={s.airtimeTitle}>📅 Airing Time</div>
              <div style={s.airtimeRow}>
                <div style={s.airtimeItem}>
                  <div style={s.airtimeVal}>{anime.broadcast_time}</div>
                  <div style={s.airtimeSub}>Japan (JST)</div>
                </div>
                <div style={{ color:MT, fontSize:22 }}>→</div>
                <div style={s.airtimeItem}>
                  <div style={{ ...s.airtimeVal, color:OR }}>{localTime || "—"}</div>
                  <div style={s.airtimeSub}>Your time</div>
                </div>
                <div style={s.airtimeItem}>
                  <div style={{ ...s.airtimeVal, fontSize:14 }}>{capitalize(anime.broadcast_day || "")}</div>
                  <div style={s.airtimeSub}>Day</div>
                </div>
              </div>
            </div>
          )}
          <div style={s.synopsis}>{anime.synopsis || "No synopsis available."}</div>
          <div style={s.sheetActions}>
            <button style={s.sheetFavBtn(isFav)} onClick={() => onToggleFav(anime.id)}>
              {isFav ? "★ Favorited" : "☆ Add to Favorites"}
            </button>
            <button style={s.sheetCrBtn} onClick={() => window.open(`https://www.crunchyroll.com/search?q=${encodeURIComponent(anime.title)}`, "_blank")}>
              ▶ Crunchyroll
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

export default function AniCal() {
  const todayDayIdx = (new Date().getDay() + 6) % 7;
  const [schedule, setSchedule] = useState<Schedule>({});
  const [loading, setLoading] = useState(true);
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadMsg, setLoadMsg] = useState("Starting up…");
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"schedule"|"month"|"stats">("schedule");
  const [selectedDay, setSelectedDay] = useState(todayDayIdx);
  const [monthOffset, setMonthOffset] = useState(0);
  const [selectedMonthDay, setSelectedMonthDay] = useState(todayDayIdx);
  const [favs, setFavs] = useState<number[]>([]);
  const [favFilter, setFavFilter] = useState(false);
  const [search, setSearch] = useState("");
  const [detailAnime, setDetailAnime] = useState<Anime | null>(null);
  const [toast, setToast] = useState({ show: false, msg: "" });
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const [tz, setTz] = useState<string>("auto");
  const dayNavRef = useRef<HTMLDivElement>(null);

  // Load favs from localStorage on mount
  useEffect(() => { setFavs(LS.get<number[]>("anical_favs", [])); }, []);
  useEffect(() => { LS.set("anical_favs", favs); }, [favs]);

  // Load tz preference
  useEffect(() => { setTz(LS.get<string>("anical_tz", "auto")); }, []);
  useEffect(() => { LS.set("anical_tz", tz); }, [tz]);

  // PWA install prompt capture
  useEffect(() => {
    const handler = (e: any) => { e.preventDefault(); setInstallPrompt(e); };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast({ show: true, msg });
    setTimeout(() => setToast((t) => ({ ...t, show: false })), 2000);
  }, []);

  const toggleFav = useCallback((id: number) => {
    setFavs((prev) => {
      const next = prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id];
      showToast(prev.includes(id) ? "Removed from favorites" : "Added to favorites ★");
      return next;
    });
  }, [showToast]);

  const loadSchedule = useCallback(async (force = false) => {
    if (!force) {
      const cached = LS.get<{ ts: number; data: Schedule } | null>("anical_schedule_cache", null);
      if (cached && Date.now() - cached.ts < 4 * 3600 * 1000) {
        setSchedule(cached.data);
        setLastUpdated(new Date(cached.ts));
        setLoading(false);
        return;
      }
    }
    setLoading(true);
    setError(null);
    setLoadProgress(0);
    const result: Schedule = {};
    try {
      for (let i = 0; i < DAYS.length; i++) {
        const day = DAYS[i];
        setLoadMsg(`Loading ${capitalize(day)}… (${i + 1}/${DAYS.length})`);
        setLoadProgress(Math.round((i / DAYS.length) * 90));
        try {
          result[day] = await fetchDay(day);
        } catch (e) {
          console.error("Failed", day, e);
          result[day] = [];
        }
        // Jikan rate limit: ~3 req/s, give it a beat
        await new Promise((r) => setTimeout(r, 350));
      }
      setLoadProgress(100);
      setSchedule(result);
      const ts = Date.now();
      setLastUpdated(new Date(ts));
      LS.set("anical_schedule_cache", { data: result, ts });
    } catch (e: any) {
      setError(e.message || "Failed to load");
    } finally {
      setTimeout(() => setLoading(false), 300);
    }
  }, []);

  useEffect(() => { loadSchedule(); }, [loadSchedule]);

  useEffect(() => {
    if (!dayNavRef.current) return;
    const pills = dayNavRef.current.querySelectorAll("[data-day]");
    (pills[selectedDay] as HTMLElement | undefined)?.scrollIntoView({ inline: "center", behavior: "smooth", block: "nearest" });
  }, [selectedDay, view]);

  const getFiltered = useCallback((dayIdx: number) => {
    const key = DAYS[dayIdx];
    let list = schedule[key] || [];
    // Defensive dedupe (in case of stale cache)
    const seenIds = new Set<number>();
    list = list.filter((a) => { if (seenIds.has(a.id)) return false; seenIds.add(a.id); return true; });
    if (favFilter) list = list.filter((a) => favs.includes(a.id));
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((a) => (a.title || "").toLowerCase().includes(q));
    }
    return [...list].sort((a, b) => {
      if (!a.broadcast_time) return 1;
      if (!b.broadcast_time) return -1;
      return a.broadcast_time.localeCompare(b.broadcast_time);
    });
  }, [schedule, favFilter, search, favs]);

  function renderScheduleDay(dayIdx: number) {
    const anime = getFiltered(dayIdx);
    if (!anime.length) {
      return (
        <div style={s.empty}>
          <div style={s.emptyIcon}>{favFilter ? "⭐" : "📭"}</div>
          <div style={s.emptyText}>{favFilter ? "No favorites airing.\nTurn off filter to see all." : "Nothing scheduled."}</div>
        </div>
      );
    }
    const groups: Record<string, Anime[]> = {};
    anime.forEach((a) => { const k = a.broadcast_time || "?"; if (!groups[k]) groups[k] = []; groups[k].push(a); });
    const now = new Date();
    return Object.entries(groups).map(([time, items]) => {
      let isNow = false;
      let localStr: string | null = null;
      if (time !== "?") {
        const [h, m] = time.split(":").map(Number);
        const utcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h - 9, m);
        const diff = (utcMs - now.getTime()) / 60000;
        isNow = dayIdx === todayDayIdx && diff > -30 && diff <= 0;
        const opts: Intl.DateTimeFormatOptions = { hour:"2-digit", minute:"2-digit", hour12:true };
        if (tz !== "auto") opts.timeZone = tz;
        localStr = new Date(utcMs).toLocaleTimeString([], opts);
      }
      return (
        <div key={time}>
          <div style={s.timeLabel}>
            <span>{time !== "?" ? `${time} JST` : "Time Unknown"}</span>
            {isNow && <span style={s.localTime}>🟢 AIRING NOW</span>}
            {!isNow && localStr && <span style={s.localTime}>→ {localStr} local</span>}
            <div style={s.timeLabelLine}/>
          </div>
          {items.map((a) => (
            <AnimeCard key={a.id} anime={{ ...a, __tz: tz }} favorites={favs} selectedDayIdx={dayIdx}
              onOpen={setDetailAnime} onToggleFav={toggleFav}/>
          ))}
        </div>
      );
    });
  }

  const now2 = new Date();
  const monthDate = new Date(now2.getFullYear(), now2.getMonth() + monthOffset, 1);
  const monthYear = monthDate.getFullYear();
  const monthMon = monthDate.getMonth();
  const firstDow = monthDate.getDay();
  const lastDay = new Date(monthYear, monthMon + 1, 0).getDate();
  const cells: Date[] = [];
  for (let i = -firstDow; i < lastDay; i++) cells.push(new Date(monthYear, monthMon, i + 1));
  while (cells.length % 7) cells.push(new Date(monthYear, monthMon + 1, cells.length - lastDay - firstDow + 1));

  if (loading) {
    return (
      <div style={s.app}>
        <style>{`
          @keyframes spin{to{transform:rotate(360deg)}}
          @keyframes spinRev{to{transform:rotate(-360deg)}}
          @keyframes orbit{from{transform:rotate(0) translateX(56px) rotate(0)}to{transform:rotate(360deg) translateX(56px) rotate(-360deg)}}
          @keyframes pulseGlow{0%,100%{box-shadow:0 0 30px ${OR3},0 0 60px rgba(244,117,33,.2);transform:scale(1)}50%{box-shadow:0 0 50px ${OR},0 0 100px ${OR3};transform:scale(1.05)}}
          @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
          @keyframes blink{0%,40%,60%,100%{opacity:1}50%{opacity:.2}}
          @keyframes slideUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
          @keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
          @keyframes barWave{0%,100%{transform:scaleY(.3)}50%{transform:scaleY(1)}}
          .anical-orbiter{position:absolute;top:50%;left:50%;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:${OR};box-shadow:0 0 12px ${OR}}
          .anical-bar{width:5px;border-radius:3px;background:linear-gradient(180deg,${OR},#ff9558);transform-origin:bottom center;animation:barWave 1.1s ease-in-out infinite}
        `}</style>
        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", minHeight:"100vh", padding:"40px 24px", gap:28, position:"relative", overflow:"hidden" }}>
          {/* ambient bg blobs */}
          <div style={{ position:"absolute", top:"-20%", left:"-30%", width:300, height:300, borderRadius:"50%", background:"radial-gradient(circle, rgba(244,117,33,.18), transparent 70%)", filter:"blur(20px)", animation:"float 6s ease-in-out infinite" }}/>
          <div style={{ position:"absolute", bottom:"-10%", right:"-20%", width:260, height:260, borderRadius:"50%", background:"radial-gradient(circle, rgba(244,117,33,.12), transparent 70%)", filter:"blur(20px)", animation:"float 7s ease-in-out infinite reverse" }}/>

          {/* Orbital loader */}
          <div style={{ position:"relative", width:160, height:160, animation:"float 4s ease-in-out infinite" }}>
            <div style={{ position:"absolute", inset:0, borderRadius:"50%", border:`2px dashed ${BD2}`, animation:"spin 14s linear infinite" }}/>
            <div style={{ position:"absolute", inset:18, borderRadius:"50%", border:`1px solid ${OR3}`, animation:"spinRev 9s linear infinite" }}/>
            <div style={{ position:"absolute", top:"50%", left:"50%", width:80, height:80, margin:"-40px 0 0 -40px", borderRadius:"50%", background:`radial-gradient(circle, ${OR} 0%, #c95a13 100%)`, display:"flex", alignItems:"center", justifyContent:"center", animation:"pulseGlow 2s ease-in-out infinite" }}>
              <svg width="42" height="42" viewBox="0 0 26 26" fill="none">
                <path d="M13 3.5l2.2 6.3h6.6l-5.3 3.9 2 6.3L13 16.2l-5.5 3.8 2-6.3L4.2 9.8h6.6L13 3.5z" fill="#fff"/>
              </svg>
            </div>
            <div className="anical-orbiter" style={{ animation:"orbit 3s linear infinite" }}/>
            <div className="anical-orbiter" style={{ width:10, height:10, margin:"-5px 0 0 -5px", background:"#fff", animation:"orbit 3s linear infinite", animationDelay:"-1s", opacity:.7 }}/>
            <div className="anical-orbiter" style={{ width:8, height:8, margin:"-4px 0 0 -4px", background:OR, animation:"orbit 3s linear infinite", animationDelay:"-2s", opacity:.5 }}/>
          </div>

          {/* Title with playful blinking dots */}
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:22, fontWeight:800, letterSpacing:"-.5px", marginBottom:8 }}>
              Tuning into the airwaves
              <span style={{ color:OR, animation:"blink 1.4s infinite" }}>.</span>
              <span style={{ color:OR, animation:"blink 1.4s infinite", animationDelay:".2s" }}>.</span>
              <span style={{ color:OR, animation:"blink 1.4s infinite", animationDelay:".4s" }}>.</span>
            </div>
            <div key={loadMsg} style={{ fontSize:13, color:MT, animation:"slideUp .4s ease-out", minHeight:18 }}>
              {loadMsg}
            </div>
          </div>

          {/* Equalizer bars */}
          <div style={{ display:"flex", gap:5, alignItems:"flex-end", height:32 }}>
            {[0,.1,.2,.3,.4,.3,.2,.1,0].map((d, i) => (
              <div key={i} className="anical-bar" style={{ height:32, animationDelay:`${d}s` }}/>
            ))}
          </div>

          {/* Progress bar with shimmer */}
          <div style={{ width:"100%", maxWidth:280 }}>
            <div style={{ height:6, background:BG3, borderRadius:99, overflow:"hidden", position:"relative" }}>
              <div style={{
                width:`${loadProgress}%`, height:"100%",
                background:`linear-gradient(90deg, ${OR}, #ff9558, ${OR})`,
                backgroundSize:"200% 100%",
                animation:"shimmer 2s linear infinite",
                borderRadius:99,
                transition:"width .5s cubic-bezier(.4,0,.2,1)",
                boxShadow:`0 0 12px ${OR3}`,
              }}/>
            </div>
            <div style={{ display:"flex", justifyContent:"space-between", marginTop:8, fontSize:11, color:MT2, fontWeight:600 }}>
              <span>{loadProgress}%</span>
              <span>Powered by MyAnimeList</span>
            </div>
          </div>

          {/* Day chips lighting up as they load */}
          <div style={{ display:"flex", gap:6, flexWrap:"wrap", justifyContent:"center", maxWidth:300 }}>
            {DAYS.map((d, i) => {
              const done = (loadProgress / 100) * DAYS.length > i;
              return (
                <div key={d} style={{
                  fontSize:10, fontWeight:700, letterSpacing:".5px", textTransform:"uppercase",
                  padding:"5px 10px", borderRadius:99,
                  background: done ? OR2 : BG3,
                  border:`1px solid ${done ? OR3 : BD}`,
                  color: done ? OR : MT2,
                  transition:"all .4s",
                }}>{DAY_SHORT[i]}{done && " ✓"}</div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={s.app}>
        <div style={s.loadBox}>
          <div style={{ fontSize:40 }}>⚠️</div>
          <div style={s.loadTitle}>Failed to load</div>
          <div style={s.loadSub}>{error}</div>
          <button style={{ ...s.iconBtn, color:OR, borderColor:OR, marginTop:8 }} onClick={() => loadSchedule(true)}>Try Again</button>
        </div>
      </div>
    );
  }

  const totalAnime = Object.values(schedule).flat().length;
  const airingToday = getFiltered(todayDayIdx).length;
  const favAnime = DAYS.flatMap((d, i) => (schedule[d] || []).filter((a) => favs.includes(a.id)).map((a) => ({ ...a, dayIdx: i }))).filter((a, i, arr) => arr.findIndex((x) => x.id === a.id) === i);
  const genreMap: Record<string, number> = {};
  favAnime.forEach((a) => (a.genres || []).forEach((g) => { genreMap[g] = (genreMap[g] || 0) + 1; }));
  const topGenre = Object.entries(genreMap).sort((a, b) => b[1] - a[1])[0]?.[0] || "—";

  const downloadExtension = () => {
    fetch("/anical-extension.zip")
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

  return (
    <div style={s.app}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}} *{box-sizing:border-box;-webkit-tap-highlight-color:transparent} ::-webkit-scrollbar{display:none} input::placeholder{color:${MT2}} body{margin:0;background:${BG}}`}</style>

      <div style={s.header}>
        <div style={s.headerTop}>
          <div style={s.logo}>
            <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
              <circle cx="13" cy="13" r="12" fill="#F47521" opacity=".15"/>
              <path d="M13 3.5l2.2 6.3h6.6l-5.3 3.9 2 6.3L13 16.2l-5.5 3.8 2-6.3L4.2 9.8h6.6L13 3.5z" fill="#F47521"/>
            </svg>
            Ani<span style={s.logoAccent}>Cal</span>
            {favs.length > 0 && <span style={{ background:OR, color:"#fff", fontSize:10, fontWeight:700, padding:"1px 6px", borderRadius:4 }}>{favs.length}</span>}
          </div>
          <div style={s.actions}>
            <button style={{ ...s.iconBtn, ...(favFilter ? s.iconBtnActive : {}) }} onClick={() => setFavFilter((v) => !v)}>★ Favs</button>
            <button style={s.iconBtn} onClick={() => loadSchedule(true)}>↻</button>
          </div>
        </div>
        <div style={s.tabs}>
          {(["Schedule","Month","My List"] as const).map((t, i) => {
            const v = (["schedule","month","stats"] as const)[i];
            return <button key={t} style={{ ...s.tab, ...(view===v ? s.tabActive : {}) }} onClick={() => setView(v)}>{t}</button>;
          })}
        </div>
      </div>

      <div style={s.searchWrap}>
        <input style={s.searchInput} placeholder="Search anime…" value={search} onChange={(e) => setSearch(e.target.value)}/>
      </div>

      {lastUpdated && (
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, padding:"4px 16px 0" }}>
          <select
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            style={{ background:BG3, color:TX, border:`1px solid ${BD}`, borderRadius:6, fontSize:11, padding:"4px 6px", fontFamily:"inherit", maxWidth:180 }}
            title={`Detected: ${getDeviceTz()}`}
          >
            {TZ_PRESETS.map((p) => (
              <option key={p.tz} value={p.tz}>
                {p.label}{p.tz === "auto" ? ` · ${getDeviceTz()}` : ""}
              </option>
            ))}
          </select>
          <div style={{ fontSize:10, color:MT2 }}>
            Updated {lastUpdated.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" })}
          </div>
        </div>
      )}

      <div style={s.main}>
        {view === "schedule" && (
          <>
            <div style={s.dayNav} ref={dayNavRef}>
              {DAYS.map((d, i) => {
                const date = new Date(); date.setDate(date.getDate() - todayDayIdx + i);
                const count = getFiltered(i).length;
                const active = i === selectedDay;
                const today = i === todayDayIdx;
                return (
                  <div key={d} data-day={i} style={s.dayPill(active, today)} onClick={() => setSelectedDay(i)}>
                    <div style={s.dayPillName(active, today)}>{DAY_SHORT[i]}</div>
                    <div style={s.dayPillNum(active)}>{date.getDate()}</div>
                    <div style={s.dayPillCount(active)}>{count}</div>
                  </div>
                );
              })}
            </div>
            <div style={s.listWrap}>{renderScheduleDay(selectedDay)}</div>
          </>
        )}

        {view === "month" && (
          <div style={s.monthWrap}>
            <div style={s.monthNav}>
              <button style={s.monthNavBtn} onClick={() => setMonthOffset((v) => v - 1)}>‹</button>
              <span style={s.monthLabel}>{MONTHS[monthMon]} {monthYear}</span>
              <button style={s.monthNavBtn} onClick={() => setMonthOffset((v) => v + 1)}>›</button>
            </div>
            <div style={s.monthGridHeader}>
              {["Su","Mo","Tu","We","Th","Fr","Sa"].map((d) => <div key={d} style={s.monthGridHeaderCell}>{d}</div>)}
            </div>
            <div style={s.monthGrid}>
              {cells.map((date, ci) => {
                const inMonth = date.getMonth() === monthMon;
                const isToday = inMonth && date.getDate() === now2.getDate() && date.getMonth() === now2.getMonth() && date.getFullYear() === now2.getFullYear();
                const dayIdx = (date.getDay() + 6) % 7;
                const dayAnime = inMonth ? getFiltered(dayIdx) : [];
                return (
                  <div key={ci} style={s.monthCell(isToday, inMonth, dayAnime.length > 0)} onClick={() => inMonth && setSelectedMonthDay(dayIdx)}>
                    <div style={s.monthCellNum(isToday)}>{date.getDate()}</div>
                    <div style={s.monthDots}>
                      {dayAnime.slice(0, 6).map((a, j) => <div key={j} style={s.dot(favs.includes(a.id))}/>)}
                    </div>
                    {dayAnime.length > 6 && <div style={s.monthCount}>+{dayAnime.length - 6}</div>}
                  </div>
                );
              })}
            </div>
            <div style={{ borderTop:`1px solid ${BD}`, paddingTop:12 }}>
              <div style={{ fontSize:15, fontWeight:700, marginBottom:12 }}>{DAY_SHORT[selectedMonthDay]}'s Anime ({getFiltered(selectedMonthDay).length})</div>
              {renderScheduleDay(selectedMonthDay)}
            </div>
          </div>
        )}

        {view === "stats" && (
          <div style={{ padding:"4px 16px 24px" }}>
            <style>{`
              @keyframes cardIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
              .anical-fav-card{animation:cardIn .4s ease-out backwards}
              .anical-fav-card:hover{transform:translateY(-2px);border-color:${OR3}!important}
              .anical-fav-card{transition:transform .2s, border-color .2s}
            `}</style>

            {/* Hero card with gradient */}
            <div style={{
              position:"relative", overflow:"hidden",
              background:`linear-gradient(135deg, ${OR} 0%, #c43d0d 100%)`,
              borderRadius:18, padding:"20px 18px", marginBottom:16,
              boxShadow:`0 12px 32px -10px ${OR3}`,
            }}>
              <div style={{ position:"absolute", top:-30, right:-30, width:140, height:140, borderRadius:"50%", background:"rgba(255,255,255,.12)" }}/>
              <div style={{ position:"absolute", bottom:-50, right:30, width:90, height:90, borderRadius:"50%", background:"rgba(255,255,255,.08)" }}/>
              <div style={{ position:"relative" }}>
                <div style={{ fontSize:11, fontWeight:700, color:"rgba(255,255,255,.85)", letterSpacing:"1px", textTransform:"uppercase", marginBottom:4 }}>Your collection</div>
                <div style={{ fontSize:42, fontWeight:900, color:"#fff", lineHeight:1, letterSpacing:"-1.5px" }}>
                  {favs.length}<span style={{ fontSize:18, fontWeight:700, opacity:.7, marginLeft:6 }}>shows</span>
                </div>
                <div style={{ fontSize:13, color:"rgba(255,255,255,.85)", marginTop:6 }}>
                  {favAnime.filter((a) => a.dayIdx === todayDayIdx).length > 0
                    ? `🔴 ${favAnime.filter((a) => a.dayIdx === todayDayIdx).length} airing today`
                    : "No favorites airing today"}
                </div>
              </div>
            </div>

            {/* Stat tiles */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:24 }}>
              {[
                { v: totalAnime, l: "Season", icon:"📺" },
                { v: airingToday, l: "Today", icon:"📡" },
                { v: topGenre, l: "Top genre", icon:"🎭", small:true },
              ].map((stat, i) => (
                <div key={i} style={{
                  background:BG2, border:`1px solid ${BD}`, borderRadius:14,
                  padding:"12px 10px", display:"flex", flexDirection:"column", gap:4,
                  position:"relative", overflow:"hidden",
                }}>
                  <div style={{ fontSize:14, opacity:.7 }}>{stat.icon}</div>
                  <div style={{ fontSize: stat.small ? 13 : 22, fontWeight:800, color:TX, lineHeight:1.1, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{stat.v}</div>
                  <div style={{ fontSize:10, color:MT, fontWeight:600, textTransform:"uppercase", letterSpacing:".5px" }}>{stat.l}</div>
                </div>
              ))}
            </div>

            {/* My favorites section */}
            <div style={{ display:"flex", alignItems:"baseline", justifyContent:"space-between", marginBottom:14 }}>
              <div style={{ fontSize:18, fontWeight:800, letterSpacing:"-.3px" }}>My Watchlist</div>
              {favAnime.length > 0 && <div style={{ fontSize:11, color:MT2, fontWeight:600 }}>{favAnime.length} title{favAnime.length===1?"":"s"}</div>}
            </div>

            {favAnime.length === 0 ? (
              <div style={{
                padding:"40px 20px", textAlign:"center", borderRadius:14,
                border:`2px dashed ${BD2}`, background:BG2,
              }}>
                <div style={{ fontSize:48, marginBottom:8 }}>⭐</div>
                <div style={{ fontSize:14, fontWeight:700, marginBottom:4 }}>Build your watchlist</div>
                <div style={{ fontSize:12, color:MT, lineHeight:1.6 }}>Tap ☆ on any anime to track it here.<br/>You'll see when it airs in your timezone.</div>
              </div>
            ) : (
              <div style={{ display:"grid", gridTemplateColumns:"1fr", gap:10 }}>
                {favAnime.map((a, i) => (
                  <div
                    key={a.id}
                    className="anical-fav-card"
                    onClick={() => setDetailAnime(a)}
                    style={{
                      position:"relative", display:"flex", gap:12, padding:10,
                      background:BG2, border:`1px solid ${BD}`, borderRadius:14,
                      cursor:"pointer", overflow:"hidden",
                      animationDelay:`${Math.min(i*40, 400)}ms`,
                    }}
                  >
                    {/* poster with gradient overlay */}
                    <div style={{ position:"relative", flexShrink:0, width:64, height:88, borderRadius:10, overflow:"hidden", background:BG4 }}>
                      {a.image_url
                        ? <img src={a.image_url} alt="" loading="lazy" style={{ width:"100%", height:"100%", objectFit:"cover" }}/>
                        : <div style={{ width:"100%", height:"100%", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22 }}>🎬</div>}
                      <div style={{ position:"absolute", inset:0, background:"linear-gradient(180deg, transparent 50%, rgba(0,0,0,.7))" }}/>
                      {a.score && <div style={{ position:"absolute", bottom:4, left:4, right:4, fontSize:10, fontWeight:800, color:"#fff", display:"flex", alignItems:"center", gap:2 }}>★ {a.score}</div>}
                    </div>

                    <div style={{ flex:1, minWidth:0, display:"flex", flexDirection:"column", justifyContent:"space-between", padding:"2px 0" }}>
                      <div>
                        <div style={{ fontSize:14, fontWeight:700, lineHeight:1.25, color:TX, overflow:"hidden", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical", marginBottom:4 }}>
                          {a.title}
                        </div>
                        <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                          <span style={{ fontSize:10, fontWeight:700, color: a.dayIdx === todayDayIdx ? GR : MT, background: a.dayIdx === todayDayIdx ? "rgba(34,197,94,.12)" : BG3, padding:"2px 7px", borderRadius:99, border:`1px solid ${a.dayIdx === todayDayIdx ? "rgba(34,197,94,.3)" : BD}` }}>
                            {a.dayIdx === todayDayIdx ? "● TODAY" : DAY_SHORT[a.dayIdx]}
                          </span>
                          {a.genres?.[0] && <span style={{ fontSize:10, color:MT, padding:"2px 7px", borderRadius:99, background:BG3, border:`1px solid ${BD}` }}>{a.genres[0]}</span>}
                        </div>
                      </div>
                      {a.broadcast_time && (
                        <div style={{ fontSize:11, color:OR, fontWeight:700, marginTop:6 }}>
                          {jstToLocal(a.broadcast_time, tz)} <span style={{ color:MT2, fontWeight:500 }}>· {a.broadcast_time} JST</span>
                        </div>
                      )}
                    </div>

                    <button
                      onClick={(e) => { e.stopPropagation(); toggleFav(a.id); }}
                      style={{ alignSelf:"flex-start", background:"none", border:"none", color:MT2, fontSize:18, cursor:"pointer", fontFamily:"inherit", padding:4, lineHeight:1 }}
                      aria-label="Remove"
                    >✕</button>
                  </div>
                ))}
              </div>
            )}

            {/* Get the app card */}
            <div style={{
              marginTop:28, padding:"18px 16px",
              background:`linear-gradient(135deg, ${BG2}, ${BG3})`,
              border:`1px solid ${BD2}`, borderRadius:16,
              position:"relative", overflow:"hidden",
            }}>
              <div style={{ position:"absolute", top:-40, right:-30, fontSize:120, opacity:.05, transform:"rotate(15deg)" }}>📱</div>
              <div style={{ position:"relative" }}>
                <div style={{ fontSize:11, fontWeight:700, color:OR, letterSpacing:"1px", textTransform:"uppercase", marginBottom:6 }}>Pro tip</div>
                <div style={{ fontSize:16, fontWeight:800, marginBottom:6, letterSpacing:"-.3px" }}>Take AniCal everywhere</div>
                <div style={{ fontSize:12, color:MT, lineHeight:1.6, marginBottom:14 }}>
                  Install to your home screen or grab the browser extension for one-click access from any tab.
                </div>
                <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                  <button style={s.installBtn} onClick={installPwa}>📱 Install app</button>
                  <button style={s.ghostBtn} onClick={downloadExtension}>🧩 Extension</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {detailAnime && (
        <DetailSheet anime={detailAnime} favorites={favs} tz={tz}
          onClose={() => setDetailAnime(null)} onToggleFav={(id: number) => { toggleFav(id); setDetailAnime((a) => (a ? { ...a } : null)); }}/>
      )}

      <div style={s.toast(toast.show)}>{toast.msg}</div>
    </div>
  );
}