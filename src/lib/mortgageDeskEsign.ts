/**
 * Mortgage Desk e-sign, reads and timeline on the AWS backend (SQL 124).
 *
 * The Desk agent is not a member of the requesting tenant, so on AWS it cannot
 * read the check's thread, files or signature requests, or create a signature
 * request, itself. Everything goes through POST /functions/v1/mortgage-desk-esign
 * (aws/functions/api/mortgage-desk-esign.mjs), which checks on the server that
 * the caller is the agent assigned to the request (or the platform owner).
 *
 * No "@/" imports: aws/tests load this file with --experimental-strip-types.
 */

export const MORTGAGE_DESK_ESIGN_FUNCTION = "mortgage-desk-esign";
export const MORTGAGE_DESK_ESIGN_MAX_SIGNERS = 4;

/**
 * The signer_type the Desk sends for every signer. The tenant Files-tab dialog
 * asks only for a name and an email for the signer it starts with and sends
 * "policyholder" for it (SignatureRequests.tsx); SQL 124 accepts policyholder
 * or contractor, so every Desk signer is sent as policyholder.
 */
export const MORTGAGE_DESK_SIGNER_TYPE = "policyholder";

/** One signer as the agent types it: a name and an email address, nothing else. */
export interface MortgageDeskSignerInput {
  name: string;
  email: string;
}

export interface MortgageDeskMessage {
  id: string;
  sender_id: string | null;
  body: string;
  created_at: string;
  from_desk: boolean;
}

export interface MortgageDeskCheckFile {
  id: string;
  file_name: string;
  file_path: string;
  file_type: string | null;
  file_size: number | null;
  category: string | null;
  description: string | null;
  source: string | null;
  created_at: string;
  signature_request_id: string | null;
}

export interface MortgageDeskSigner {
  id: string;
  signer_name: string;
  signer_email: string;
  signer_type: string;
  signing_order: number | null;
  status: string;
  signed_at: string | null;
  viewed_at: string | null;
  delivery_status: string | null;
}

export interface MortgageDeskSignatureRequest {
  id: string;
  document_name: string;
  document_path: string;
  status: string;
  created_at: string;
  sent_at: string | null;
  final_pdf_path: string | null;
  created_by: string | null;
  signers: MortgageDeskSigner[];
}

export interface MortgageDeskWorkspace {
  messages: MortgageDeskMessage[];
  check_files: MortgageDeskCheckFile[];
  signature_requests: MortgageDeskSignatureRequest[];
}

type InvokeResult = { data?: unknown; error?: unknown };

/** Structural view of the Supabase client / AWS adapter (tests pass a fake). */
export type MortgageDeskFunctionsClient = {
  functions: { invoke: (name: string, options: { body: Record<string, unknown> }) => PromiseLike<InvokeResult> };
};

/** A check file the Desk may send for signature: .pdf or .docx (SQL 124, the tenant flow's types). */
export function isDeskSignableFile(path: string | null | undefined): boolean {
  return /\.(pdf|docx)$/i.test(String(path ?? "").split("?")[0].trim());
}

export function isDeskDocxFile(path: string | null | undefined): boolean {
  return /\.docx$/i.test(String(path ?? "").split("?")[0].trim());
}

/** Same rule as aws_mortgage_desk_working_request: in progress, and the assigned agent or the platform owner. */
export function canWorkMortgageDeskRequest(
  req: { status?: string | null; assigned_employee_id?: string | null } | null | undefined,
  userId: string | null | undefined,
  platformOwner: boolean,
): boolean {
  if (!req || req.status !== "in_progress") return false;
  return platformOwner || (!!userId && req.assigned_employee_id === userId);
}

/** Reads are allowed in progress and after completion (SQL 124 a). */
export function canReadMortgageDeskRequest(
  req: { status?: string | null; assigned_employee_id?: string | null } | null | undefined,
  userId: string | null | undefined,
  platformOwner: boolean,
): boolean {
  if (!req || (req.status !== "in_progress" && req.status !== "completed")) return false;
  return platformOwner || (!!userId && req.assigned_employee_id === userId);
}

/**
 * The first signer the dialog starts with, as the tenant dialog starts it: the
 * claim's policyholder name and email when known, else blank. Always editable.
 */
export function defaultDeskSigners(ctx: {
  homeownerName?: string | null;
  homeownerEmail?: string | null;
}): MortgageDeskSignerInput[] {
  return [{
    name: String(ctx.homeownerName ?? "").trim(),
    email: String(ctx.homeownerEmail ?? "").trim(),
  }];
}

/** The first signer without a signature field (1-based), or null. */
export function deskSignerMissingSignature(
  fields: Array<{ type?: string; signerIndex?: number }>,
  signerCount: number,
): number | null {
  for (let i = 0; i < signerCount; i += 1) {
    if (!fields.some((f) => f.type === "signature" && (f.signerIndex ?? 0) === i)) return i + 1;
  }
  return null;
}

export function buildDeskSignaturePayload(params: {
  requestId: string;
  documentName: string;
  documentPath: string;
  documentType: string | null;
  fieldData: unknown[];
  signers: MortgageDeskSignerInput[];
}): Record<string, unknown> {
  return {
    action: "send_signature_request",
    request_id: params.requestId,
    document_name: params.documentName.trim(),
    document_path: String(params.documentPath).split("?")[0].trim(),
    document_type: params.documentType || null,
    field_data: Array.isArray(params.fieldData) ? params.fieldData : [],
    // Signers sign in this order; the server sets signing_order to the position.
    signers: params.signers.map((s) => ({
      signer_name: s.name.trim(),
      signer_email: s.email.trim(),
      signer_type: MORTGAGE_DESK_SIGNER_TYPE,
    })),
  };
}

/** Result or a readable error message (the server's own message for a refusal). */
export async function invokeMortgageDeskEsign<T = unknown>(
  client: MortgageDeskFunctionsClient,
  body: Record<string, unknown>,
  describeError?: (error: unknown) => Promise<string>,
): Promise<{ data: T | null; error: string | null }> {
  const { data, error } = await client.functions.invoke(MORTGAGE_DESK_ESIGN_FUNCTION, { body });
  if (error) {
    const message = describeError ? await describeError(error) : String((error as { message?: string } | null)?.message || "Request failed");
    return { data: null, error: message };
  }
  const reply = (data ?? null) as { ok?: boolean; message?: string; error?: string } | null;
  if (reply && reply.ok === false) return { data: null, error: String(reply.message || reply.error || "Request failed") };
  return { data: (data ?? null) as T | null, error: null };
}

export async function loadMortgageDeskWorkspace(
  client: MortgageDeskFunctionsClient,
  requestId: string,
): Promise<{ data: MortgageDeskWorkspace | null; error: string | null }> {
  const out = await invokeMortgageDeskEsign<{ data: MortgageDeskWorkspace }>(client, { action: "workspace", request_id: requestId });
  if (out.error || !out.data?.data) return { data: null, error: out.error };
  const ws = out.data.data;
  return {
    data: {
      messages: Array.isArray(ws.messages) ? ws.messages : [],
      check_files: Array.isArray(ws.check_files) ? ws.check_files : [],
      signature_requests: Array.isArray(ws.signature_requests) ? ws.signature_requests : [],
    },
    error: null,
  };
}

/**
 * A short-lived read URL for a Desk file (SQL 124 e): a check file, a
 * signature document or signed PDF of the request's check, or a Desk upload.
 */
export async function signMortgageDeskFile(
  client: MortgageDeskFunctionsClient,
  params: { requestId: string; path: string; download?: string | boolean },
  describeError?: (error: unknown) => Promise<string>,
): Promise<{ signedUrl: string | null; error: string | null }> {
  const out = await invokeMortgageDeskEsign<{ signedUrl?: string }>(client, {
    action: "sign_url",
    request_id: params.requestId,
    path: params.path,
    ...(params.download ? { download: params.download } : {}),
  }, describeError);
  if (out.error || !out.data?.signedUrl) return { signedUrl: null, error: out.error || "Could not open the file" };
  return { signedUrl: out.data.signedUrl, error: null };
}

export async function postMortgageDeskTimeline(
  client: MortgageDeskFunctionsClient,
  params: { requestId: string; kind: "mortgage_followup" | "mortgage_update"; note: string },
  describeError?: (error: unknown) => Promise<string>,
): Promise<{ error: string | null }> {
  const out = await invokeMortgageDeskEsign(client, {
    action: "post_timeline",
    request_id: params.requestId,
    kind: params.kind,
    note: params.note.trim(),
  }, describeError);
  return { error: out.error };
}

/** Per-signer status line, as the tenant's signature list shows it. */
export function deskSignerStatusLabel(signer: Pick<MortgageDeskSigner, "status" | "signed_at" | "viewed_at" | "delivery_status">): string {
  if (signer.status === "signed" && signer.signed_at) return `Signed ${new Date(signer.signed_at).toLocaleDateString()}`;
  if (signer.viewed_at) return `Viewed ${new Date(signer.viewed_at).toLocaleDateString()}`;
  if (signer.delivery_status === "sent") return "Email sent";
  if (signer.delivery_status === "failed") return "Send failed";
  return signer.status || "pending";
}

/** Request status label, as the tenant's signature list names them. */
export function deskSignatureStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "Sent",
    in_progress: "Partially signed",
    completed: "Completed",
    failed: "Failed",
    declined: "Declined",
    draft: "Draft",
  };
  return labels[status] || String(status || "").replace("_", " ");
}
