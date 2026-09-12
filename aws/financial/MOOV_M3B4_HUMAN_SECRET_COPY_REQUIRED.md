# Moov M3b.4 — migrate exact Lovable production key pair to AWS

**Status:** STOP FOR REVIEW. **HUMAN SECRET COPY REQUIRED.**  
**Date:** 2026-09-10  
**Branch:** `cursor/moov-production-readiness-m3b-4-a508`

No secret values were printed, logged, or committed. AWS secret `checksops/production/provider` was **not** modified. OAuth was **not** attempted (copy did not occur). Account GET was **not** sent.

---

## 1. Can this environment read live Lovable Edge secret VALUES?

**No.** There is no secure non-printing retrieval path here for live Edge Function `MOOV_PUBLIC_KEY` / `MOOV_SECRET_KEY`.

Checked (names / auth errors only):

| Path | Result |
| --- | --- |
| Process env `SUPABASE_ACCESS_TOKEN` | **absent** |
| Cloud Agent injected secrets | only `CURSOR_AWS_ASSUME_IAM_ROLE_ARN` |
| `supabase` CLI login / `~/.supabase` | **missing** |
| `npx supabase secrets list --project-ref nbcqwpysqgyxrrbgtmkw` | **fails**: access token not provided |
| `GET https://api.supabase.com/v1/projects/nbcqwpysqgyxrrbgtmkw/secrets` | **HTTP 401 Unauthorized** |
| Workspace `.env` / `.env.production` | no `MOOV_*` names |
| AWS `checksops/production/provider` | has Moov keys already (wrong pair); **not** a Lovable management token |
| AWS `checksops/staging/providers` | sandbox keys only |
| GitHub Actions secrets API | **403** (cannot list, cannot read values) |
| SSM Parameter Store | `DescribeParameters` **denied** |

Not attempted (forbidden / would not be the live Edge pair):

- reconstructing from hashes, logs, source, JWTs, or RDS `provider_metadata`
- reading Drop `public_key` from an Edge invoke (that is not the secret, and would still not copy the pair)

---

## 2. Secret copy

**NOT PERFORMED.**

`checksops/production/provider` last changed **`2026-09-10T01:22:23Z`** (unchanged this pass).  
`MOOV_ENVIRONMENT` / `MOOV_ALLOWED_ORIGIN` were not altered.  
`MOOV_PLATFORM_ACCOUNT_ID` and webhook secret were **not** added.

---

## 3. Confirmation (copy skipped)

| Check | Result |
| --- | --- |
| Secret version changed | **No** |
| Key names present | still `MOOV_PUBLIC_KEY`, `MOOV_SECRET_KEY`, `MOOV_ENVIRONMENT`, `MOOV_ALLOWED_ORIGIN` |
| Fingerprints vs Lovable | **cannot compare** (Edge values unread) |
| Secret values emitted | **none** |

---

## 4. Safety state (unchanged)

| Flag | Value |
| --- | --- |
| `AWS_PROVIDER_LIVE_READS_ENABLED` | **true** |
| `AWS_MOOV_ENABLED` | **false** |
| `AWS_PROVIDER_EXECUTION_ENABLED` | **false** |
| `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` | **false** |
| `AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED` | **false** |

---

## 5. OAuth / Freedom GET

**Not run.** Step 2 did not place the known-good pair in AWS. Per instructions: do not mint a token against the current (known-bad) pair.

---

## 6. GET-only inventory

**Not started.** Blocked on OAuth.

---

## 7. Safety re-proof

| Check | Result |
| --- | --- |
| `moov-transfer-create` | `403 production_execution_blocked`, `liveProviderCalled=false` |
| `moov-disburse` | `403 production_execution_blocked`, `liveProviderCalled=false` |
| Transfer POSTs | **0** |
| Money movement | **zero** |
| SQL 72 | **NOT_APPLIED** (`provider_http_attempted_at` does not exist) |
| Lovable | unchanged (`productionSupabaseChanged=false`) |
| Webhooks | unchanged (`productionWebhooksRedirected=false`) |
| Moov HTTP this pass | **none** |

---

## Human copy (do not retype)

When an operator can open the **live** Lovable/Supabase project (`nbcqwpysqgyxrrbgtmkw`) Edge Function secrets:

1. Copy **exact** `MOOV_PUBLIC_KEY` and `MOOV_SECRET_KEY` (paste; do not retype or transform).
2. Put **only those two keys** into AWSCURRENT of `checksops/production/provider`.
3. Preserve `MOOV_ENVIRONMENT=production` and `MOOV_ALLOWED_ORIGIN=https://checksops.com` (trailing slash in the stored origin is already tolerated; do not change it in this step).
4. Do **not** add `MOOV_PLATFORM_ACCOUNT_ID` or webhook secret yet.
5. Do not paste the values into chat, git, or tickets.
6. Tell the agent the copy is done (no values). The agent can then recycle the Lambda container if needed and run **one** OAuth.

**GO/NO-GO:** **NO-GO** for OAuth/GET until that copy lands. **NO-GO** for money / SQL 72.

**STOP FOR REVIEW.**
