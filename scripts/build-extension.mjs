// Build the AniCal browser extension.
//
// Output: dist/anical-extension.zip — a Chromium unpacked extension that
// bundles the SPA, manifest, icon, and a background service worker for
// scheduled airing notifications.
//
// Run: `npm run build:ext` (depends on `npm run build` having produced dist/).
import { cp, mkdir, rm, readFile, writeFile, copyFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dist = join(root, "dist");
const tmpl = join(root, "extension-template");
const stage = join(root, "extension-build");
const zipOut = join(dist, "anical-extension.zip");

async function ensure(p, label) {
  try { await access(p); } catch { throw new Error(`Missing ${label}: ${p}. Run "npm run build" first.`); }
}

async function main() {
  await ensure(dist, "dist/");
  await ensure(join(dist, "index.html"), "dist/index.html");
  await ensure(tmpl, "extension-template/");

  // Clean staging dir
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  // Copy built SPA into staging
  await cp(dist, stage, {
    recursive: true,
    filter: (src) => !src.endsWith("anical-extension.zip"),
  });

  // Layer extension-specific files on top
  await cp(tmpl, stage, { recursive: true });

  // Pick the icon source: prefer extension-template/icon.png, fall back to
  // public/icon-512.png if the template doesn't ship one.
  const iconCandidates = [
    join(tmpl, "icon.png"),
    join(root, "extension", "icon.png"),
    join(root, "public", "icon-512.png"),
  ];
  let iconSrc = null;
  for (const c of iconCandidates) {
    if (existsSync(c)) { iconSrc = c; break; }
  }
  if (!iconSrc) throw new Error("No icon found (looked in extension-template, extension, public/icon-512.png)");
  await copyFile(iconSrc, join(stage, "icon.png"));

  // Inject popup-size constraints into index.html so the extension popup
  // renders at the right dimensions.
  const indexPath = join(stage, "index.html");
  let html = await readFile(indexPath, "utf8");
  const popupStyle = `<style>html,body{width:420px;height:600px;margin:0;overflow-x:hidden;background:#0d0d12}</style>`;
  if (!html.includes("__anical_popup_style__")) {
    html = html.replace("</head>", `${popupStyle}<!-- __anical_popup_style__ --></head>`);
  }
  await writeFile(indexPath, html, "utf8");

  // Zip up the staging dir → dist/anical-extension.zip
  await rm(zipOut, { force: true });
  if (platform() === "win32") {
    // PowerShell's Compress-Archive: simplest cross-version Windows zip tool.
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile", "-NonInteractive", "-Command",
        `Compress-Archive -Path "${stage}\\*" -DestinationPath "${zipOut}" -Force`,
      ],
      { stdio: "inherit" },
    );
  } else {
    // POSIX: assume zip is installed
    execFileSync("zip", ["-r", "-q", zipOut, "."], { cwd: stage, stdio: "inherit" });
  }

  // Mirror to public/ so plain `npm run build` (no build:ext) still ships a
  // recent zip — vite copies public/* into the next dist/ build.
  await copyFile(zipOut, join(root, "public", "anical-extension.zip"));

  console.log(`✓ Built extension: ${zipOut}`);
}

main().catch((e) => {
  console.error("✗ Extension build failed:", e.message);
  process.exit(1);
});
