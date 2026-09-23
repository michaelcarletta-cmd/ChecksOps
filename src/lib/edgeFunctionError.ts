import {
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
  isFunctionsHttpError,
} from "@/integrations/aws/errors";

export interface FunctionErrorDetails {
  message: string;
  status?: number;
  payload?: unknown;
  violations?: string[];
  scenarioDiagnostics?: Record<string, unknown> | null;
}

async function parseFunctionErrorPayload(response: Response): Promise<unknown> {
  try {
    return await response.clone().json();
  } catch {
    // Fall through to plain text payload
  }

  try {
    const text = await response.clone().text();
    return text || null;
  } catch {
    return null;
  }
}

export async function getFunctionErrorDetails(
  error: unknown,
  fallback = "Request failed",
): Promise<FunctionErrorDetails> {
  if (isFunctionsHttpError(error)) {
    const response = error.context;
    const payload = await parseFunctionErrorPayload(response);

    const payloadObject = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
    const payloadText = typeof payload === "string" ? payload : null;
    const detailsObject = payloadObject?.details && typeof payloadObject.details === "object"
      ? payloadObject.details as Record<string, unknown>
      : null;

    const message =
      (typeof detailsObject?.emailError === "string" && detailsObject.emailError) ||
      (typeof payloadObject?.error === "string" && payloadObject.error) ||
      (typeof payloadObject?.message === "string" && payloadObject.message) ||
      (typeof payloadObject?.details === "string" && payloadObject.details) ||
      payloadText ||
      `${fallback} (HTTP ${response.status})`;

    const violations = Array.isArray(payloadObject?.violations)
      ? payloadObject.violations.filter((item): item is string => typeof item === "string")
      : [];

    const scenarioDiagnostics = payloadObject?.scenario_diagnostics && typeof payloadObject.scenario_diagnostics === "object"
      ? payloadObject.scenario_diagnostics as Record<string, unknown>
      : null;

    return {
      message,
      status: response.status,
      payload,
      violations,
      scenarioDiagnostics,
    };
  }

  if (error instanceof FunctionsRelayError || error instanceof FunctionsFetchError) {
    return { message: error.message || fallback };
  }

  if (error instanceof Error) {
    return { message: error.message || fallback };
  }

  return { message: fallback };
}

export async function getFunctionErrorMessage(
  error: unknown,
  fallback = "Request failed",
): Promise<string> {
  const details = await getFunctionErrorDetails(error, fallback);
  return details.message;
}
