/**
 * One-click Deposit orchestration.
 *
 * Deposit → auto image prep / fingerprint bind → #203 eligibility → TOTP → submit.
 * Never contacts CheckAlt during preflight. Holds stay fail-closed on submit.
 */

import {
  CHECKALT_PROVIDER_UNAVAILABLE,
  checkAltProviderUserMessage,
  invokeAwsCheckAltProviderFunction,
  requireAwsCheckAltProviderPath,
} from "./awsCheckAltMoneyPath.ts";
import {
  buildFinancialStepUpRequest,
  type FinancialStepUpRequest,
} from "./financialStepUp.ts";

export type DepositPhase =
  | "idle"
  | "preparing"
  | "verifying_endorsements"
  | "awaiting_verification"
  | "submitting"
  | "done"
  | "failed";

export const DEPOSIT_PHASE_LABEL: Record<DepositPhase, string> = {
  idle: "Deposit",
  preparing: "Preparing check for deposit…",
  verifying_endorsements: "Verifying endorsements…",
  awaiting_verification: "Deposit Verification",
  submitting: "Submitting…",
  done: "Deposit",
  failed: "Deposit",
};

const AWS_SESSION_KEY = "checksops.aws.staging.auth";
const inFlight = new Set<string>();

export type DepositPreflightResult = {
  ok: boolean;
  readyForVerification?: boolean;
  needFrontPrep?: boolean;
  needRearPrep?: boolean;
  historicalReference?: boolean;
  attention?: "front" | "back" | "endorsement" | null;
  message?: string;
  error?: string;
  liveProviderCalled?: boolean;
  providerHttpAttempted?: boolean;
};

export type DepositClickResult = {
  ok: boolean;
  phase: DepositPhase;
  prepared: boolean;
  verified: boolean;
  submitted: boolean;
  held: boolean;
  historicalReference: boolean;
  providerHttp: false;
  error?: string;
  message?: string;
  attention?: "front" | "back" | "endorsement" | null;
};

const readIdToken = (sessionKey = AWS_SESSION_KEY): string | null => {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(sessionKey);
    if (!raw) return null;
    const idToken = JSON.parse(raw)?.tokens?.idToken;
    return typeof idToken === "string" && idToken ? idToken : null;
  } catch {
    return null;
  }
};

const userFacingPrepFailure = (attention: DepositClickResult["attention"]) => {
  if (attention === "front") return "Check image preparation failed. Please retake the front image.";
  if (attention === "back") return "Check image preparation failed. Please retake the back image.";
  if (attention === "endorsement") return "Endorsement is incomplete. A required payee has not signed.";
  return "Check image preparation failed. Please retake the front or back image.";
};

export async function fetchCheckAltDepositPreflight(
  checkId: string,
  deps: {
    apiBaseUrl?: string;
    idToken?: string | null;
    fetchImpl?: typeof fetch;
    preflight?: (checkId: string) => Promise<DepositPreflightResult>;
  } = {},
): Promise<DepositPreflightResult> {
  if (deps.preflight) return deps.preflight(checkId);
  const { awsApiBaseUrl } = await import("./awsStaging.ts");
  const base = String(deps.apiBaseUrl || awsApiBaseUrl() || "").replace(/\/$/, "");
  const token = deps.idToken !== undefined ? deps.idToken : readIdToken();
  if (!base || !token) {
    return { ok: false, error: "not_authenticated", message: "Sign in again to deposit this check." };
  }
  const response = await (deps.fetchImpl || fetch)(`${base}/functions/v1/checkalt-deposit-preflight`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ check_intake_item_id: checkId }),
  });
  const body = await response.json().catch(() => ({}));
  return {
    ok: body?.ok === true,
    readyForVerification: body?.readyForVerification === true,
    needFrontPrep: body?.needFrontPrep === true,
    needRearPrep: body?.needRearPrep === true,
    historicalReference: body?.historicalReference === true,
    attention: body?.attention || null,
    message: body?.message || body?.error || undefined,
    error: body?.error || undefined,
    liveProviderCalled: false,
    providerHttpAttempted: false,
  };
}

export async function runCheckAltDepositClick(
  checkId: string,
  deps: {
    apiBaseUrl?: string;
    authProvider?: string;
    idToken?: string | null;
    fetchImpl?: typeof fetch;
    onPhase?: (phase: DepositPhase) => void;
    requireStepUp: (request: FinancialStepUpRequest) => Promise<boolean>;
    prepareCheckAltDeposit?: (
      checkId: string,
      options?: { forceFront?: boolean; forceRear?: boolean },
    ) => Promise<{ deposit_front_path: string; deposit_back_path: string }>;
    preflight?: (checkId: string) => Promise<DepositPreflightResult>;
    submit?: (checkId: string) => Promise<{ error: Error | null; data?: unknown }>;
  },
): Promise<DepositClickResult> {
  const fail = (
    message: string,
    extra: Partial<DepositClickResult> = {},
  ): DepositClickResult => ({
    ok: false,
    phase: "failed",
    prepared: extra.prepared === true,
    verified: extra.verified === true,
    submitted: false,
    held: extra.held === true,
    historicalReference: extra.historicalReference === true,
    providerHttp: false,
    error: extra.error,
    message,
    attention: extra.attention ?? null,
  });

  if (!checkId) return fail("This deposit is missing a check.");
  if (inFlight.has(checkId)) {
    return fail("This deposit is already in progress.", { error: "deposit_in_progress" });
  }
  inFlight.add(checkId);
  const phase = (next: DepositPhase) => deps.onPhase?.(next);

  try {
    requireAwsCheckAltProviderPath({
      authProvider: deps.authProvider,
      apiBaseUrl: deps.apiBaseUrl,
      functionName: "checkalt-submit-deposit",
    });

    phase("preparing");
    let preflight = await fetchCheckAltDepositPreflight(checkId, deps);
    if (preflight.liveProviderCalled || preflight.providerHttpAttempted) {
      return fail("Deposit preflight refused to contact the provider.", { error: "provider_http_blocked" });
    }

    if (!preflight.ok && (preflight.needFrontPrep || preflight.needRearPrep)) {
      try {
        const prepare = deps.prepareCheckAltDeposit
          || (await import("./prepareCheckAltDeposit.ts")).prepareCheckAltDeposit;
        await prepare(checkId, {
          forceFront: preflight.needFrontPrep === true,
          forceRear: preflight.needRearPrep === true,
        });
      } catch {
        return fail(userFacingPrepFailure(preflight.attention), {
          attention: preflight.attention,
          error: "image_prep_failed",
        });
      }
      phase("verifying_endorsements");
      preflight = await fetchCheckAltDepositPreflight(checkId, deps);
    } else {
      phase("verifying_endorsements");
    }

    if (!preflight.ok || !preflight.readyForVerification) {
      return fail(preflight.message || userFacingPrepFailure(preflight.attention), {
        prepared: true,
        attention: preflight.attention,
        error: preflight.error,
        historicalReference: preflight.historicalReference === true,
      });
    }

    phase("awaiting_verification");
    const built = buildFinancialStepUpRequest({
      actionKey: "deposit.submit",
      checkId,
      title: "Deposit Verification",
      description: "Enter the current 6-digit code from your authenticator app to authorize this deposit.",
    });
    if (!built.ok) {
      const b = built as { message?: string; error?: string };
      return fail(b.message ?? "Two-factor verification is required.", { prepared: true, error: b.error });
    }
    const verified = await deps.requireStepUp(built.request);
    if (!verified) {
      return fail("Two-factor verification is required before money can move.", {
        prepared: true,
        error: "totp_required",
      });
    }

    phase("submitting");
    const submit = deps.submit || (async (id: string) => invokeAwsCheckAltProviderFunction(
      "checkalt-submit-deposit",
      { body: { check_intake_item_id: id } },
      {
        authProvider: deps.authProvider,
        apiBaseUrl: deps.apiBaseUrl,
        idToken: deps.idToken,
        fetchImpl: deps.fetchImpl,
      },
    ));
    const submitted = await submit(checkId);
    if (submitted.error) {
      const mapped = checkAltProviderUserMessage(submitted.error);
      const held = /provider_disabled|production_execution_blocked|Provider not enabled/i.test(
        String(submitted.error.message || mapped),
      );
      if (held) {
        phase("done");
        return {
          ok: true,
          phase: "done",
          prepared: true,
          verified: true,
          submitted: false,
          held: true,
          historicalReference: preflight.historicalReference === true,
          providerHttp: false,
          error: "provider_disabled",
          message: CHECKALT_PROVIDER_UNAVAILABLE,
        };
      }
      return fail(mapped, {
        prepared: true,
        verified: true,
        historicalReference: preflight.historicalReference === true,
        error: submitted.error.message,
      });
    }

    phase("done");
    return {
      ok: true,
      phase: "done",
      prepared: true,
      verified: true,
      submitted: true,
      held: false,
      historicalReference: preflight.historicalReference === true,
      providerHttp: false,
    };
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Deposit failed.", {
      error: error instanceof Error ? error.message : "deposit_failed",
    });
  } finally {
    inFlight.delete(checkId);
  }
}

export const depositInFlight = (checkId: string) => inFlight.has(checkId);

export const resetDepositInFlightForTests = () => inFlight.clear();
