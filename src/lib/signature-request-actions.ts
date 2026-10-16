/**
 * Pure rules for the Signature Requests panel (upload path, Resend, Delete).
 * The server enforces the same rules in aws/functions/api/esign.mjs and
 * storage-write-auth.mjs; these only decide what the SPA offers.
 */

const CHECK_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * AWS claim-files writes must use a check-scoped prefix (storage-write-auth.mjs).
 * Never fall back to signatures/{claimId}, which the API rejects with
 * path_not_allowlisted.
 */
export const buildCheckScopedSignatureUploadPath = (
  checkIntakeItemId: string | null | undefined,
  name: string | null | undefined,
  now: number = Date.now(),
  nonce: string = globalThis.crypto.randomUUID(),
) => {
  const checkId = String(checkIntakeItemId || "").trim().toLowerCase();
  if (!CHECK_UUID_RE.test(checkId)) {
    throw new Error("Signature upload requires a check-scoped path");
  }
  const sanitized = String(name || "document").replace(/[^a-zA-Z0-9.\-_]/g, "_");
  return `check-intake/${checkId}/files/${now}-${nonce}-${sanitized}`;
};

type SignerLike = {
  status?: string | null;
  signed_at?: string | null;
  viewed_at?: string | null;
  delivery_status?: string | null;
};

type RequestLike = {
  status?: string | null;
  sent_at?: string | null;
  final_pdf_path?: string | null;
  delivery_mode?: string | null;
  signature_signers?: SignerLike[] | null;
};

const lower = (value: unknown) => String(value || "").toLowerCase();

export const requestAlreadySigned = (request: RequestLike | null | undefined) => {
  const status = lower(request?.status);
  if (status === "completed" || status === "signed") return true;
  const list = request?.signature_signers || [];
  return list.length > 0 && list.every((signer) => lower(signer?.status) === "signed");
};

/** Resend only for pending or failed requests that are not already signed (server: 409 already_signed). */
export const canResendRequest = (request: RequestLike | null | undefined) => {
  if (!request || requestAlreadySigned(request)) return false;
  const status = lower(request.status);
  return status === "failed" || status === "pending";
};

/** Per-signer Resend: only a failed delivery to a signer who has not signed, on a request that is not signed. */
export const canResendSigner = (request: RequestLike | null | undefined, signer: SignerLike | null | undefined) => (
  lower(signer?.delivery_status) === "failed"
  && lower(signer?.status) !== "signed"
  && !requestAlreadySigned(request)
);

/** Mirrors esign.mjs signatureRequestDeletable: drafts and requests nobody was sent. */
export const canDeleteSignatureRequest = (request: RequestLike | null | undefined) => {
  if (!request) return false;
  const status = lower(request.status);
  if (status !== "draft" && status !== "failed") return false;
  if (request.sent_at || request.final_pdf_path) return false;
  if (lower(request.delivery_mode) === "manual_bypass") return false;
  return (request.signature_signers || []).every((signer) => (
    lower(signer?.status) !== "signed"
    && !signer?.signed_at
    && !signer?.viewed_at
    && lower(signer?.delivery_status) !== "sent"
  ));
};
