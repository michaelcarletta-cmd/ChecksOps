/**
 * Some legacy `front_image_path` / `back_image_path` values were stored as
 * full signed URLs (e.g. https://<proj>.supabase.co/storage/v1/object/sign/claim-files/checks/...).
 * Storage signing requires a relative object path inside the bucket
 * (e.g. "checks/<claim>/<check>/front.jpg"). This helper normalizes either
 * format to a clean object path for the given bucket.
 */
export function toStorageObjectPath(
  value: string | null | undefined,
  bucket = "claim-files",
): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;

  // Already a relative path
  if (!/^https?:\/\//i.test(v)) {
    return v.replace(new RegExp(`^${bucket}/`), "");
  }

  try {
    const url = new URL(v);
    // Patterns:
    //   /storage/v1/object/sign/<bucket>/<path>?token=...
    //   /storage/v1/object/public/<bucket>/<path>
    //   /storage/v1/object/<bucket>/<path>
    const match = url.pathname.match(
      /\/storage\/v1\/object\/(?:sign\/|public\/)?([^/]+)\/(.+)$/,
    );
    if (match && match[1] === bucket) {
      return decodeURIComponent(match[2]);
    }
    return null;
  } catch {
    return null;
  }
}
