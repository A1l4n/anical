// ── Affiliate link helpers ─────────────────────────────────────────────────
// Curated search deep-links to merch / manga partners. Replace the affiliate
// IDs below with real ones from the corresponding partner programs before
// publishing. The current URLs work standalone — the affiliate-tag parameters
// just track attribution and earn commissions when present.

// TODO: replace `AFF_TAG_*` placeholders once partner accounts are approved.
//   - Crunchyroll Store    → Impact Radius affiliate program (impact.com)
//   - CDJapan              → CDJapan partner program
//   - Manga+               → no public affiliate program (links pass through verbatim)
const AFF_TAG_CRUNCHYROLL = ""; // e.g. "?irgwc=1&clickref=YOURCLICKREF"
const AFF_TAG_CDJAPAN     = ""; // e.g. "&affid=YOURID"

/**
 * Search the Crunchyroll Store for merch tied to an anime title.
 * Falls back to the unaffiliated search URL when the tag is empty.
 */
export function getCrunchyrollStoreLink(animeName: string): string {
  const q = encodeURIComponent(animeName.trim());
  const utm = "utm_source=anical&utm_medium=app&utm_campaign=affiliate";
  return `https://store.crunchyroll.com/search?q=${q}&${utm}${AFF_TAG_CRUNCHYROLL}`;
}

/**
 * Search CDJapan for figures, BD/DVDs, soundtracks, and manga sets.
 */
export function getCDJapanLink(animeName: string): string {
  const q = encodeURIComponent(animeName.trim());
  return `https://www.cdjapan.co.jp/searchuni?q=${q}&utm_source=anical${AFF_TAG_CDJAPAN}`;
}

/**
 * Search Manga+ (Shueisha) for an official manga reader page if one exists.
 */
export function getMangaPlusLink(animeName: string): string {
  const q = encodeURIComponent(animeName.trim());
  return `https://mangaplus.shueisha.co.jp/search_result?keyword=${q}`;
}

/**
 * Standard disclaimer copy to surface in the UI whenever we link out.
 * Adjusts wording slightly so it doesn't read identically in every screen.
 */
export const AFFILIATE_DISCLAIMER = "Affiliate links — we earn a small commission at no extra cost to you.";
