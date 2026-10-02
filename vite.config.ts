import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const awsMode = mode === "aws";
  const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabasePublishableKey =
    env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    env.SUPABASE_PUBLISHABLE_KEY ||
    env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY;

  if (awsMode) {
    const required = (key: string) => String(env[key] || process.env[key] || "").trim();
    const missing: string[] = [];
    const authProvider = required("VITE_AUTH_PROVIDER");
    if (authProvider.toLowerCase() !== "cognito") missing.push("VITE_AUTH_PROVIDER=cognito");
    const appUrl = required("VITE_APP_URL");
    if (!appUrl) missing.push("VITE_APP_URL");
    const apiUrl = required("VITE_CHECKSOPS_API_URL");
    if (!apiUrl) missing.push("VITE_CHECKSOPS_API_URL");
    const region = required("VITE_AWS_REGION");
    if (!region) missing.push("VITE_AWS_REGION");
    const poolId = required("VITE_COGNITO_USER_POOL_ID");
    if (!poolId) missing.push("VITE_COGNITO_USER_POOL_ID");
    const clientId = required("VITE_COGNITO_USER_POOL_CLIENT_ID");
    if (!clientId) missing.push("VITE_COGNITO_USER_POOL_CLIENT_ID");

    // Production AWS frontend uses same-origin `/prep`.
    try {
      const url = new URL(appUrl);
      const host = url.hostname.toLowerCase();
      const isProdChecksOps = host === "checksops.com" || host === "www.checksops.com";
      if (isProdChecksOps) {
        const token = apiUrl.trim().toLowerCase();
        const ok = token === "/prep" || token === "same-origin" || token === "same-origin:/prep";
        if (!ok) missing.push("VITE_CHECKSOPS_API_URL=/prep");
      }
    } catch {
      /* ignore */
    }

    // Supabase must never be present in an AWS/Cognito build.
    if (String(supabaseUrl || "").trim()) missing.push("VITE_SUPABASE_URL (must be unset in aws mode)");
    if (String(supabasePublishableKey || "").trim()) missing.push("VITE_SUPABASE_PUBLISHABLE_KEY (must be unset in aws mode)");

    if (missing.length) {
      throw new Error(
        `AWS frontend build misconfigured (mode=aws). Missing/invalid: ${missing.join(", ")}`,
      );
    }
  }

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
        // Never bake Supabase URL/keys into an AWS bundle.
        "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(""),
        "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(""),
      }
    : {
        "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(supabaseUrl),
        "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(supabasePublishableKey),
      },
  };
});
