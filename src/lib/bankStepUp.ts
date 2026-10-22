/**
 * Bank-detail changes (connect a bank account, start or confirm
 * micro-deposits) need this login's two-factor confirmation: the server
 * answers 401 totp_required (handlers.mjs requireBankStepUp, action
 * wallet.fund, the same code that covers funding). Ask for the code once and
 * retry the same call, as funding and payments do.
 */

import type { FinancialStepUpRequest } from "@/lib/financialStepUp";

type InvokeResult = { data: unknown; error: unknown };

export const BANK_STEP_UP = {
  actionKey: "wallet.fund",
  checkId: null,
  title: "Confirm bank change",
  description: "Enter the 6-digit code from your authenticator app. You'll only be asked once until you sign out.",
};

/** The server's error code from a functions.invoke result, or null. */
export async function invokeErrorCode(result: InvokeResult): Promise<string | null> {
  const fromData = (result.data as { error?: unknown } | null)?.error;
  if (typeof fromData === "string") return fromData;
  if (!result.error) return null;
  // AWS puts the parsed reply on context.body; Supabase puts a Response on context.
  const context = (result.error as { context?: { body?: unknown; clone?: () => { json: () => Promise<unknown> } } }).context;
  let body: unknown = context?.body;
  if (body === undefined && typeof context?.clone === "function") {
    try { body = await context.clone().json(); } catch { body = undefined; }
  }
  const code = (body as { error?: unknown } | null)?.error;
  return typeof code === "string" ? code : null;
}

/** Run invoke; on totp_required ask for the code and run it once more. */
export async function invokeWithBankStepUp<R extends InvokeResult>(
  invoke: () => Promise<R>,
  requireStepUp: (request: FinancialStepUpRequest, options?: { force?: boolean }) => Promise<boolean>,
  tenantId: string | null,
): Promise<R> {
  const first = await invoke();
  if ((await invokeErrorCode(first)) !== "totp_required") return first;
  if (!(await requireStepUp({ ...BANK_STEP_UP, tenantId }, { force: true }))) {
    throw new Error("Cancelled. Two-factor confirmation is required to change bank details.");
  }
  return invoke();
}
