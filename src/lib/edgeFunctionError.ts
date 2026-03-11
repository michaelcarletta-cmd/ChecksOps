import {
  FunctionsFetchError,
  FunctionsHttpError,
  FunctionsRelayError,
} from "@supabase/supabase-js";

export async function getFunctionErrorMessage(
  error: unknown,
  fallback = "Request failed",
): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    const response = error.context;

    try {
      const json = await response.json();
      if (typeof json?.error === "string") return json.error;
      if (typeof json?.message === "string") return json.message;
      if (typeof json?.details === "string") return json.details;
    } catch {
      // Ignore JSON parse failure and try text fallback
    }

    try {
      const text = await response.text();
      if (text) return text;
    } catch {
      // ignore
    }

    return `${fallback} (HTTP ${response.status})`;
  }

  if (error instanceof FunctionsRelayError || error instanceof FunctionsFetchError) {
    return error.message || fallback;
  }

  if (error instanceof Error) {
    return error.message || fallback;
  }

  return fallback;
}
