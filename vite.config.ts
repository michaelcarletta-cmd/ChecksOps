import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const vercelEnv = String(process.env.VERCEL_ENV || "").trim() || null;
  const isVercelPreview = vercelEnv === "preview";

  // Vercel Preview builds should use AWS staging auth + APIs so that passwordless login
  // stays on the preview hostname (Supabase magic-link redirects are allowlisted and will
  // fall back to the canonical Site URL when the preview hostname is not allowlisted).
  const awsModeFromEnv =
    mode === "aws" || String(env.VITE_AUTH_PROVIDER || "").toLowerCase() === "cognito";
  const awsMode = awsModeFromEnv || isVercelPreview;

  const previewAwsConfig = isVercelPreview
    ? {
        VITE_AUTH_PROVIDER: "cognito",
        VITE_AWS_REGION: String(env.VITE_AWS_REGION || "us-east-1"),
        VITE_APP_URL: String(env.VITE_APP_URL || "https://staging.checksops.com"),
        VITE_CHECKSOPS_API_URL: String(
          env.VITE_CHECKSOPS_API_URL || "https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging",
        ),
        VITE_COGNITO_USER_POOL_ID: String(env.VITE_COGNITO_USER_POOL_ID || "us-east-1_vPmQ7cL1F"),
        VITE_COGNITO_USER_POOL_CLIENT_ID: String(
          env.VITE_COGNITO_USER_POOL_CLIENT_ID || "71bb7a192cbl6o6s8m259tl589",
        ),
      }
    : null;

  const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabasePublishableKey =
    env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    env.SUPABASE_PUBLISHABLE_KEY ||
    env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY;

  const effectiveViteAuthProvider = isVercelPreview ? previewAwsConfig?.VITE_AUTH_PROVIDER : env.VITE_AUTH_PROVIDER;
  const effectiveViteAppUrl = isVercelPreview ? previewAwsConfig?.VITE_APP_URL : env.VITE_APP_URL;
  const effectiveViteChecksopsApiUrl = isVercelPreview ? previewAwsConfig?.VITE_CHECKSOPS_API_URL : env.VITE_CHECKSOPS_API_URL;
  const previewBuildInfo = {
    isVercelPreview,
    vercelEnv,
    vercelUrl: (isVercelPreview ? String(process.env.VERCEL_URL || "").trim() : "") || null,
    gitCommitSha: (isVercelPreview ? String(process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || "").trim() : "") || null,
    gitPrNumber: (isVercelPreview ? String(process.env.VERCEL_GIT_PULL_REQUEST_ID || "").trim() : "") || null,
    viteAppUrl: (isVercelPreview ? String(effectiveViteAppUrl || "").trim() : "") || null,
    viteAuthProvider: (isVercelPreview ? String(effectiveViteAuthProvider || "").trim() : "") || null,
    viteChecksopsApiUrl: (isVercelPreview ? String(effectiveViteChecksopsApiUrl || "").trim() : "") || null,
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
        ...(previewAwsConfig
          ? {
              "import.meta.env.VITE_AUTH_PROVIDER": JSON.stringify(previewAwsConfig.VITE_AUTH_PROVIDER),
              "import.meta.env.VITE_AWS_REGION": JSON.stringify(previewAwsConfig.VITE_AWS_REGION),
              "import.meta.env.VITE_APP_URL": JSON.stringify(previewAwsConfig.VITE_APP_URL),
              "import.meta.env.VITE_CHECKSOPS_API_URL": JSON.stringify(previewAwsConfig.VITE_CHECKSOPS_API_URL),
              "import.meta.env.VITE_COGNITO_USER_POOL_ID": JSON.stringify(previewAwsConfig.VITE_COGNITO_USER_POOL_ID),
              "import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID": JSON.stringify(previewAwsConfig.VITE_COGNITO_USER_POOL_CLIENT_ID),
            }
          : {}),
        __CHECKSOPS_PREVIEW_BUILD_INFO__: JSON.stringify(previewBuildInfo),
      }
    : {
        "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(supabaseUrl),
        "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(supabasePublishableKey),
        __CHECKSOPS_PREVIEW_BUILD_INFO__: JSON.stringify(previewBuildInfo),
      },
  };
});
