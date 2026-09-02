const S3_ERROR = {
  message: "s3_migration_required",
  name: "StorageApiError",
  statusCode: 501,
};

const emptySigned = { data: { signedUrl: "", path: "", signedUrlExpiresAt: null }, error: S3_ERROR };
const emptyPublic = { data: { publicUrl: "" }, error: null };

/**
 * Supabase Storage-compatible stub. Production buckets are not copied yet.
 * Callers keep their UI; uploads/downloads fail closed instead of talking to
 * Supabase Storage or exposing S3 credentials in the browser.
 */
export function createAwsStorageAdapter() {
  const from = (bucket: string) => ({
    bucket,
    upload: async () => ({ data: null, error: { ...S3_ERROR, message: `s3_migration_required:${bucket}` } }),
    update: async () => ({ data: null, error: S3_ERROR }),
    remove: async () => ({ data: null, error: S3_ERROR }),
    download: async () => ({ data: null, error: S3_ERROR }),
    list: async () => ({ data: [], error: S3_ERROR }),
    createSignedUrl: async () => emptySigned,
    createSignedUrls: async () => ({ data: [], error: S3_ERROR }),
    getPublicUrl: (path: string) => ({
      ...emptyPublic,
      data: { publicUrl: `s3://checksops-staging-unmigrated/${bucket}/${path}` },
    }),
  });

  return { from };
}

export const STAGING_STORAGE_BUCKETS = [
  "claim-files",
  "deposit-attachments",
  "loss-draft-documents",
  "company-branding",
  "tenant-logos",
  "endorsement-packets",
  "homeowner-uploads",
] as const;
