import { supabase } from "@/integrations/supabase/client";

/** Single client entry for administrative status correction (not a normal transition). */
export const ADMIN_OVERRIDE_CHECK_STATUS_RPC = "admin_override_check_status";

/** Single client entry for constrained administrative check delete. */
export const ADMIN_DELETE_CHECK_RPC = "admin_delete_check";

export async function adminOverrideCheckStatus(args: {
  checkId: string;
  newStatus: string;
  actorId?: string | null;
  reason?: string | null;
}) {
  const { data, error } = await supabase.rpc(ADMIN_OVERRIDE_CHECK_STATUS_RPC, {
    p_check_id: args.checkId,
    p_new_status: args.newStatus,
    p_actor_id: args.actorId ?? null,
    ...(args.reason ? { p_reason: args.reason } : {}),
  } as never);
  if (error) throw error;
  if (data && typeof data === "object" && (data as { ok?: boolean }).ok === false) {
    throw new Error((data as { error?: string }).error ?? "Override rejected");
  }
  return data;
}

export async function adminDeleteCheck(args: {
  checkId: string;
  actorId?: string | null;
  reason: string;
}) {
  const { data, error } = await supabase.rpc(ADMIN_DELETE_CHECK_RPC as never, {
    p_check_id: args.checkId,
    p_actor_id: args.actorId ?? null,
    p_reason: args.reason,
  } as never);
  if (error) throw error;
  return data;
}
