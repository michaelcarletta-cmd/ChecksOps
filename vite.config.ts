import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // Bracket access — esbuild define can strip process.env.VITE_* member reads
  // while bundling vite.config.ts.
  const fromProcess = (key: string) => String(process.env[key] || "").trim();
  const authProvider = String(
    fromProcess("VITE_AUTH_PROVIDER") || env.VITE_AUTH_PROVIDER || (mode === "aws" ? "cognito" : ""),
  ).toLowerCase();
  const awsMode = mode === "aws" || authProvider === "cognito";
  // Prefer process.env so production-spa deploy injection wins over leftover .env files.
  // Do not default pool/client to production IDs — staging aws builds supply their own.
  const cognitoPoolId = fromProcess("VITE_COGNITO_USER_POOL_ID") || env.VITE_COGNITO_USER_POOL_ID || "";
  const cognitoClientId =
    fromProcess("VITE_COGNITO_USER_POOL_CLIENT_ID") || env.VITE_COGNITO_USER_POOL_CLIENT_ID || "";
  const checksopsApiUrl = fromProcess("VITE_CHECKSOPS_API_URL") || env.VITE_CHECKSOPS_API_URL || "";
  const appUrl = fromProcess("VITE_APP_URL") || env.VITE_APP_URL || "";
  const awsRegion = fromProcess("VITE_AWS_REGION") || env.VITE_AWS_REGION || (awsMode ? "us-east-1" : "");
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
        // Never bake production Supabase URL/keys into the AWS bundle.
        "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(""),
        "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(""),
        // Only define Cognito/API keys when present so empty strings cannot
        // override Vite's later loadEnv(.env.aws*) injection.
        ...(authProvider ? { "import.meta.env.VITE_AUTH_PROVIDER": JSON.stringify(authProvider) } : {}),
        ...(checksopsApiUrl ? { "import.meta.env.VITE_CHECKSOPS_API_URL": JSON.stringify(checksopsApiUrl) } : {}),
        ...(appUrl ? { "import.meta.env.VITE_APP_URL": JSON.stringify(appUrl) } : {}),
        ...(awsRegion ? { "import.meta.env.VITE_AWS_REGION": JSON.stringify(awsRegion) } : {}),
        ...(cognitoPoolId ? { "import.meta.env.VITE_COGNITO_USER_POOL_ID": JSON.stringify(cognitoPoolId) } : {}),
        ...(cognitoClientId ? { "import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID": JSON.stringify(cognitoClientId) } : {}),
      }
    : {
        "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(supabaseUrl),
        "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(supabasePublishableKey),
      },
  };
});
