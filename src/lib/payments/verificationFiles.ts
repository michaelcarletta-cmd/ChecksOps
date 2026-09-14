import { supabase } from "@/integrations/supabase/client";
import { awsApiBaseUrl } from "@/lib/awsStaging";
import { moovAccountFileUploadUrl } from "@/lib/awsFunctionUrls";

/**
 * Frontend access to verification-document metadata.
 *
 * All provider authentication happens server-side in the edge functions —
 * nothing in this file knows or holds provider credentials, and document
 * contents are never retrievable from the client.
 */

export const FILE_PURPOSE_OPTIONS = [
  { value: "business_verification", label: "Business verification" },
  { value: "identity_verification", label: "Identity verification" },
  { value: "individual_verification", label: "Individual verification" },
  { value: "representative_verification", label: "Representative verification" },
  { value: "w9", label: "W-9" },
  { value: "bank_statement", label: "Bank statement (last 3 months)" },
  { value: "license", label: "License" },
  { value: "insurance", label: "Insurance" },
  { value: "saas_agreement", label: "SaaS Agreement" },
  { value: "terms_of_service", label: "Terms of Service" },
  { value: "privacy_policy", label: "Privacy Policy" },
] as const;

export type VerificationPurpose = (typeof FILE_PURPOSE_OPTIONS)[number]["value"];

export const PURPOSE_LABEL: Record<string, string> = Object.fromEntries(
  FILE_PURPOSE_OPTIONS.map((o) => [o.value, o.label]),
);

export const ACCEPTED_EXTENSIONS = ".pdf,.jpg,.jpeg,.png,.csv";
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export interface VerificationFile {
  id: string;
  file_name: string;
  file_purpose: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  requirement_id: string | null;
  provider_file_id: string;
  provider_representative_id: string | null;
  review_status: "pending" | "approved" | "rejected" | string;
  review_reason: string | null;
  created_at: string;
  last_synced_at: string | null;
  storage_path?: string | null;
}

export async function getVerificationFileUrl(
  tenantId: string,
  fileId: string,
): Promise<string> {
  const { data, error } = await supabase.functions.invoke("moov-account-file-view", {
    body: { tenant_id: tenantId, file_id: fileId },
  });
  return (unwrap(error, data) as { url: string }).url;
}

export interface VerificationFilesResponse {
  account_connected: boolean;
  requirements: string[];
  representatives: Array<{ id: string; name: string }>;
  files: VerificationFile[];
  sync_error: string | null;
}

function unwrap(error: any, data: any) {
  if (error) throw new Error(error.message ?? "Request failed");
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function listVerificationFiles(
  tenantId: string,
  sync = true,
): Promise<VerificationFilesResponse> {
  const { data, error } = await supabase.functions.invoke("moov-account-files", {
    body: { tenant_id: tenantId, sync },
  });
  return unwrap(error, data) as VerificationFilesResponse;
}

export interface UploadArgs {
  tenantId: string;
  file: File;
  purpose: VerificationPurpose;
  representativeId?: string | null;
  requirementId?: string | null;
  onProgress?: (percent: number) => void;
}

/**
 * Uploads via XHR so we can report real progress. The Authorization header
 * carries the user's own session — never a provider credential.
 */
export async function uploadVerificationFile(args: UploadArgs): Promise<VerificationFile> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error("You need to be signed in.");

  const form = new FormData();
  form.append("tenant_id", args.tenantId);
  form.append("file_purpose", args.purpose);
  form.append("file", args.file, args.file.name);
  if (args.representativeId) form.append("representative_id", args.representativeId);
  if (args.requirementId) form.append("requirement_id", args.requirementId);

  const url = moovAccountFileUploadUrl(awsApiBaseUrl());

  return new Promise<VerificationFile>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) args.onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onerror = () => reject(new Error("Network error while uploading."));
    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText || "{}");
      } catch { /* non-JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && body?.file) {
        args.onProgress?.(100);
        resolve(body.file as VerificationFile);
      } else {
        reject(new Error(body?.error ?? "Upload failed."));
      }
    };
    xhr.send(form);
  });
}
