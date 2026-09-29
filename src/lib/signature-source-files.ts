export const SIGNATURE_SOURCE_FILES_QUERY_KEY = "signature-source-files";

export type SignatureSourceKind = "check_file" | "claim_file";

export type SignatureSourceFile = {
  id: string;
  file_name?: string | null;
  file_path?: string | null;
  check_intake_item_id?: string | null;
  claim_id?: string | null;
  created_at?: string | null;
  uploaded_at?: string | null;
  _source: SignatureSourceKind;
};

export const signatureSourceFilesQueryKey = (
  claimId?: string | null,
  checkIntakeItemId?: string | null,
) => [SIGNATURE_SOURCE_FILES_QUERY_KEY, claimId || null, checkIntakeItemId || null] as const;

export const isEligibleSignatureSourceFile = (file: { file_name?: string | null } | null | undefined) => {
  const name = String(file?.file_name || "").toLowerCase();
  return name.endsWith(".pdf") || name.endsWith(".docx");
};

const normalizePath = (value: string | null | undefined) => String(value || "").split("?")[0].trim();

export const mergeClaimAndCheckSignatureFiles = ({
  claimFiles = [],
  checkFiles = [],
  checkIntakeItemId = null,
}: {
  claimFiles?: Array<Record<string, unknown>>;
  checkFiles?: Array<Record<string, unknown>>;
  checkIntakeItemId?: string | null;
}): SignatureSourceFile[] => {
  const scopedCheckFiles = (checkFiles || []).filter((row) => {
    if (!checkIntakeItemId) return false;
    return String(row.check_intake_item_id || "") === String(checkIntakeItemId);
  });
  const checkRows = scopedCheckFiles
    .filter((row) => isEligibleSignatureSourceFile(row))
    .map((row) => ({
      ...row,
      uploaded_at: row.uploaded_at || row.created_at || null,
      _source: "check_file" as const,
    }));
  const claimRows = (claimFiles || [])
    .filter((row) => isEligibleSignatureSourceFile(row))
    .map((row) => ({
      ...row,
      _source: "claim_file" as const,
    }));

  const seen = new Set<string>();
  const merged: SignatureSourceFile[] = [];
  for (const row of [...checkRows, ...claimRows]) {
    const path = normalizePath(row.file_path as string | undefined);
    const key = path || `${row._source}:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row as SignatureSourceFile);
  }
  return merged;
};

export const signatureRequestDocumentFields = ({
  claimId,
  checkIntakeItemId,
  documentName,
  documentPath,
}: {
  claimId: string;
  checkIntakeItemId?: string | null;
  documentName: string;
  documentPath: string;
}) => ({
  claim_id: claimId,
  check_intake_item_id: checkIntakeItemId || null,
  document_name: documentName,
  document_path: documentPath,
});
