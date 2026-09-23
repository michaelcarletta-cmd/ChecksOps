/**
 * Function-invoke error classes used by the AWS client and UI helpers.
 * Names match the previous SDK errors so existing instanceof / name checks keep working.
 */

export class FunctionsHttpError extends Error {
  name = "FunctionsHttpError";
  context: { status?: number; body?: unknown } | Response;

  constructor(message: string, context: { status?: number; body?: unknown } | Response = {}) {
    super(message);
    this.context = context;
  }
}

export class FunctionsRelayError extends Error {
  name = "FunctionsRelayError";
}

export class FunctionsFetchError extends Error {
  name = "FunctionsFetchError";
}

export function isFunctionsHttpError(error: unknown): error is FunctionsHttpError {
  return Boolean(
    error
    && typeof error === "object"
    && (error instanceof FunctionsHttpError || (error as { name?: string }).name === "FunctionsHttpError"),
  );
}
