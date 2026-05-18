// ── Episode tracking ─────────────────────────────────────────────────────────
// Per-anime watched-episode state lives in localStorage so it works offline and
// without any backend. Jikan supplies the actual episode list which we cache for
// 4 hours per anime.

import { useEffect, useState } from "react";

export type Episode = {
  number: number;
  title: string | null;
  title_romanji: string | null;
  title_japanese: string | null;
  aired: string | null;
  score: number | null;
  filler: boolean;
  recap: boolean;
  forum_url: string | null;
};

const EP_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours
const WATCHED_KEY    = (id: number) => `watched_eps_${id}`;
const EP_CACHE_KEY   = (id: number) => `ep_cache_${id}`;
const SPOILER_OVERRIDE_KEY = (id: number) => `spoiler_shield_override_${id}`;

// ── Safe LS helpers (no JSON.parse explosions) ─────────────────────────────
function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

// ── Watched state ──────────────────────────────────────────────────────────
export function getWatchedEpisodes(animeId: number): number[] {
  const arr = readJSON<number[]>(WATCHED_KEY(animeId), []);
  return Array.isArray(arr) ? arr.filter((n) => typeof n === "number") : [];
}

export function markEpisodeWatched(animeId: number, epNumber: number): number[] {
  const current = getWatchedEpisodes(animeId);
  if (current.includes(epNumber)) return current;
  const next = [...current, epNumber].sort((a, b) => a - b);
  writeJSON(WATCHED_KEY(animeId), next);
  return next;
}

export function markEpisodeUnwatched(animeId: number, epNumber: number): number[] {
  const current = getWatchedEpisodes(animeId);
  const next = current.filter((n) => n !== epNumber);
  writeJSON(WATCHED_KEY(animeId), next);
  return next;
}

export function getProgress(animeId: number, totalEps: number): { watched: number; total: number; pct: number } {
  const watched = getWatchedEpisodes(animeId).length;
  const total = Math.max(0, totalEps || 0);
  const pct = total > 0 ? Math.min(100, Math.round((watched / total) * 100)) : 0;
  return { watched, total, pct };
}

export function isLastEpisode(epNumber: number, totalEps: number): boolean {
  return totalEps > 0 && epNumber >= totalEps;
}

export function getNextUnwatched(animeId: number, totalEps: number): number | null {
  if (!totalEps || totalEps <= 0) return null;
  const watched = new Set(getWatchedEpisodes(animeId));
  for (let i = 1; i <= totalEps; i++) {
    if (!watched.has(i)) return i;
  }
  return null;
}

// ── Spoiler shield (per-anime override on top of the global no-spoiler flag) ──
export type ShieldOverride = "on" | "off" | null;
export function getSpoilerShieldOverride(animeId: number): ShieldOverride {
  if (typeof window === "undefined") return null;
  try {
    const v = localStorage.getItem(SPOILER_OVERRIDE_KEY(animeId));
    return v === "on" || v === "off" ? v : null;
  } catch { return null; }
}
export function setSpoilerShieldOverride(animeId: number, value: ShieldOverride): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) localStorage.removeItem(SPOILER_OVERRIDE_KEY(animeId));
    else                localStorage.setItem(SPOILER_OVERRIDE_KEY(animeId), value);
  } catch {}
}
// Effective shield state: per-anime override wins; otherwise fall back to global
export function isShieldActive(animeId: number, globalNoSpoiler: boolean): boolean {
  const override = getSpoilerShieldOverride(animeId);
  if (override === "on")  return true;
  if (override === "off") return false;
  return globalNoSpoiler;
}
export function isEpisodeSpoiler(animeId: number, episodeNumber: number, globalNoSpoiler: boolean): boolean {
  if (!isShieldActive(animeId, globalNoSpoiler)) return false;
  const watched = getWatchedEpisodes(animeId);
  if (watched.length === 0) return episodeNumber > 1; // Episode 1 is never a spoiler
  const lastWatched = Math.max(...watched);
  return episodeNumber > lastWatched;
}

// ── Jikan fetcher with localStorage cache ────────────────────────────────────
async function fetchAnimeEpisodesFromJikan(animeId: number): Promise<Episode[]> {
  const res = await fetch(`https://api.jikan.moe/v4/anime/${animeId}/episodes?page=1`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Jikan ${res.status}`);
  const json = await res.json();
  const items: any[] = json.data || [];
  return items.map((e) => ({
    number:           e.mal_id ?? e.episode ?? 0,
    title:            e.title ?? null,
    title_romanji:    e.title_romanji ?? null,
    title_japanese:   e.title_japanese ?? null,
    aired:            e.aired ?? null,
    score:            typeof e.score === "number" ? e.score : null,
    filler:           !!e.filler,
    recap:            !!e.recap,
    forum_url:        e.forum_url ?? null,
  }));
}

export type EpisodesState = {
  episodes: Episode[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
};

// React hook: cached episode list for an anime.
// Reads from a 4h LS cache before hitting Jikan; surfaces loading/error state.
export function useAnimeEpisodes(animeId: number | null | undefined): EpisodesState {
  const [state, setState] = useState<{ episodes: Episode[]; loading: boolean; error: string | null }>({
    episodes: [], loading: true, error: null,
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!animeId) { setState({ episodes: [], loading: false, error: null }); return; }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    const cached = readJSON<{ ts: number; data: Episode[] } | null>(EP_CACHE_KEY(animeId), null);
    if (cached && Date.now() - cached.ts < EP_CACHE_TTL && Array.isArray(cached.data)) {
      setState({ episodes: cached.data, loading: false, error: null });
      return; // serve from cache; no fetch needed
    }

    fetchAnimeEpisodesFromJikan(animeId)
      .then((episodes) => {
        if (cancelled) return;
        writeJSON(EP_CACHE_KEY(animeId), { ts: Date.now(), data: episodes });
        setState({ episodes, loading: false, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ episodes: [], loading: false, error: err?.message || "Couldn't load episodes" });
      });

    return () => { cancelled = true; };
  }, [animeId, tick]);

  return { ...state, refetch: () => setTick((t) => t + 1) };
}
