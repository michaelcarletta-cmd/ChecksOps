import {
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
} from "@supabase/supabase-js";

export interface FunctionErrorDetails {
  message: string;
  status?: number;
  payload?: unknown;
  violations?: string[];
  scenarioDiagnostics?: Record<string, unknown> | null;
}

const SENSITIVE_ERROR = /\b(access_token|token_hash|refresh_token|id_token|password|secret|authorization|bearer)\b/i;
const STACK_TRACE = /\n\s*at\s+/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function publicFunctionErrorText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  if (SENSITIVE_ERROR.test(text) || STACK_TRACE.test(text)) return null;
  return text.slice(0, 240);
}

function messageFromPayload(payload: unknown): string | null {
  const payloadObject = isRecord(payload) ? payload : null;
  const payloadText = typeof payload === "string" ? payload : null;
  const detailsObject = payloadObject?.details && isRecord(payloadObject.details)
    ? payloadObject.details
    : null;
  return publicFunctionErrorText(detailsObject?.emailError)
    || publicFunctionErrorText(payloadObject?.error)
    || publicFunctionErrorText(payloadObject?.message)
    || publicFunctionErrorText(payloadObject?.details)
    || publicFunctionErrorText(payloadText);
}

function awsAdapterFunctionError(error: unknown): { message: string | null; status?: number; payload?: unknown } | null {
  if (!isRecord(error) || error instanceof Error) return null;
  const context = isRecord(error.context) ? error.context : null;
  if (error.name !== "FunctionsHttpError" && !context) return null;
  const payload = context && "body" in context ? context.body : null;
  const status = typeof context?.status === "number" ? context.status : undefined;
  return {
    message: messageFromPayload(payload) || publicFunctionErrorText(error.message),
    status,
    payload: isRecord(payload) ? payload : payload,
  };
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
  if (error instanceof FunctionsHttpError) {
    const response = error.context;
    const payload = await parseFunctionErrorPayload(response);

    const payloadObject = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
    const message = messageFromPayload(payload)
      || `${fallback} (HTTP ${response.status})`;

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

  const adapter = awsAdapterFunctionError(error);
  if (adapter) {
    return {
      message: adapter.message || (adapter.status ? `${fallback} (HTTP ${adapter.status})` : fallback),
      status: adapter.status,
      payload: adapter.payload,
    };
  }

  if (error instanceof FunctionsRelayError || error instanceof FunctionsFetchError) {
    return { message: error.message || fallback };
  }

  if (error instanceof Error) {
    return { message: publicFunctionErrorText(error.message) || fallback };
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
