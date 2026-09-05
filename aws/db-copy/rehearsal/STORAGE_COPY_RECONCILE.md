# PR #127 storage COPY / reconciliation — STOP FOR REVIEW

**Generated:** 2026-09-05T01:57:08Z (UTC)  
**Branch:** `cursor/migration-rehearsal-cutover-c8f0`  
**Result:** **PASS**  
**Production cutover performed:** **NO**  
**Lovable bridge removed:** **NO** (kept for final production delta sync)

## Safety attestation

| Control | Result |
|---|---|
| Lovable/Supabase Storage modified, deleted, renamed, or moved | **NO** (inventory + sign only) |
| Production database / Auth / DNS / webhooks changed | **NO** |
| Moov / CheckAlt / provider flags / financial activation | **NO** |
| `64_financial_activation_grants.sql` applied | **NO** |
| Staging-only UAT objects deleted or overwritten | **NO** (21 left in place) |
| Hash-mismatched staging objects overwritten | **NO** (0 conflicts) |
| Raw token / signed URLs / object paths / file bytes in this report | **NO** |
| `ai-knowledge-base` / `database-export` counted as failures | **NO** (0 seen) |

## Health

Live `POST action=health` (token from Secrets Manager, never logged):

- `ok: true`
- `mode: "sign_only"`
- `deletes: false`
- `dbWrites: false`
- `maxSign: 50` (batches used ≤ 50)

## Copy

Destination: private bucket `checksops-staging-privatefilesbucket-erzqsolpucjp`, keys `files/{bucket}/{original_path}`.

| Metric | Count / bytes |
|---|---|
| Production approved objects | **1,411** |
| Sign batches | 35 (max 50 objects) |
| Newly copied | **77** |
| Existing production objects verified (SHA-256 match, no put) | **1,334** |
| Failed | **0** |
| Conflicts / mismatched hashes | **0** |
| Missing after COPY | **0** |
| Duplicate source keys | **0** |
| Downloaded / production bytes on S3 | **2,565,912,220** |
| Sign / download / put retries | 0 / 0 / 0 |
| Null-size inventory objects | **2** — downloaded size **0** and **0**; both already on S3 at 0 bytes; not treated as unknown |

S3 `files/` prefix: **1,355 → 1,432** (= 1,355 + 77 new production objects).

## Reconciliation vs expected production inventory

Expected total **1,411**. Actual migrated production objects **1,411**. Total production bytes **2,565,912,220** (exact match to live inventory bytes).

| Bucket | Production | Expected | Migrated | Bytes |
|---| ---:| ---:| ---:| ---:|
| claim-files | 1,254 | 1,254 | 1,254 | 2,519,452,045 |
| endorsement-packets | 131 | 131 | 131 | 9,474,059 |
| homeowner-uploads | 8 | 8 | 8 | 30,364,235 |
| tenant-documents | 8 | 8 | 8 | 2,800,034 |
| tenant-logos | 5 | 5 | 5 | 2,687,016 |
| loss-draft-documents | 3 | 3 | 3 | 116,262 |
| document-templates | 1 | 1 | 1 | 3,124 |
| email-assets | 1 | 1 | 1 | 1,015,445 |

| Check | Result |
|---|---|
| Production count vs migrated production count | **PASS** 1,411 / 1,411 |
| Per-bucket counts | **PASS** (0 diffs) |
| Paths/keys | **PASS** (0 missing production keys; fingerprints only, no paths committed) |
| Byte sizes / total bytes | **PASS** 2,565,912,220 / 2,565,912,220 |
| Missing objects | **0** |
| Failed objects | **0** |
| Duplicates | **0** |
| Changed / mismatched hashes | **0** (1,411 compared, 1,411 matched) |
| Staging-only UAT objects | **21** identified and **left in place** (17 claim-files / 130,408 bytes; 4 homeowner-uploads / 3,523 bytes; 133,931 bytes total) |

Machine-readable sanitized evidence: `analysis/storage_copy_reconcile.json`.

## Not done (out of scope this stop)

- Lovable bridge teardown (required for final delta)
- Production database dump / isolated RDS rehearsal restore
- DNS, Auth, webhooks, Moov, CheckAlt, provider flags, financial activation
- Production cutover

## STOP

**STOP FOR REVIEW.** Storage COPY + recon vs live production inventory is **PASS**. Do not treat this as cutover authorization.
