import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import fs from "node:fs";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";

const parseEnvFile = (filePath: string) => {
  if (!fs.existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  for (const raw of fs.readFileSync(filePath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
};

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const awsFileEnv = mode === "aws" ? parseEnvFile(path.resolve(__dirname, ".env.aws")) : {};
  const awsMode = mode === "aws" || String(env.VITE_AUTH_PROVIDER || "").toLowerCase() === "cognito";
  const awsEnv = { ...env, ...awsFileEnv };
  if (mode === "aws") {
    const apiUrl = String(awsEnv.VITE_CHECKSOPS_API_URL || "");
    const poolId = String(awsEnv.VITE_COGNITO_USER_POOL_ID || "");
    if (!apiUrl.includes("psr19uhop4") || apiUrl.endsWith("/prep") || poolId.startsWith("us-east-1_h00WorYMT")) {
      throw new Error("AWS staging build refused inherited production /prep or production Cognito ids. Use .env.aws.");
    }
  }
  const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabasePublishableKey =
    env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    env.SUPABASE_PUBLISHABLE_KEY ||
    env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY;

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
        "import.meta.env.VITE_AUTH_PROVIDER": JSON.stringify(awsEnv.VITE_AUTH_PROVIDER || "cognito"),
        "import.meta.env.VITE_APP_URL": JSON.stringify(awsEnv.VITE_APP_URL || "https://staging.checksops.com"),
        "import.meta.env.VITE_CHECKSOPS_API_URL": JSON.stringify(awsEnv.VITE_CHECKSOPS_API_URL || ""),
        "import.meta.env.VITE_COGNITO_USER_POOL_ID": JSON.stringify(awsEnv.VITE_COGNITO_USER_POOL_ID || ""),
        "import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID": JSON.stringify(awsEnv.VITE_COGNITO_USER_POOL_CLIENT_ID || ""),
        "import.meta.env.VITE_AWS_REGION": JSON.stringify(awsEnv.VITE_AWS_REGION || "us-east-1"),
      }
    : {
        "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(supabaseUrl),
        "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(supabasePublishableKey),
      },
  };
});
