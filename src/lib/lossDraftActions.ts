/**
 * Loss Draft actions (loss_draft_action) shared by the Loss Draft Actions tab and the
 * check's Status Workflow card.
 *
 * Owner, 2026-11-09: "When I click monitored or not monitored on production side nothing
 * happens". The Actions tab returned silently when `useAuth().user?.id` was empty, so a click
 * could send nothing and say nothing. Here a click either sends the request or shows why it
 * did not, and every failure is shown.
 *
 * The API (aws/functions/api/workflow-rpc.mjs executeLossDraftAction) takes the actor from
 * the verified sign-in (mapping.application_user_id) and never reads p_actor_id; the client
 * still sends the signed-in user's id because the RPC's signature names it.
 *
 * No path alias imports: aws/tests load this file directly with node.
 */

export type LossDraftMonitoringType = "monitored" | "not_monitored";

export type LossDraftToast = (toast: {
  title: string;
  description?: string;
  variant?: "default" | "destructive";
}) => unknown;

export type LossDraftRpcResult = {
  data: unknown;
  error: { message?: string } | null;
};

export type LossDraftRpcClient = {
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<LossDraftRpcResult>;
};

export const LOSS_DRAFT_NO_IDENTITY_TITLE = "Not saved";
export const LOSS_DRAFT_NO_IDENTITY_MESSAGE =
  "Your sign-in could not be read, so nothing was saved. Sign out, sign in again and retry.";

/** A missing or unknown value counts as monitored (the column's default). */
export const monitoringTypeOf = (value: unknown): LossDraftMonitoringType =>
  value === "not_monitored" ? "not_monitored" : "monitored";

export const monitoringTypeLabel = (value: LossDraftMonitoringType): string =>
  value === "monitored" ? "Monitored" : "Not Monitored";

const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/**
 * The signed-in user's application id: the auth context's user first, then the stored AWS
 * session (the same value the login check reads, src/lib/awsMfa.ts awsAuthUserId).
 */
export const resolveLossDraftActorId = (
  user: { id?: unknown } | null | undefined,
  storedSessionUserId?: () => string | null | undefined,
): string | null => {
  const fromContext = nonEmpty(user?.id);
  if (fromContext) return fromContext;
  try {
    return nonEmpty(storedSessionUserId?.());
  } catch {
    return null;
  }
};

export type LossDraftActionInput = {
  lossDraftId: string;
  action: string;
  actorId: string | null;
  amount?: number | null;
  notes?: string | null;
  extra?: Record<string, unknown>;
};

/** ok: the API saved the action (data is its answer); otherwise reason and message say why not. */
export type LossDraftActionOutcome = {
  ok: boolean;
  data?: unknown;
  reason?: "no_identity" | "rpc_error";
  message?: string;
};

/** Sends one loss_draft_action. Never throws: a refusal or an exception is the outcome. */
export const runLossDraftAction = async (
  client: LossDraftRpcClient,
  input: LossDraftActionInput,
): Promise<LossDraftActionOutcome> => {
  if (!input.actorId) {
    return { ok: false, reason: "no_identity", message: LOSS_DRAFT_NO_IDENTITY_MESSAGE };
  }
  try {
    const { data, error } = await client.rpc("loss_draft_action", {
      p_loss_draft_id: input.lossDraftId,
      p_action: input.action,
      p_actor_id: input.actorId,
      p_amount: input.amount ?? null,
      p_notes: input.notes ?? null,
      p_extra: input.extra ?? {},
    });
    if (error) {
      return { ok: false, reason: "rpc_error", message: error.message || "The change was not saved." };
    }
    return { ok: true, data };
  } catch (e: unknown) {
    const message = e instanceof Error && e.message ? e.message : "The change was not saved.";
    return { ok: false, reason: "rpc_error", message };
  }
};

/** Shows the outcome of a failed action. */
export const toastLossDraftFailure = (
  toast: LossDraftToast,
  outcome: LossDraftActionOutcome,
) => {
  toast({
    title: outcome.reason === "no_identity" ? LOSS_DRAFT_NO_IDENTITY_TITLE : "Error",
    description: outcome.message,
    variant: "destructive",
  });
};

/** The record as saved, for the query cache until the refetch confirms it. */
export const withMonitoringType = <T extends Record<string, unknown> | null | undefined>(
  record: T,
  monitoringType: LossDraftMonitoringType,
): T => (record ? ({ ...record, monitoring_type: monitoringType } as T) : record);

/**
 * Monitored / Not Monitored: saves through set_monitoring_type and reports the outcome.
 * Picking the type already saved sends nothing and says so. Returns the saved type, or
 * null when nothing was saved.
 */
export const saveLossDraftMonitoringType = async ({
  client,
  toast,
  lossDraftId,
  actorId,
  current,
  next,
}: {
  client: LossDraftRpcClient;
  toast: LossDraftToast;
  lossDraftId: string;
  actorId: string | null;
  current: unknown;
  next: LossDraftMonitoringType;
}): Promise<LossDraftMonitoringType | null> => {
  if (monitoringTypeOf(current) === next) {
    toast({ title: `Already ${monitoringTypeLabel(next)}`, description: "Nothing to change." });
    return null;
  }
  const outcome = await runLossDraftAction(client, {
    lossDraftId,
    action: "set_monitoring_type",
    actorId,
    notes: `Changed to ${next}`,
    extra: { monitoring_type: next },
  });
  if (!outcome.ok) {
    toastLossDraftFailure(toast, outcome);
    return null;
  }
  toast({ title: "Monitoring type updated", description: `Set to ${monitoringTypeLabel(next)}` });
  return next;
};
