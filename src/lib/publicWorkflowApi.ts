import { awsApiBaseUrl, isAwsStaging } from "@/lib/awsStaging";

const AWS_BUILD = import.meta.env.MODE === "aws";
let PRODUCTION_SUPABASE_URL: string | null = null;
let PRODUCTION_ANON_FALLBACK: string | null = null;

// AWS builds must never embed production Supabase endpoints or credentials.
if (!AWS_BUILD) {
  PRODUCTION_SUPABASE_URL = "https://nbcqwpysqgyxrrbgtmkw.supabase.co";
  PRODUCTION_ANON_FALLBACK =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iY3F3cHlzcWd5eHJyYmd0bWt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNDQ2NTgsImV4cCI6MjA5MjcyMDY1OH0.9GNh6OK6l6vSIBgkDY-bJuqNtfHJsLNW-dc7jfRUwgw";
}

const ROUTES = {
  "get-signature-document": {
    aws: "/public/signature-document",
    supabase: "/functions/v1/get-signature-document",
  },
  "submit-signature": {
    aws: "/public/signature-submit",
    supabase: "/functions/v1/submit-signature",
  },
  "check-endorsement": {
    aws: "/public/endorsement",
    supabase: "/functions/v1/check-endorsement",
  },
} as const;

export type PublicWorkflowName = keyof typeof ROUTES;

/**
 * Production Sign/Endorse keep the same Supabase URL + anon fallback.
 * AWS staging never falls back to production Storage or edge functions.
 */
export function publicWorkflowRequest(name: PublicWorkflowName) {
  if (AWS_BUILD || isAwsStaging()) {
    return {
      url: `${awsApiBaseUrl()}${ROUTES[name].aws}`,
      headers: { "Content-Type": "application/json" } as Record<string, string>,
    };
  }
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || PRODUCTION_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || PRODUCTION_ANON_FALLBACK;
  return {
    url: `${supabaseUrl}${ROUTES[name].supabase}`,
    headers: {
      "Content-Type": "application/json",
      apikey: anonKey,
    } as Record<string, string>,
  };
}
