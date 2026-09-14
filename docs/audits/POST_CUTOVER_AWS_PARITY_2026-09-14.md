# POST-CUTOVER AWS PARITY INVENTORY COMPLETE

**Date:** 2026-09-14  
**Inventory:** `docs/audits/inventory-2026-09-11.json` (same 1,421 IDs as `origin/cursor/phase3-functional-audit-d82c`)  
**Rule:** prior `result` values are frozen. This pass only adds `post_cutover_status`.

Production `https://checksops.com` at classification time:

| Item | Value |
|---|---|
| SPA | `/assets/index-CiOVNYWh.js` |
| Deployment commit | `868e69387d63af511f4c185775b611dea2c8fc47` |
| Auth | Cognito production `us-east-1_h00WorYMT` / `3ja9fqaq2fjkv3i6up2varcqpe` |
| API | same-origin `/prep` → `checksops-production-prep-api` `CodeSha256=B8cQg1FnQzUSx7B/nANevkWrTCV/UPgX+e4GtXzlqvk=` |
| Live write/provider flags | `AWS_WRITES_ENABLED=true`, storage writes ON, application + check workflow writes ON, `AWS_PROVIDER_EXECUTION_ENABLED=true`, `AWS_CHECKALT_ENABLED=true`, `AWS_MOOV_ENABLED=true`, `AWS_PROVIDER_WEBHOOK_DRY_RUN=false` |
| Lambda `SUPABASE_*` | none |

This is a reconciliation of the existing functional-audit inventory against that production AWS deployment. It is not a new crawl and not a full 1,136-control retest. Money movement was not initiated.

## 1–7. Counts

| # | Metric | Count |
|---|---|---|
| 1 | Total existing inventory | **1,421** |
| 2 | AWS_PASS | **7** |
| 3 | AWS_FAIL | **0** |
| 4 | SUPABASE_DEPENDENCY | **7** |
| 5 | INTERNAL_BLOCKED | **248** |
| 6 | EXTERNAL_BLOCKED | **167** |
| 7 | NOT_RETESTED_POST_CUTOVER | **707** |

Live/non-N/A = 1,136. N/A = 285 (excluded from the live buckets; `post_cutover_status=N/A`).

Frozen prior `result` totals remain **714 PASS / 1 FAIL / 421 BLOCKED / 285 N/A**.

Classification rule:

- `N/A` stays out of live counts.
- Only physically proven production AWS actions become `AWS_PASS`.
- Prior staging PASS is **not** auto-promoted to `AWS_PASS`.
- Prior BLOCKED stays `INTERNAL_BLOCKED` or `EXTERNAL_BLOCKED` unless the live production code path still depends on Supabase.
- `A8-035` prior `result` stays **FAIL**; `post_cutover_status` is **AWS_PASS**.

### AWS_PASS (7)

| ID | Control | Production evidence |
|---|---|---|
| A8-031 | Login Email | FA admin typed email on `/login` → Cognito `/prep/auth/login` |
| A8-032 | Login Password | Same session; no Supabase Auth |
| A8-035 | Sign in with password | Prior `identity_not_linked` cleared; `/prep/identity/me` linked FA admin, tenant Freedom Adjustment, role admin; refresh/logout/relogin OK |
| A5-001 | Payment History tab | `/freedom/payments` history loaded via `/prep` RDS reads |
| CC-268 | Settings Profile | `/freedom/settings` Profile loaded |
| CC-304 | Check search | Freedom queue loaded; check #9562 / $9984.11 located via RDS |
| CC-320 | Review tab | Check `623442f0-a408-4db5-85be-14bae231a722` payees + endorsements via `/prep/data/query` |

Not marked AWS_PASS: Add Payee, Save, CheckAlt submit, deposit, Add funds, Test connection, or any money-moving control.

### AWS_FAIL (0)

No live inventory item is an AWS-native path that was executed and failed. Leftover Supabase URL concatenations are `SUPABASE_DEPENDENCY`, not `AWS_FAIL`.

### SUPABASE_DEPENDENCY (7)

| ID | Prior result | Workflow |
|---|---|---|
| X-020 | PASS | Email unsubscribe page |
| A5-305 | BLOCKED_PROVIDER | Moov KYC / verification upload chrome |
| A5-306 | BLOCKED_PROVIDER | Document type |
| A5-307 | BLOCKED_PROVIDER | Business representative |
| A5-308 | BLOCKED_PROVIDER | File input |
| A5-309 | BLOCKED_PROVIDER | Upload chrome |
| A5-310 | BLOCKED_PROVIDER | Upload chrome |

### INTERNAL_BLOCKED (248) / EXTERNAL_BLOCKED (167)

Same prior BLOCKED population except A5-305–A5-310, which moved from `BLOCKED_PROVIDER` (external) into `SUPABASE_DEPENDENCY` because the live SPA still builds a Supabase functions URL.

External remainder: provider / email / OTP / identity blockers that were not retested and are not the leftover Supabase XHR/GET paths.

## 8. Exact remaining Supabase-dependent workflows

### Live user-facing (SPA)

1. **Email unsubscribe (`X-020`)**  
   `src/pages/Unsubscribe.tsx` GET `${VITE_SUPABASE_URL}/functions/v1/handle-email-unsubscribe`.  
   `production-aws` blanks that env, so the browser calls `https://checksops.com/functions/v1/handle-email-unsubscribe` (CloudFront returns the SPA). Confirm uses `supabase.functions.invoke` (AWS adapter → `/prep/functions/v1/handle-email-unsubscribe`). Class A handler exists; the live GET never reaches it.

2. **Moov KYC / verification file upload (`A5-305`–`A5-310`)**  
   `src/lib/payments/verificationFiles.ts` XHR POST `${VITE_SUPABASE_URL}/functions/v1/moov-account-file-upload` plus anon `apikey`.  
   Live bundle compiles to `POST /functions/v1/moov-account-file-upload` on the frontend origin (CloudFront XML `BadRequest`), not `/prep/functions/v1/moov-account-file-upload` (provider catalog + OPTIONS 204). Does not block an already-verified FA payment account.

### Display-only / N/A (not in live counts)

3. **Zapier integration copy (`A4-225`–`A4-227`, prior N/A)**  
   `ZapierIntegrationSettings.tsx` prints `POST {VITE_SUPABASE_URL}/functions/v1/automation-webhook` and `inbound-email`. Blank on this build. Not a daily check/payment button.

### Dead on this production-aws browser build (not live Supabase)

- `src/integrations/supabase/client.ts` exports `createAwsStagingClient()` when `VITE_AUTH_PROVIDER=cognito`.
- `src/lib/publicWorkflowApi.ts` hardcoded `PRODUCTION_SUPABASE_URL` is unused because `isAwsStaging()` is true; public sign/endorse go to `/prep/public/*`.
- Live public JS contains **zero** `supabase.co` / `nbcqwpysqgyxrrbgtmkw` hosts.
- Supabase Auth, JS REST/RPC, Storage, and Realtime are not the browser data path. Realtime is a noop + polling fallback.

### Server / ops (do not retire Supabase yet)

4. **Disabled legacy Moov webhook record** `kvwhhewoyjgpjalbtrygzu2geu_whook` → `https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1/moov-webhook` remains **disabled**. Live Moov hook is AWS `jwjuxiowcjachnon3i37osimti_whook` → `https://checksops.com/prep/webhooks/moov` **enabled**. Do not re-enable the Supabase hook.

5. **CheckAlt inbound webhook** — there is no production `checkalt-webhook` Edge Function. Status is poll + history on AWS. `POST /prep/webhooks/checkalt` exists. Not a live SPA Supabase call.

6. **Hosted Supabase `pg_cron` / Edge jobs** still exist on the **old** Supabase database (`process-email-queue`, `check-ocr-backlog`, domain recheck, partner push, etc.). They do **not** process new AWS RDS writes. Production Lambda has **no** `AWS_SCHEDULED_JOB_SECRET`. EventBridge/Scheduler list is denied to this role; absence of the scheduled-job secret is enough to treat production AWS cron as **not wired**. Interactive OCR/intake still goes `/prep/functions/v1/check-ocr-intake`.

7. **Ops bridges / copy tools** (`aws-staging-db-bridge`, `aws-staging-storage-bridge`, `aws/storage/copy-from-supabase.mjs`) still reference `nbcqwpysqgyxrrbgtmkw.supabase.co`. Operator-only. Not SPA.

8. **`.env.production`** still has Supabase URL/key for the *non*-`production-aws` Vite mode. Guarded deploy uses `.env.production-aws`. Wrong build mode would re-enable a Supabase SPA.

## 9. Exact production buttons/actions that still require repair

Do not treat the 707 NOT_RETESTED or 415 remaining BLOCKED rows as automatic repair tickets.

**Repair now (broken leftover Supabase URL on the live SPA):**

| ID | Button / action | What is wrong |
|---|---|---|
| X-020 | Unsubscribe “from ChecksOps emails.” / Confirm unsubscribe | GET uses blanked `VITE_SUPABASE_URL`; never hits `/prep` |
| A5-308 + A5-305/309/310 | VerificationDocumentsPanel file + Upload document | XHR posts to origin `/functions/v1/moov-account-file-upload` instead of `/prep/functions/v1/moov-account-file-upload` |
| A5-306 / A5-307 | Document type / representative | Same broken upload form |

**Repair only if product still wants the surface (N/A, not live):**

| ID | Button / action | What is wrong |
|---|---|---|
| A4-225–A4-227 | Zapier URL / Test / Browse Zapier Apps | Displayed automation endpoint is blank / Supabase functions host |

**Not repair in this pass (AWS path exists or intentionally gated; do not execute for audit):**

- CheckAlt submit / status poll, Ready for Deposit submit, Moov transfer, Add funds, disbursement, payroll, funding — provider flags ON; **not retested**; money movement forbidden.
- `deposit_action` and other financial-sensitive RPCs remain `rpc_disabled` — deposit-ops console buttons stay INTERNAL_BLOCKED.
- `disbursement_splits` / some role/billing tables are absent from the browser write allowlist — INTERNAL_BLOCKED if those buttons persist.
- Production Class A cron (email queue, OCR backlog) is not scheduled — notifications/backlog sweep, not the interactive intake button.

## 10. Does anything remaining block normal check processing or payment operations?

**No.** Remaining issues do **not** block normal check processing or normal (non-movement) payment operations for a linked Freedom admin.

Trace for the proven path:

`UI (login / queue / Review / payments / wallet / settings) → /prep/auth|/identity|/data/query|/functions/v1/* → checksops-production-prep-api → RDS (and S3 via FILES_BUCKET) → expected read result`

Covered domains (current post-cutover state):

| Domain | State |
|---|---|
| Login / identity | AWS_PASS for FA admin password login |
| Check queue / search / Review read | AWS_PASS for viewed Freedom #9562 |
| Payees / endorsements **display** | Proven on #9562; add/edit NOT_RETESTED / INTERNAL_BLOCKED |
| Images / OCR | AWS adapter + Class A `check-ocr-intake`; not re-executed; backlog cron not on AWS |
| Endorsing / public sign links | `/prep/public/*` + Class A; NOT_RETESTED |
| Ready for Deposit / CheckAlt submit | Flags ON; BLOCKED_UNSAFE / NOT_RETESTED; **do not submit** |
| CheckAlt status | AWS poll path; inbound webhook is not a Supabase Edge Function |
| Mortgage | Adapter + SAFE_WRITE_RPCS; NOT_RETESTED / INTERNAL_BLOCKED |
| Moov / wallet **view** | History + wallet page loaded; refresh/funding controls not marked AWS_PASS |
| Payments / disbursements / funding | View OK; movement forbidden and not tested |
| Homeowner / claim settlement | AWS Class A routes exist; mostly NOT_RETESTED / INTERNAL_BLOCKED |
| Users / roles / tenant settings | Profile AWS_PASS; mutations mostly BLOCKED |
| Integrations | Zapier leftover display; Moov webhook is AWS |
| Documents / storage | `/prep/storage/*` → S3 `checksops-staging-privatefilesbucket-erzqsolpucjp` (production copy destination name); NOT_RETESTED for new upload |
| Notifications | Unsubscribe broken; SES/email queue cron not on production Lambda |

Prior FAIL `A8-035` no longer blocks production sign-in. The ninth unlinked Cognito UUID is unchanged and is not this inventory’s FA admin path.

## Safety held

- No CheckAlt deposit, Moov transfer, payment, disbursement, or funding initiated.
- No production financial-row edits to force a PASS.
- Cognito mappings and production deploy guardrails untouched.
- Legacy Supabase Moov webhook left disabled.
- Supabase not retired.

## Next (not started)

Do not begin broad repairs. When repairs start, the first two are `Unsubscribe.tsx` GET → `/prep/functions/v1/handle-email-unsubscribe` and `verificationFiles.ts` XHR → `/prep/functions/v1/moov-account-file-upload`. Then a targeted production retest of NOT_RETESTED write paths that are allowlisted and non-financial.
