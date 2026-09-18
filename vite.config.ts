import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const awsMode = mode === "aws" || String(env.VITE_AUTH_PROVIDER || "").toLowerCase() === "cognito";
  const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabasePublishableKey =
    env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    env.SUPABASE_PUBLISHABLE_KEY ||
    env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY;

  const vercelEnv = String(process.env.VERCEL_ENV || "").trim() || null;
  const isVercelPreview = vercelEnv === "preview";
  const previewBuildInfo = {
    isVercelPreview,
    vercelEnv,
    vercelUrl: (isVercelPreview ? String(process.env.VERCEL_URL || "").trim() : "") || null,
    gitCommitSha: (isVercelPreview ? String(process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || "").trim() : "") || null,
    gitPrNumber: (isVercelPreview ? String(process.env.VERCEL_GIT_PULL_REQUEST_ID || "").trim() : "") || null,
    viteAppUrl: (isVercelPreview ? String(env.VITE_APP_URL || "").trim() : "") || null,
    viteAuthProvider: (isVercelPreview ? String(env.VITE_AUTH_PROVIDER || "").trim() : "") || null,
    viteChecksopsApiUrl: (isVercelPreview ? String(env.VITE_CHECKSOPS_API_URL || "").trim() : "") || null,
  };

  return {
  server: {
    host: "::",
    port: 8080,
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
  },
  plugins: [
    react(),
    !awsMode && mode === "development" && componentTagger(),
    !awsMode && VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      workbox: {
        navigateFallbackDenylist: [/^\/~oauth/],
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/rest\/v1\/.*/i,
            handler: "NetworkFirst",
            options: {
              cacheName: "supabase-api-cache",
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [0, 200] },
              networkTimeoutSeconds: 5,
            },
          },
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/storage\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "supabase-storage-cache",
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/api\.fontshare\.com\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "font-cache",
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: "Freedom Claims CRM",
        short_name: "Freedom CRM",
        description: "Property Claims Management System — works offline",
        theme_color: "#0f172a",
        background_color: "#0f172a",
        display: "standalone",
        scope: "/",
        start_url: "/",
        icons: [
          { src: "/pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512.png", sizes: "512x512", type: "image/png" },
          { src: "/pwa-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  define: awsMode
    ? {
        // Never bake production Supabase URL/keys into the AWS staging bundle.
        "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(""),
        "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(""),
        __CHECKSOPS_PREVIEW_BUILD_INFO__: JSON.stringify(previewBuildInfo),
      }
    : {
        "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(supabaseUrl),
        "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(supabasePublishableKey),
        __CHECKSOPS_PREVIEW_BUILD_INFO__: JSON.stringify(previewBuildInfo),
      },
  };
});
