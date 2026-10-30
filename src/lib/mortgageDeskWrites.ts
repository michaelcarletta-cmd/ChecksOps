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
