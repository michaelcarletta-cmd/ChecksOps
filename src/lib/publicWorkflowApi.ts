import { awsApiBaseUrl } from "@/lib/awsStaging";

const ROUTES = {
  "get-signature-document": "/public/signature-document",
  "submit-signature": "/public/signature-submit",
  "check-endorsement": "/public/endorsement",
} as const;

export type PublicWorkflowName = keyof typeof ROUTES;

/**
 * Public Sign/Endorse always use the AWS /prep (or staging execute-api) handlers.
 * There is no hosted-Supabase fallback.
 */
export function publicWorkflowRequest(name: PublicWorkflowName) {
  return {
    url: `${awsApiBaseUrl()}${ROUTES[name]}`,
    headers: { "Content-Type": "application/json" } as Record<string, string>,
  };
}
