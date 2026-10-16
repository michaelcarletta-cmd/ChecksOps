import { supabase } from "@/integrations/supabase/client";
import type { FinancialStepUpRequest } from "@/lib/financialStepUp";

/** Server step-up action for resetting a teammate's two-factor (admin-reset-totp). */
export const TEAM_RESET_TOTP_ACTION = "team.reset_totp";

type Reply = { success?: boolean; error?: unknown; message?: unknown } | null;

const readReply = async (data: unknown, error: unknown): Promise<Reply> => {
  if (!error) return (data as Reply) ?? null;
  // Supabase puts a Response on `context`; AWS puts the parsed reply on `context.body` (and `data`).
  const context = (error as { context?: { body?: unknown; json?: () => Promise<Reply> } }).context;
  if (typeof context?.json === "function") {
    try {
      return await context.json();
    } catch {
      /* fall through */
    }
  }
  if (context?.body && typeof context.body === "object") return context.body as Reply;
  return (data as Reply) ?? null;
};

/**
 * Resets a teammate's two-factor. The server asks for the caller's own recent
 * two-factor code for this login (`totp_required`); the caller confirms it
 * through the step-up dialog and the reset is retried once.
 */
export async function resetTeammateTotp(input: {
  userId: string;
  tenantId: string | null | undefined;
  requireStepUp: (request: FinancialStepUpRequest, options?: { force?: boolean }) => Promise<boolean>;
}) {
  const send = async () => {
    const { data, error } = await supabase.functions.invoke("admin-reset-totp", {
      body: { user_id: input.userId },
    });
    const reply = await readReply(data, error);
    return { reply, failed: Boolean(error) || !reply?.success };
  };
  let { reply, failed } = await send();
  if (failed && reply?.error === "totp_required") {
    if (!input.tenantId) throw new Error("Organization isn't loaded yet. Try again in a moment.");
    const ok = await input.requireStepUp(
      {
        actionKey: TEAM_RESET_TOTP_ACTION,
        checkId: null,
        tenantId: input.tenantId,
        title: "Confirm with two-factor",
        description: "Enter the 6-digit code from your own authenticator app to reset a teammate's two-factor.",
      },
      { force: true },
    );
    if (!ok) throw new Error("Two-factor confirmation is required to reset a teammate's two-factor.");
    ({ reply, failed } = await send());
  }
  if (failed) {
    const message = typeof reply?.message === "string" && reply.message
      ? reply.message
      : typeof reply?.error === "string" ? reply.error : "Two-factor reset failed";
    throw new Error(message);
  }
  return reply;
}
