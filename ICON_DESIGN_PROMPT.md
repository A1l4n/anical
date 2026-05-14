# AniCal Icon — Design Prompt for Claude

Paste this prompt into a fresh Claude conversation (with image generation or attached as a design brief). Output a transparent-background 1024×1024 PNG plus a flattened 512×512 PNG for the Android launcher.

---

## Brief

Design a launcher / favicon icon for **AniCal**, a mobile-first anime airing calendar. The app's identity: time-sensitive, anime-flavored, dark-mode, and slightly playful — but premium feeling, not childish.

## Brand palette (lock to these — don't invent new hues)

- **Primary orange**: `#F47521` (Crunchyroll-adjacent, warm)
- **Deep accent**: `#C43D0D`
- **Highlight**: `#FF9558`
- **Background dark**: `#0D0D12`
- **Surface**: `#141419`
- **Stroke**: `#2C2C38`
- **Glow / soft accent**: `rgba(244,117,33,0.35)`

## Mandatory composition

- **Foreground motif**: a stylized **manji-style 4-point star / sparkle / sunburst** in the brand orange — same silhouette family as the existing in-app logo (the path `M13 3.5l2.2 6.3h6.6l-5.3 3.9 2 6.3L13 16.2l-5.5 3.8 2-6.3L4.2 9.8h6.6L13 3.5z`). Modernize and refine it, but keep that recognizable 4-point burst shape so the app icon and in-app logo feel like the same brand.
- **Subtle clock / time signal**: integrate one tasteful time cue — e.g. a faint minute-marker ring around the star, a curved tick at one corner, OR the star doubling as a clock-hand pivot. Time is the app's whole point; the icon should hint at it without screaming "calendar."
- **Background**: rounded squircle (Apple-style continuous corner radius, NOT iOS hard square) filled with a soft **radial gradient** from `#F47521` at the upper-left highlight to `#C43D0D` in the lower-right shadow. Add a faint inner glow (~5–8% white) at the top edge for depth.

## Style rules

- **Flat-modern with one layer of polish.** No gradients on the star itself — keep it pure white or `#FFFFFF` over the orange ground for maximum contrast at 48px. Allow ONE highlight: a faint diagonal sheen across the upper-left of the orange ground (~6% white), and a 1px inner stroke (`rgba(0,0,0,0.15)`) on the squircle edge for crispness.
- **No emoji. No outlines around the star itself. No drop shadows leaking outside the squircle. No text in the icon.** The wordmark "AniCal" lives in the header, not the icon.
- **Optical balance**: star centered visually (not mathematically) — usually means the geometric center sits ~3% above center to compensate for the bottom-heavy bursts.
- **Padding**: 14–16% safe area inside the squircle so the star never crowds the corners. Android Adaptive Icons crop aggressively.

## Sizes to deliver

1. `icon-1024.png` — 1024×1024, transparent background outside the squircle (for app store submissions).
2. `icon-512.png` — 512×512, flattened with squircle (replaces `public/icon-512.png` and `extension/icon.png`).
3. `icon-192.png` — 192×192, same as above, downscaled.
4. `icon-foreground.png` — 432×432, just the white star centered (no background) for Android Adaptive Icon foreground layer.
5. `icon-background.png` — 432×432, the orange squircle gradient only, no star (Adaptive Icon background layer).

## What success looks like

- Recognizable at 48px on a crowded home screen — the silhouette reads as "burst / star / spark," not "blob."
- Premium and current — feels like a 2026 app icon, not a 2015 skeuomorphic one.
- Consistent with the orange used everywhere in the app (`#F47521`) so opening the app feels like a continuation of the icon, not a context switch.

## What to avoid

- Generic calendar grid (3×3 squares with a number — too literal, every app does this)
- Anime girl illustration / mascot (locks the brand to one art style)
- Multiple colors competing with the orange — orange + white + dark stroke is enough
- Photorealistic lens flares, sparkles, glitter
- Stock "play button," "TV," or "remote" icons
- Crunchyroll's actual logo — adjacent palette is fine, ripping the mark is not

## Where it will be used

- Android launcher (`android/app/src/main/res/mipmap-*` — needs adaptive icon)
- PWA `manifest.webmanifest` (192, 512 maskable)
- Browser extension toolbar (16, 48, 128)
- Favicon / `apple-touch-icon`
- App store screenshots (1024×1024)
