import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";

// ─── Tauri environment detection ─────────────────────────────────────────────
// When `tauri dev` runs it sets TAURI_ENV_TARGET_TRIPLE in the environment.
// We use this to tweak a few Vite settings so Tauri's WebView picks up the
// dev server correctly.
const isTauriBuild = Boolean(process.env["TAURI_ENV_TARGET_TRIPLE"]);

// ─── Static file middleware ───────────────────────────────────────────────────
// Vite's publicDir serves a single directory as static root. Since we need
// both /data/* and /assets/* to be served from the project root without
// copying gigabytes of assets into a public/ folder, we add a custom
// middleware that intercepts those routes and streams the files directly.

function staticDirsPlugin(): import("vite").Plugin {
  // Directories relative to the project root that should be served as-is.
  // "assets" covers both game assets (images/audio) and script data (data/).
  const STATIC_DIRS = ["assets"];

  return {
    name: "serve-static-dirs",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "/";
        // Strip query string
        const urlPath = url.split("?")[0].split("#")[0];

        // Check if this request is for one of our static dirs
        const matched = STATIC_DIRS.find(
          (dir) => urlPath === `/${dir}` || urlPath.startsWith(`/${dir}/`),
        );
        if (!matched) return next();

        // Build the absolute file path
        // URL-decode the path so that %20 → space etc. resolve to real filenames
        const relativePath = decodeURIComponent(urlPath.slice(1)); // remove leading /
        const filePath = path.resolve(__dirname, relativePath);

        // Security: ensure the resolved path is still under the project root
        const projectRoot = path.resolve(__dirname);
        if (
          !filePath.startsWith(projectRoot + path.sep) &&
          filePath !== projectRoot
        ) {
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }

        // Stat the file
        let stat: fs.Stats;
        try {
          stat = fs.statSync(filePath);
        } catch {
          res.statusCode = 404;
          res.end("Not Found");
          return;
        }

        if (stat.isDirectory()) {
          // Return a simple JSON directory listing (useful for debugging)
          try {
            const entries = fs.readdirSync(filePath).map((name) => {
              const full = path.join(filePath, name);
              const s = fs.statSync(full);
              return { name, isDir: s.isDirectory(), size: s.size };
            });
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(entries, null, 2));
          } catch {
            res.statusCode = 500;
            res.end("Internal Server Error");
          }
          return;
        }

        // Infer MIME type from extension
        const ext = path.extname(filePath).toLowerCase();
        const MIME: Record<string, string> = {
          ".json": "application/json",
          ".rrs": "text/plain; charset=utf-8",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".png": "image/png",
          ".webp": "image/webp",
          ".gif": "image/gif",
          ".webm": "video/webm",
          ".mp4": "video/mp4",
          ".ogg": "audio/ogg",
          ".mp3": "audio/mpeg",
          ".wav": "audio/wav",
          ".ttf": "font/ttf",
          ".otf": "font/otf",
          ".woff": "font/woff",
          ".woff2": "font/woff2",
          ".svg": "image/svg+xml",
          ".ico": "image/x-icon",
        };
        const mime = MIME[ext] ?? "application/octet-stream";

        // Read the file synchronously and send it in one shot.
        let buf: Buffer;
        try {
          buf = fs.readFileSync(filePath);
        } catch {
          res.statusCode = 500;
          res.end("Read error");
          return;
        }

        // Allow browsers to cache most static assets aggressively,
        // but never cache the manifest or script source files so that
        // updates are picked up immediately on reload.
        const noCache =
          ext === ".rrs" ||
          (ext === ".json" && path.basename(filePath) === "manifest.json");

        res.setHeader("Content-Type", mime);
        res.setHeader("Content-Length", buf.length);
        if (noCache) {
          // Use every available knob to prevent the Tauri WebView and browsers
          // from ever serving a stale version of the manifest or script files.
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
        } else {
          res.setHeader("Cache-Control", "public, max-age=3600");
        }
        res.end(buf);
      });
    },
  };
}

// ─── Vite config ──────────────────────────────────────────────────────────────

export default defineConfig({
  plugins: [react(), staticDirsPlugin()],

  // Tauri manages its own window; let Vite keep the terminal clean.
  clearScreen: isTauriBuild ? false : true,

  server: {
    port: 3000,
    // Don't auto-open a browser tab when running under Tauri — the WebView
    // will connect to this dev server automatically.
    open: isTauriBuild ? false : true,
    // Tauri needs to reach the dev server from the WebView process.
    strictPort: isTauriBuild,
    fs: {
      // Allow Vite's own file transforms to access files under the project root
      allow: [path.resolve(__dirname, ".")],
      strict: false,
    },
  },

  // Don't treat any directory as a static "public" dir — our middleware
  // handles /data and /assets; everything else is src/ code.
  publicDir: false,

  build: {
    outDir: "dist",
    // Tauri ships a release build to the WebView; source maps are helpful for
    // development but add size — keep them in dev, drop in release.
    sourcemap: isTauriBuild ? false : true,
    // Tauri's WebView supports modern JS natively; no need to polyfill.
    target: isTauriBuild ? ["chrome105", "safari13"] : "modules",
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom"],
          zustand: ["zustand"],
        },
      },
    },
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
