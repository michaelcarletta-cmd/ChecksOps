// Moov account Files API client (KYB/KYC verification documents).
//
// Every call is server-side only and follows the project's version strategy:
// ChecksOps pinned Moov API version: v2024.01.00
// Moov current stable API: v2026.07.00
// ChecksOps intentionally remains pinned pending a controlled API migration.

import { moovFetch, moovUpload, scopes } from "./moovClient.ts";
import { normalizeReviewStatus, type FilePurpose } from "./moovFileRules.ts";

export function moovApiVersion(): string {
  return Deno.env.get("MOOV_API_VERSION") ?? "v2024.01.00";
}

export interface MoovRepresentative {
  representativeID: string;
  name?: { firstName?: string; lastName?: string };
  disabledOn?: string | null;
}

/** Representatives on a connected account — used to verify the mapping. */
export async function listRepresentatives(accountId: string): Promise<MoovRepresentative[]> {
  const res = await moovFetch<any>(`/accounts/${accountId}/representatives`, {
    method: "GET",
    scopes: scopes.representativesRead(accountId),
    apiVersion: moovApiVersion(),
  });
  const list = Array.isArray(res) ? res : res?.representatives ?? [];
  return list.map((r: any) => ({
    representativeID: r?.representativeID ?? r?.representativeId ?? r?.id,
    name: r?.name,
    disabledOn: r?.disabledOn ?? null,
  })).filter((r: MoovRepresentative) => !!r.representativeID);
}

export async function representativeBelongsToAccount(
  accountId: string,
  representativeId: string,
): Promise<boolean> {
  const reps = await listRepresentatives(accountId);
  return reps.some((r) => r.representativeID === representativeId);
}

export interface MoovFileRecord {
  fileID: string;
  fileName?: string;
  filePurpose?: string;
  fileStatusCode?: string;
  fileSizeBytes?: number;
  decisionReason?: string | null;
  metadata?: Record<string, string> | null;
  createdOn?: string;
  updatedOn?: string;
}

export interface UploadArgs {
  accountId: string;
  purpose: FilePurpose;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  representativeId?: string | null;
  requirementId?: string | null;
  idempotencyKey?: string;
}

/**
 * Forwards the document to Moov. The raw bytes are never persisted by
 * ChecksOps — they exist only for the life of this request.
 */
export async function uploadAccountFile(args: UploadArgs): Promise<MoovFileRecord> {
  const form = new FormData();
  form.append("filePurpose", args.purpose);
  form.append(
    "file",
    new Blob([args.bytes], { type: args.mimeType }),
    args.fileName,
  );
  const metadata: Record<string, string> = {};
  if (args.representativeId) metadata.representativeID = args.representativeId;
  if (args.requirementId) metadata.requirementID = args.requirementId;
  if (Object.keys(metadata).length > 0) form.append("metadata", JSON.stringify(metadata));
  if (args.representativeId) form.append("representativeID", args.representativeId);

  const res = await moovUpload<any>(`/accounts/${args.accountId}/files`, {
    scopes: scopes.filesWrite(args.accountId),
    form,
    apiVersion: moovApiVersion(),
    idempotencyKey: args.idempotencyKey,
  });
  return normalizeFile(res);
}

/** Metadata listing only — file contents are never fetched or proxied. */
export async function listAccountFiles(accountId: string): Promise<MoovFileRecord[]> {
  const res = await moovFetch<any>(`/accounts/${accountId}/files`, {
    method: "GET",
    scopes: scopes.filesRead(accountId),
    apiVersion: moovApiVersion(),
  });
  const list = Array.isArray(res) ? res : res?.files ?? [];
  return list.map(normalizeFile);
}

export function normalizeFile(raw: any): MoovFileRecord {
  return {
    fileID: raw?.fileID ?? raw?.fileId ?? raw?.id,
    fileName: raw?.fileName ?? raw?.filename ?? undefined,
    filePurpose: raw?.filePurpose ?? undefined,
    fileStatusCode: raw?.fileStatusCode ?? raw?.status ?? undefined,
    fileSizeBytes: Number(raw?.fileSizeBytes ?? raw?.size ?? 0) || undefined,
    decisionReason: raw?.decisionReason ?? raw?.errorMessage ?? null,
    metadata: raw?.metadata ?? null,
    createdOn: raw?.createdOn ?? undefined,
    updatedOn: raw?.updatedOn ?? undefined,
  };
}

export function reviewStatusOf(file: MoovFileRecord): string {
  return normalizeReviewStatus(file.fileStatusCode);
}
