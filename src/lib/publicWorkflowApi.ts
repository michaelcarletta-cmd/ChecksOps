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
 * AWS/Cognito builds use same-origin /prep public routes only.
 * Non-AWS builds may use env-provided Supabase URLs; this module does not
 * hardcode a production Supabase host (guarded SPA scanner forbids it).
 */
export function publicWorkflowRequest(name: PublicWorkflowName) {
  if (isAwsStaging()) {
    return {
      url: `${awsApiBaseUrl()}${ROUTES[name].aws}`,
      headers: { "Content-Type": "application/json" } as Record<string, string>,
    };
  }
  const supabaseUrl = String(import.meta.env.VITE_SUPABASE_URL || "");
  const anonKey = String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "");
  return {
    url: `${supabaseUrl}${ROUTES[name].supabase}`,
    headers: {
      "Content-Type": "application/json",
      apikey: anonKey,
    } as Record<string, string>,
  };
}
