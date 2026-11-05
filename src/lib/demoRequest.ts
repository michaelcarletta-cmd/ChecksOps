import { awsApiBaseUrl, isAwsStaging } from "@/lib/awsStaging";
import { supabase } from "@/integrations/supabase/client";

export const DEMO_REQUEST_RECIPIENT = "support@checksops.com";

export type DemoRequestForm = {
  name: string;
  email: string;
  company: string;
  role: string;
  notes: string;
  /** Honeypot: hidden from people, filled in by form-spam bots. */
  website?: string;
};

export type DemoRequestResult = { ok: boolean; status?: number; error?: string };

const AWS_BUILD = import.meta.env.MODE === "aws";

/**
 * Sends the marketing "Request demo" form to support@checksops.com.
 * AWS builds (checksops.com) post to the public, unauthenticated /functions/v1/demo-request route:
 * marketing visitors are not signed in, so the identity-bound send-transactional-email route
 * answers 401 for them.
 */
export async function submitDemoRequest(
  form: DemoRequestForm,
  fetchImpl: typeof fetch = fetch,
): Promise<DemoRequestResult> {
  if (AWS_BUILD || isAwsStaging()) {
    try {
      const response = await fetchImpl(`${awsApiBaseUrl()}/functions/v1/demo-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      let body: Record<string, unknown> = {};
      try {
        body = await response.json();
      } catch {
        body = {};
      }
      if (response.ok && body.success !== false) return { ok: true };
      return { ok: false, status: response.status, error: String(body.error || "demo_request_failed") };
    } catch (err) {
      return { ok: false, status: 0, error: String((err as Error)?.message || err) };
    }
  }

  const { error } = await supabase.functions.invoke("send-transactional-email", {
    body: {
      templateName: "demo-request",
      recipientEmail: DEMO_REQUEST_RECIPIENT,
      idempotencyKey: `demo-request-${form.email}-${Date.now()}`,
      templateData: {
        name: form.name,
        email: form.email,
        company: form.company,
        role: form.role,
        notes: form.notes,
      },
    },
  });
  if (error) return { ok: false, status: 0, error: error.message };
  return { ok: true };
}
