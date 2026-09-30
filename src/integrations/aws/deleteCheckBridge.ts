export type AdminDeleteCheckRpcArgs = Record<string, unknown>;

export function buildWorkflowDeleteCheckBody(args: AdminDeleteCheckRpcArgs) {
  const checkId = String(args["p_check_id"] ?? args["check_id"] ?? "");
  const reasonRaw = args["p_reason"] ?? args["reason"] ?? args["delete_reason"] ?? null;
  const actorRaw = args["p_actor_id"] ?? args["actor_id"] ?? null;

  const reason = reasonRaw == null ? "" : String(reasonRaw).trim();
  const actor_id = actorRaw == null ? "" : String(actorRaw).trim();

  const body: Record<string, unknown> = { check_id: checkId };
  if (reason.length) body.reason = reason;
  if (actor_id.length) body.actor_id = actor_id;

  return { checkId, body };
}

