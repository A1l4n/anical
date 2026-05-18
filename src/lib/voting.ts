// ── Anime of the Week voting ─────────────────────────────────────────────────
// Anonymous weekly poll backed by Supabase. One vote per device per week,
// changeable until Sunday 23:00 JST. Results cross-referenced against AniList
// trending data to verify they're not wildly out of sync with the wider
// anime community.

// Supabase config — same project used by community / art features
const SB_URL  = "https://seopeujrimwxnuvcbfxx.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNlb3BldWpyaW13eG51dmNiZnh4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3NjUzNjEsImV4cCI6MjA5NDM0MTM2MX0.XT8abPOuAygiZEP7HOwbF7Mk8Z7wqC_6cw-0lZK_ClI";

export type VoteCandidate = {
  mal_id: number;
  title: string;
  image_url: string | null;
  score: number;
  members: number;
  popularity: number;
};

export type VoteRow = {
  device_id: string;
  week_id: string;
  anime_id: number;
  anime_title: string;
  anime_image: string | null;
  voted_at: string;
};

export type ResultRow = {
  anime_id: number;
  anime_title: string;
  anime_image: string | null;
  count: number;
};

export type AniListRanking = {
  malId: number;
  trendingRank: number;     // 1 = most trending
  popularity: number;
  meanScore: number;
};

// ── Device identity ──────────────────────────────────────────────────────────
// Persistent UUID stored in localStorage. Weak (clearable) but acceptable for
// an anonymous v1; a real fix would require auth or IP-fingerprinting.
export function getDeviceId(): string {
  if (typeof window === "undefined") return "ssr-noop";
  try {
    let id = localStorage.getItem("anical_device_id");
    if (id && id.length >= 10) return id;
    id = generateUuid();
    localStorage.setItem("anical_device_id", id);
    return id;
  } catch {
    return "fallback-" + Math.random().toString(36).slice(2);
  }
}

function generateUuid(): string {
  // crypto.randomUUID is available in all modern browsers / Capacitor 8
  try { return (crypto as any).randomUUID(); } catch {}
  // Fallback: rfc4122-ish v4
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── Week identifier (JST-anchored) ───────────────────────────────────────────
// Anime broadcasts on a Monday-JST cycle, so weeks roll over at Monday 00:00 JST.
// Returns ISO-week-style string "YYYY-WNN".
export function getWeekId(now: Date = new Date()): string {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const utcYear  = jst.getUTCFullYear();
  const utcMonth = jst.getUTCMonth();
  const utcDate  = jst.getUTCDate();
  // ISO week: Monday = 1, Sunday = 7
  const d = new Date(Date.UTC(utcYear, utcMonth, utcDate));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);   // Thursday of this week
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

// ── Time helpers ─────────────────────────────────────────────────────────────
// Sunday 23:00 JST = the close-of-voting moment for the current week.
export function getVoteCloseJst(now: Date = new Date()): Date {
  // Find the next Sunday at 23:00 JST in user-local time
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  // Sunday in JST = day 0 in JS using UTC accessor (since we offset to JST)
  const jstDay = jst.getUTCDay();
  const daysUntilSunday = (7 - jstDay) % 7;
  // Build Sunday 23:00 JST in UTC: subtract 9h offset
  const sundayJstY = jst.getUTCFullYear();
  const sundayJstM = jst.getUTCMonth();
  const sundayJstD = jst.getUTCDate() + daysUntilSunday;
  const sundayUtcMs = Date.UTC(sundayJstY, sundayJstM, sundayJstD, 23 - 9, 0, 0);
  // If we computed "today Sunday < 23:00 JST", that's still in the future.
  // If "today Sunday >= 23:00 JST", roll forward 7 days.
  if (sundayUtcMs <= now.getTime()) return new Date(sundayUtcMs + 7 * 86_400_000);
  return new Date(sundayUtcMs);
}

export function getTimeUntil(target: Date, now: Date = new Date()): { days: number; hours: number; minutes: number; totalMs: number } {
  const diff = Math.max(0, target.getTime() - now.getTime());
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  return { days, hours, minutes, totalMs: diff };
}

// Returns true if the current moment is in the "results revealed" window:
// Sunday 23:00 JST → Monday 00:01 JST (next day).
export function isWinnerWindow(now: Date = new Date()): boolean {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const day = jst.getUTCDay();
  const hour = jst.getUTCHours();
  return (day === 0 && hour >= 23) || (day === 1 && hour === 0);
}

// Next Monday morning (local time) when we want to fire the "Voting opens"
// notification. Default 11:00 user-local time so it doesn't wake anyone up.
export function nextMondayNotifyAt(hour: number = 11, now: Date = new Date()): Date {
  const d = new Date(now.getTime());
  d.setHours(hour, 0, 0, 0);
  // Days until next Monday (0 = today is Monday and time hasn't passed yet)
  let daysAhead = (1 - d.getDay() + 7) % 7;
  if (daysAhead === 0 && d.getTime() <= now.getTime()) daysAhead = 7;
  d.setDate(d.getDate() + daysAhead);
  return d;
}

// ── Supabase REST ────────────────────────────────────────────────────────────
async function sb<T>(path: string, opts?: RequestInit): Promise<T> {
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
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── Candidate pool ───────────────────────────────────────────────────────────
// Pulls top currently-airing TV anime from Jikan, picks the top 6 by score with
// a small popularity boost. Cached in LS for 24h so the candidates are stable
// for the whole week.
const CANDIDATES_TTL = 24 * 3600 * 1000;
const CANDIDATES_KEY = (weekId: string) => `vote_candidates_${weekId}`;

export async function getCandidates(weekId: string = getWeekId()): Promise<VoteCandidate[]> {
  // Try LS cache first
  try {
    const raw = localStorage.getItem(CANDIDATES_KEY(weekId));
    if (raw) {
      const cached = JSON.parse(raw) as { ts: number; data: VoteCandidate[] };
      if (Date.now() - cached.ts < CANDIDATES_TTL && Array.isArray(cached.data) && cached.data.length >= 6) {
        return cached.data;
      }
    }
  } catch {}

  // Fetch top-airing from Jikan (currently airing, sorted by score)
  const res = await fetch(
    `https://api.jikan.moe/v4/anime?status=airing&type=tv&order_by=score&sort=desc&limit=25`,
    { signal: AbortSignal.timeout(10_000) }
  );
  if (!res.ok) throw new Error(`Jikan ${res.status}`);
  const json = await res.json();
  const items: any[] = json.data || [];
  // Filter out anime without scores so the top 6 are meaningful
  const scored = items.filter((a) => typeof a.score === "number" && a.score > 0);
  // Take top 6 by Jikan's score, but bump anime with very high member counts
  // so an obscure 9.5-rated show doesn't beat Frieren-tier juggernauts.
  const sorted = scored.sort((a, b) => {
    const aScore = a.score + Math.log10(Math.max(1, a.members || 1)) * 0.1;
    const bScore = b.score + Math.log10(Math.max(1, b.members || 1)) * 0.1;
    return bScore - aScore;
  });
  const top6 = sorted.slice(0, 6).map((a): VoteCandidate => ({
    mal_id: a.mal_id,
    title: a.title_english || a.title || "Untitled",
    image_url: a.images?.webp?.image_url || a.images?.jpg?.image_url || null,
    score: a.score,
    members: a.members || 0,
    popularity: a.popularity || 0,
  }));
  try { localStorage.setItem(CANDIDATES_KEY(weekId), JSON.stringify({ ts: Date.now(), data: top6 })); } catch {}
  return top6;
}

// ── Vote actions ─────────────────────────────────────────────────────────────
export async function submitVote(candidate: VoteCandidate): Promise<{ success: boolean; alreadyVoted?: boolean; error?: string }> {
  const device_id = getDeviceId();
  const week_id = getWeekId();
  const body = {
    device_id,
    week_id,
    anime_id: candidate.mal_id,
    anime_title: candidate.title,
    anime_image: candidate.image_url,
  };
  try {
    // Try upsert via on_conflict — overwrites a previous vote for this device+week
    const res = await fetch(`${SB_URL}/rest/v1/votes?on_conflict=device_id,week_id`, {
      method: "POST",
      headers: {
        "apikey": SB_ANON,
        "Authorization": `Bearer ${SB_ANON}`,
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // 409 = unique violation, return alreadyVoted hint just in case the upsert path differs
      if (res.status === 409) return { success: false, alreadyVoted: true };
      return { success: false, error: `Supabase ${res.status}: ${text.slice(0, 120)}` };
    }
    // Cache the local vote for instant feedback
    try { localStorage.setItem(`vote_${week_id}`, JSON.stringify({ anime_id: candidate.mal_id, anime_title: candidate.title })); } catch {}
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || "Network error" };
  }
}

export async function getMyVote(weekId: string = getWeekId()): Promise<{ anime_id: number; anime_title: string } | null> {
  // Try local cache first to avoid a network round-trip
  try {
    const raw = localStorage.getItem(`vote_${weekId}`);
    if (raw) return JSON.parse(raw);
  } catch {}
  const device_id = getDeviceId();
  try {
    const rows = await sb<VoteRow[]>(`votes?device_id=eq.${encodeURIComponent(device_id)}&week_id=eq.${encodeURIComponent(weekId)}&select=anime_id,anime_title&limit=1`);
    if (rows.length === 0) return null;
    const out = { anime_id: rows[0].anime_id, anime_title: rows[0].anime_title };
    try { localStorage.setItem(`vote_${weekId}`, JSON.stringify(out)); } catch {}
    return out;
  } catch { return null; }
}

export async function getResults(weekId: string = getWeekId()): Promise<{ rows: ResultRow[]; total: number }> {
  // Pull all rows for the week and aggregate client-side (small N, fast enough)
  const rows = await sb<VoteRow[]>(`votes?week_id=eq.${encodeURIComponent(weekId)}&select=anime_id,anime_title,anime_image`);
  const map = new Map<number, ResultRow>();
  for (const v of rows) {
    const existing = map.get(v.anime_id);
    if (existing) existing.count++;
    else map.set(v.anime_id, { anime_id: v.anime_id, anime_title: v.anime_title, anime_image: v.anime_image, count: 1 });
  }
  const out = Array.from(map.values()).sort((a, b) => b.count - a.count);
  return { rows: out, total: rows.length };
}

// ── AniList cross-platform trending ──────────────────────────────────────────
// Free GraphQL endpoint (no auth). We query the currently-airing season and
// match results back to candidates by MAL id so the comparison column lines up.
const ANILIST_CACHE_KEY = (weekId: string) => `anilist_trending_${weekId}`;
const ANILIST_TTL = 6 * 3600 * 1000;

export async function fetchAniListRankings(weekId: string = getWeekId()): Promise<AniListRanking[]> {
  // Cache first
  try {
    const raw = localStorage.getItem(ANILIST_CACHE_KEY(weekId));
    if (raw) {
      const cached = JSON.parse(raw) as { ts: number; data: AniListRanking[] };
      if (Date.now() - cached.ts < ANILIST_TTL) return cached.data;
    }
  } catch {}

  // Figure out the AniList season + year from today
  const now = new Date();
  const month = now.getMonth(); // 0-indexed
  const year = now.getFullYear();
  const season =
    month <= 2 ? "WINTER" :
    month <= 5 ? "SPRING" :
    month <= 8 ? "SUMMER" : "FALL";

  const query = `
    query ($season: MediaSeason, $year: Int) {
      Page(page: 1, perPage: 50) {
        media(sort: TRENDING_DESC, season: $season, seasonYear: $year, type: ANIME, status: RELEASING) {
          idMal
          title { romaji english }
          trending
          popularity
          meanScore
        }
      }
    }
  `;
  try {
    const res = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ query, variables: { season, year } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    const items: any[] = json?.data?.Page?.media || [];
    const ranked: AniListRanking[] = items
      .filter((m) => m.idMal)
      .map((m, i): AniListRanking => ({
        malId: m.idMal,
        trendingRank: i + 1,
        popularity: m.popularity ?? 0,
        meanScore: m.meanScore ?? 0,
      }));
    try { localStorage.setItem(ANILIST_CACHE_KEY(weekId), JSON.stringify({ ts: Date.now(), data: ranked })); } catch {}
    return ranked;
  } catch {
    return [];
  }
}

// Convenience: returns a Map keyed by MAL id for quick lookup
export async function buildAniListLookup(weekId: string = getWeekId()): Promise<Map<number, AniListRanking>> {
  const rankings = await fetchAniListRankings(weekId);
  const map = new Map<number, AniListRanking>();
  for (const r of rankings) map.set(r.malId, r);
  return map;
}
