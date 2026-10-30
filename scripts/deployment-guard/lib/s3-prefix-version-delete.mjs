/**
 * Build the S3 DeleteObjects requests that remove every version of the staging files bucket's
 * Migration/ prefix (security audit finding 5) and nothing else.
 *
 * The bucket is versioned, so a plain delete would only add delete markers and keep the
 * production data as noncurrent versions. The requests name each Key and VersionId from the
 * snapshot taken at review time; the live listing must equal that snapshot before any request
 * is sent (diffListing). Pure: no AWS calls.
 * Runbook: ops/deployment-guard/staging-migration-prefix-delete/README.md.
 */

export const STAGING_BUCKET = 'checksops-staging-privatefilesbucket-erzqsolpucjp';
export const PREFIX = 'Migration/';
// DeleteObjects takes at most 1000 keys per request.
export const MAX_PER_REQUEST = 1000;

const id = (entry) => `${entry.Key}\u0000${entry.VersionId}`;

const entries = (listing) => [
  ...(listing.versions || []).map((v) => ({ ...v, kind: 'version' })),
  ...(listing.delete_markers || []).map((m) => ({ ...m, kind: 'marker' })),
];

const assertScope = (listing) => {
  if (!listing || listing.bucket !== STAGING_BUCKET) throw new Error(`bucket must be ${STAGING_BUCKET}`);
  if (listing.prefix !== PREFIX) throw new Error(`prefix must be ${PREFIX}`);
  for (const entry of entries(listing)) {
    if (typeof entry.Key !== 'string' || !entry.Key.startsWith(PREFIX)) throw new Error(`key outside ${PREFIX}: ${entry.Key}`);
    if (typeof entry.VersionId !== 'string' || !entry.VersionId) throw new Error(`missing VersionId: ${entry.Key}`);
  }
};

// Differences between the reviewed snapshot and a live ListObjectVersions read of the same prefix.
export const diffListing = (snapshot, live) => {
  assertScope(snapshot);
  assertScope(live);
  const before = new Map(entries(snapshot).map((e) => [id(e), e]));
  const now = new Map(entries(live).map((e) => [id(e), e]));
  const missing = [...before.keys()].filter((k) => !now.has(k));
  const extra = [...now.keys()].filter((k) => !before.has(k));
  const changed = [...before.keys()].filter((k) => now.has(k)
    && (before.get(k).kind !== now.get(k).kind || before.get(k).ETag !== now.get(k).ETag || before.get(k).Size !== now.get(k).Size));
  return { equal: !missing.length && !extra.length && !changed.length, missing, extra, changed };
};

export const buildDeleteRequests = (snapshot) => {
  assertScope(snapshot);
  const objects = entries(snapshot).map(({ Key, VersionId }) => ({ Key, VersionId }));
  const requests = [];
  for (let i = 0; i < objects.length; i += MAX_PER_REQUEST) {
    requests.push({ Bucket: STAGING_BUCKET, Delete: { Objects: objects.slice(i, i + MAX_PER_REQUEST), Quiet: false } });
  }
  return requests;
};
