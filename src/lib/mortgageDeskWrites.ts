/**
 * Mortgage Desk writes that reach the tenant: messages on the check thread,
 * documents on the check, and the shipping / mail-to / sent-date details.
 *
 * On the AWS backend the Desk agent is not a member of the requesting tenant,
 * so it cannot insert check_messages or check_files or update those request
 * columns itself. There every write goes through the agent-gated RPCs
 * (aws/functions/api/mortgage-desk-return.mjs, SQL 122), which check on the
 * server that the caller is the agent assigned to the in-progress request and
 * take the check and tenant from the request row. The Supabase backend keeps
 * its direct writes.
 *
 * No "@/" imports: aws/tests load this file with --experimental-strip-types.
 */

export const MORTGAGE_DESK_FILE_SOURCE = "mortgage_ops";
export const MORTGAGE_DESK_NOTE_PREFIX = "📝 ChecksOps Mortgage Desk note: ";

export const MORTGAGE_DESK_RPC = Object.freeze({
  postMessage: "mortgage_desk_post_message",
  attachFile: "mortgage_desk_attach_file",
  updateShipping: "mortgage_desk_update_shipping",
  setMonitoring: "mortgage_desk_set_monitoring",
});

export type MortgageDeskFileCategory =
  | "mortgage_ops"
  | "mortgage_ops_signature"
  | "mortgage_ops_shipping_label";

export type MortgageDeskShippingFields = Partial<{
  mail_to_name: string | null;
  mail_to_address: string | null;
  shipping_label_carrier: string | null;
  shipping_label_tracking: string | null;
  shipping_label_name: string | null;
  shipping_label_path: string | null;
  check_sent_date: string | null;
  check_received_back_date: string | null;
}>;

type WriteResult = { data?: unknown; error: { message?: string } | null };

/** Structural view of the Supabase client / AWS adapter used here (tests pass a fake). */
export type MortgageDeskWriteClient = {
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<WriteResult>;
  from: (table: string) => {
    insert: (values: Record<string, unknown>) => PromiseLike<WriteResult>;
    update: (values: Record<string, unknown>) => {
      eq: (column: string, value: unknown) => PromiseLike<WriteResult>;
    };
  };
};

/** The note posted on the check thread when the Desk adds a mid-work note. */
export function buildMortgageDeskNoteMessage(note: string | null | undefined): string | null {
  const text = String(note ?? "").trim();
  if (!text) return null;
  return `${MORTGAGE_DESK_NOTE_PREFIX}${text}`.slice(0, 5000);
}

/** checks/<checkId>/mortgage-ops/<stamp>-<safe name>: the only prefix the Desk may upload to. */
export function mortgageDeskFilePath(checkId: string, fileName: string, prefix = "", now: number = Date.now()): string {
  const safe = String(fileName || "file").replace(/[^a-z0-9.\-_]/gi, "_").replace(/\.{2,}/g, "_");
  return `checks/${checkId}/mortgage-ops/${prefix}${now}-${safe}`;
}

export async function postMortgageDeskMessage(
  client: MortgageDeskWriteClient,
  usesAwsBackend: boolean,
  params: { requestId: string; checkId: string; senderId: string | null; body: string },
): Promise<WriteResult> {
  if (usesAwsBackend) {
    return client.rpc(MORTGAGE_DESK_RPC.postMessage, { _request_id: params.requestId, _body: params.body });
  }
  return client.from("check_messages").insert({
    check_id: params.checkId,
    sender_id: params.senderId,
    body: params.body,
  });
}

export async function attachMortgageDeskFile(
  client: MortgageDeskWriteClient,
  usesAwsBackend: boolean,
  params: {
    requestId: string;
    checkId: string;
    senderId: string | null;
    fileName: string;
    filePath: string;
    fileType: string | null;
    fileSize: number | null;
    category: MortgageDeskFileCategory;
    description: string | null;
  },
): Promise<WriteResult> {
  if (usesAwsBackend) {
    return client.rpc(MORTGAGE_DESK_RPC.attachFile, {
      _request_id: params.requestId,
      _file_name: params.fileName,
      _file_path: params.filePath,
      _file_type: params.fileType,
      _file_size: params.fileSize,
      _category: params.category,
      _description: params.description,
    });
  }
  return client.from("check_files").insert({
    check_intake_item_id: params.checkId,
    file_name: params.fileName,
    file_path: params.filePath,
    file_type: params.fileType,
    file_size: params.fileSize,
    category: params.category,
    source: MORTGAGE_DESK_FILE_SOURCE,
    uploaded_by: params.senderId,
    description: params.description,
  });
}

export async function updateMortgageDeskShipping(
  client: MortgageDeskWriteClient,
  usesAwsBackend: boolean,
  params: { requestId: string; senderId: string | null; fields: MortgageDeskShippingFields },
): Promise<WriteResult> {
  if (usesAwsBackend) {
    return client.rpc(MORTGAGE_DESK_RPC.updateShipping, { _request_id: params.requestId, _fields: params.fields });
  }
  const legacy: Record<string, unknown> = { ...params.fields };
  if (params.fields.shipping_label_path) {
    legacy.shipping_label_uploaded_at = new Date().toISOString();
    legacy.shipping_label_uploaded_by = params.senderId;
  }
  return client.from("mortgage_handling_requests").update(legacy).eq("id", params.requestId);
}

/**
 * SQL 166 (owner 2026-11-14: "Mortgage agent needs to be able to change the claim from monitor to not monitored, so the
 * tenants see that type of update"): the agent assigned to the in-progress request (or the platform owner) switches the
 * request's loss draft between Monitored and Not Monitored through mortgage_desk_set_monitoring. AWS only: the legacy
 * backend has no such path, so the control is hidden there. The tenant sees a check-thread message the server posts.
 */
export type MortgageDeskMonitoringType = "monitored" | "not_monitored";

export const MORTGAGE_DESK_MONITORING_LABEL: Readonly<Record<MortgageDeskMonitoringType, string>> = Object.freeze({
  monitored: "Monitored",
  not_monitored: "Not Monitored",
});

/** The loss draft escrow statuses SQL 166 refuses to change (CLOSED_LOSS_DRAFT_STATUSES in workflow-rpc.mjs). */
export const MORTGAGE_DESK_CLOSED_LOSS_DRAFT_STATUSES = Object.freeze(["endorsing", "final_release_complete"]);

/** The loss-draft fields the request page reads for the monitoring control. */
export type MortgageDeskLossDraft = {
  id: string;
  monitoring_type?: string | null;
  escrow_status?: string | null;
  total_escrowed?: number | string | null;
  draw_amount_requested?: number | string | null;
  draw_amount_released?: number | string | null;
  holdback_amount?: number | string | null;
  draw_stage?: number | string | null;
};

export const MORTGAGE_DESK_LOSS_DRAFT_SELECT =
  "id,monitoring_type,escrow_status,total_escrowed,draw_amount_requested,draw_amount_released,holdback_amount,draw_stage";

/** The loss draft's current type (SQL 166 reads a missing one as monitored). */
export function mortgageDeskMonitoringType(ld: MortgageDeskLossDraft | null | undefined): MortgageDeskMonitoringType {
  return ld?.monitoring_type === "not_monitored" ? "not_monitored" : "monitored";
}

const positive = (value: unknown): boolean => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0;
};

/**
 * Escrow or draws already recorded, by SQL 166's own rule (d): an amount or draw stage above 0, or an escrowed / draw
 * status. Used only to warn before the switch; the server's escrow_or_draws_recorded is what the toast reports.
 */
export function mortgageDeskEscrowOrDrawsRecorded(ld: MortgageDeskLossDraft | null | undefined): boolean {
  if (!ld) return false;
  return positive(ld.total_escrowed)
    || positive(ld.draw_amount_requested)
    || positive(ld.draw_amount_released)
    || positive(ld.holdback_amount)
    || positive(ld.draw_stage)
    || ["escrowed", "first_draw_requested", "partial_release"].includes(String(ld.escrow_status || ""));
}

export function mortgageDeskLossDraftClosed(ld: MortgageDeskLossDraft | null | undefined): boolean {
  return MORTGAGE_DESK_CLOSED_LOSS_DRAFT_STATUSES.includes(String(ld?.escrow_status || ""));
}

/**
 * Show the control: AWS backend, a request the caller may work (canWork: in progress, the assigned agent or the platform
 * owner, as the server's gate), and a loss draft on the request's check.
 */
export function showMortgageDeskMonitoringControl(
  usesAwsBackend: boolean,
  canWork: boolean,
  ld: MortgageDeskLossDraft | null | undefined,
): boolean {
  return usesAwsBackend && canWork && !!ld?.id;
}

/** The confirm dialog's text for a switch to `target`; the escrow warning when switching to Not Monitored with records. */
export function mortgageDeskMonitoringConfirm(
  target: MortgageDeskMonitoringType,
  ld: MortgageDeskLossDraft | null | undefined,
): { title: string; description: string; warning: string | null } {
  const label = MORTGAGE_DESK_MONITORING_LABEL[target];
  return {
    title: `Set this loss draft to ${label}?`,
    description: `The tenant will see "ChecksOps Mortgage Desk changed this loss draft to ${label}." on the check.`,
    warning: target === "not_monitored" && mortgageDeskEscrowOrDrawsRecorded(ld)
      ? "Escrow or draws are already recorded on this loss draft. They stay recorded; the loss draft will no longer be monitored."
      : null,
  };
}

export type MortgageDeskSetMonitoringResult = {
  ok?: boolean;
  changed?: boolean;
  monitoring_type?: string;
  previous_monitoring_type?: string;
  escrow_or_draws_recorded?: boolean;
};

/** The toast after a successful call, from the server's result. */
export function mortgageDeskMonitoringToast(result: MortgageDeskSetMonitoringResult | null | undefined): {
  title: string;
  description: string | null;
} {
  const type: MortgageDeskMonitoringType = result?.monitoring_type === "not_monitored" ? "not_monitored" : "monitored";
  const label = MORTGAGE_DESK_MONITORING_LABEL[type];
  if (result?.changed === false) return { title: `Already ${label}`, description: "Nothing changed; no message was posted." };
  return {
    title: `Loss draft set to ${label}; the tenant sees it on the check`,
    description: result?.escrow_or_draws_recorded ? "Escrow or draws were already recorded on this loss draft." : null,
  };
}

export async function setMortgageDeskMonitoring(
  client: Pick<MortgageDeskWriteClient, "rpc">,
  usesAwsBackend: boolean,
  params: { requestId: string; monitoringType: MortgageDeskMonitoringType },
): Promise<{ data: MortgageDeskSetMonitoringResult | null; error: { message?: string; code?: string } | null }> {
  if (!usesAwsBackend) {
    return { data: null, error: { message: "Changing monitoring from the Desk is available on AWS only" } };
  }
  const { data, error } = await client.rpc(MORTGAGE_DESK_RPC.setMonitoring, {
    _request_id: params.requestId,
    _monitoring_type: params.monitoringType,
  });
  if (error) return { data: null, error };
  return { data: (data as MortgageDeskSetMonitoringResult) ?? null, error: null };
}
