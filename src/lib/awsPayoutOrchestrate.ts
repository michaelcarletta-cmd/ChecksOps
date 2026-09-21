/**
 * AWS ChecksOps path for the normal payment orchestrator.
 * Never calls Lovable/Supabase money movers (calculate-payment-funding,
 * initiate-wallet-funding, moov-disburse) from the production payment UI.
 */
import { isAwsStaging, awsApiBaseUrl } from "@/lib/awsStaging";

const AWS_SESSION_KEY = "checksops.aws.staging.auth";
const LEGACY_HOST = /supabase\.co|lovable|nbcqwpysqgyxrrbgtmkw/i;

const readIdToken = (): string | null => {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(AWS_SESSION_KEY);
    if (!raw) return null;
    const idToken = JSON.parse(raw)?.tokens?.idToken;
    return typeof idToken === "string" && idToken ? idToken : null;
  } catch {
    return null;
  }
};

export const awsPayoutOrchestrateReady = (): boolean => {
  if (!isAwsStaging()) return false;
  const base = String(awsApiBaseUrl() || "").trim();
  return Boolean(base) && !LEGACY_HOST.test(base);
};

export async function invokeAwsPayoutOrchestrate(
  body: Record<string, unknown>,
  deps: { fetchImpl?: typeof fetch; idToken?: string | null; apiBaseUrl?: string } = {},
): Promise<{ data: Record<string, unknown> | null; error: Error | null }> {
  const base = String(deps.apiBaseUrl || awsApiBaseUrl() || "").replace(/\/$/, "");
  if (!base || LEGACY_HOST.test(base)) {
    return { data: null, error: new Error("legacy_payout_path_blocked") };
  }
  const token = deps.idToken !== undefined ? deps.idToken : readIdToken();
  if (!token) return { data: null, error: new Error("not_authenticated") };
  try {
    const response = await (deps.fetchImpl || fetch)(`${base}/functions/v1/moov-payout-orchestrate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...body,
        workflow: "payment",
        persist_money_intents: false,
        persist: false,
        post: false,
        submit: false,
        execute: false,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false) {
      return {
        data: payload && typeof payload === "object" ? payload : null,
        error: new Error(String(payload?.message || payload?.error || "Payment plan failed")),
      };
    }
    return { data: payload, error: null };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error : new Error(String(error)) };
  }
}
