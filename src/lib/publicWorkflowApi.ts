import { awsApiBaseUrl, isAwsStaging } from "@/lib/awsStaging";

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
 * Cognito / production-aws Sign/Endorse call same-origin /prep/public/...
 * Leftover Lovable builds may still use env-configured Edge Function paths.
 * No hardcoded *.supabase.co host or anon-key fallback is compiled in.
 */
export function publicWorkflowRequest(name: PublicWorkflowName) {
  if (isAwsStaging()) {
    return {
      url: `${awsApiBaseUrl()}${ROUTES[name].aws}`,
      headers: { "Content-Type": "application/json" } as Record<string, string>,
    };
  }
  const supabaseUrl = String(import.meta.env.VITE_SUPABASE_URL || "").replace(/\/$/, "");
  const anonKey = String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "");
  return {
    url: `${supabaseUrl}${ROUTES[name].supabase}`,
    headers: {
      "Content-Type": "application/json",
      ...(anonKey ? { apikey: anonKey } : {}),
    } as Record<string, string>,
  };
}
