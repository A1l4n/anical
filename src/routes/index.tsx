import { createFileRoute } from "@tanstack/react-router";
import AniCal from "@/components/AniCal";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "AniCal — Anime Airing Schedule" },
      { name: "description", content: "Live anime airing calendar with JST→local time conversion, favorites, and monthly view. Powered by MyAnimeList." },
      { name: "theme-color", content: "#0d0d12" },
      { property: "og:title", content: "AniCal — Anime Airing Schedule" },
      { property: "og:description", content: "Live anime airing calendar with JST→local time conversion." },
    ],
    links: [
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/icon-512.png" },
    ],
  }),
  component: AniCal,
});
