# Remaining live Supabase dependencies (issue #811)

**REMOVAL NOT AUTHORIZED.** This is a read-only inventory. It does not remove the AWS-backed compatibility interface, merge other PRs, deploy, or change database / API / auth / payment behavior.

Wait until **Review-to-Endorsing** (`needs_review` → `endorsing`) and **staging 503 diagnostics** are stable before even proposing removal. Hypothetical waves below are not a work order.

Machine-readable file-by-file list (risk, owner, production/staging class, removal wave):  
`aws/providers/results/supabase_remaining_live_inventory.json`

Scanner + tests: `aws/providers/lib/supabase-runtime-inventory.mjs`, `aws/tests/supabase-remaining-live-inventory.test.mjs`.

Prior workstream audits are **not** overwritten:

- `aws/providers/results/supabase_runtime_dependency_audit.md`
- `aws/providers/results/supabase_runtime_dependency_audit_final.md`
- `aws/frontend/SUPABASE_FRONTEND_INVENTORY.md`

## Classification

| Class | Meaning |
|---|---|
| `live_runtime` | Network or process talks to hosted Supabase (Auth, PostgREST, Storage, Edge, or `*.supabase.co`) |
| `compatibility_alias` | Same `supabase.*` API, but AWS adapter / Cognito / API Gateway / S3 |
| `test` | CI, offline tests, migration rehearsal scripts |
| `dead_code` | No live traffic on that environment (parser, installer metadata, unset env) |
| `documentation` | Markdown only |

`getSession()`:

| Environment | Backend | Token | `user.id` |
|---|---|---|---|
| Production SPA (`.env.production`, no Cognito) | **supabase_auth** (`/auth/v1`) | Supabase JWT | `auth.users` UUID |
| Staging / AWS build (`VITE_AUTH_PROVIDER=cognito`) | **cognito_via_aws_adapter** (`/auth/refresh` + `/identity/me`) | Cognito ID token | ChecksOps UUID from `identity_accounts` — never Cognito `sub` |

## Production vs staging (this revision)

| Surface | Production (Lovable / `.env.production`) | Staging AWS (`vite --mode aws`) |
|---|---|---|
| SDK init | `createClient(VITE_SUPABASE_URL, …)` | `createAwsStagingClient()` |
| Auth `getSession` | Hosted Supabase Auth | Cognito session store |
| `.from` / `.rpc` | PostgREST | `/data/query`, `/data/rpc`, `/data/write` |
| `storage.from` | Supabase Storage | S3 via `/storage/*` |
| `functions.invoke` | `https://<ref>.supabase.co/functions/v1/*` | AWS `/functions/v1/*` (or CheckAlt AWS path) |
| Realtime | Supabase Realtime | No-op channel + polling |
| Edge functions tree | **161 live** hosted functions | Not used by SPA; only migration bridges still call hosted Supabase |

Scanner summary (regenerate with the scanner; snapshot must match tests):

| Env | live_runtime | compatibility_alias | test | dead_code | documentation |
|---|---:|---:|---:|---:|---:|
| Production | 541 | 3 | 93 | 5 | 19 |
| Staging | 9 | 229 | 86 | 318 | 19 |

## Read-only deployed evidence

This sandbox could not resolve `checksops.com` / `staging.checksops.com` (DNS blocked). No deploy, no inspector role assume, no database connection.

**Production inspector** (authorized GitHub workflow, read-only OIDC):

- Workflow: `Inspect production (read-only)` run `37807286667` on `main` (`fd6fb639…`), **success** at 2026-10-08T16:15Z
- Artifact: `production-readonly-evidence-fd6fb6392aa8413627486fc02126f2047abaf1f6-37807286667-1`
- Target is **AWS production-prep**, not hosted Supabase: Lambda `checksops-production-prep-api`, API `kiqojucc02` stage `prep`, bucket `checksops-production-frontend-806168576068`, CloudFront `E1B0ZWWO5559U5`
- SPA lock comparison **matches** entry `/assets/index-CBOwj-7W.js`
- `database.status`: `refused_unproven_aws_production_target` — inspector does **not** open SQL
- This fingerprints the AWS prep frontend/API. It does **not** prove apex DNS has left Lovable. `aws/production/LIVE_RESOURCES.md` still records apex/`www` at `185.158.133.1`.

**Staging SPA inspect:** last success run `37660877360` (2026-10-07). **Staging DB 503 diagnostic workflow** (`staging-db-readonly-diagnostic.yml`): **0 runs** — diagnostics are **not** live-stable. Offline contract tests exist (`aws/tests/staging-db-readonly-diagnostic.test.mjs`); HTTP 503 is the expected non-OK contract, not a license to strip Supabase.

## SDK initialization

| File | Production | Staging | Owner | Risk | Tests |
|---|---|---|---|---|---|
| `src/integrations/supabase/client.ts` | `live_runtime` `createClient` | `compatibility_alias` `createAwsStagingClient` | identity-cognito | high | this inventory + aws adapter tests |
| `src/integrations/supabase/mortgageClient.ts` | `live_runtime` (storageKey `sb-mortgage-ops-auth`) | `compatibility_alias` (mortgage Cognito key) | identity-cognito | high | same |
| `src/integrations/aws/client.ts` | `compatibility_alias` (must not ship as prod `.env.production`) | `compatibility_alias` | identity-cognito | high | `aws/tests/supabase-remaining-live-inventory.test.mjs` |
| `src/integrations/aws/storage.ts` | alias | alias | identity-cognito | medium | `aws/tests/api-storage.test.mjs` |
| `src/lib/backendMode.ts` | hostname + `VITE_AUTH_PROVIDER=cognito` | AWS | identity-cognito | medium | inventory |
| `vite.config.ts` | loads `VITE_SUPABASE_*` | **fails closed** if those env vars are set in `mode=aws` | frontend-compat | high | inventory + spa bootstrap |

**Do not delete** the dual client. Production `.env.production` is still Supabase-only (`VITE_AUTH_PROVIDER` must not be `cognito`). `.env.aws.example` must not set `VITE_SUPABASE_URL`.

## Env vars

| Name | Where | Production | Staging AWS |
|---|---|---|---|
| `VITE_SUPABASE_URL` | `.env.production` → `https://nbcqwpysqgyxrrbgtmkw.supabase.co` | **live** | unset (forbidden in aws mode) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | `.env.production` | **live** browser anon key | unset |
| `VITE_SUPABASE_PROJECT_ID` | `.env.production` `nbcqwpysqgyxrrbgtmkw` | **live** | unset |
| `VITE_AUTH_PROVIDER` | `.env.aws.example` `cognito` | absent | **live AWS** |
| `VITE_CHECKSOPS_API_URL` | aws example execute-api `/staging`; prod aws example `/prep` | not in `.env.production` | **live AWS** |
| `VITE_COGNITO_USER_POOL_ID` | staging `us-east-1_vPmQ7cL1F`; prod pool `us-east-1_h00WorYMT` prepared | not in `.env.production` | **live AWS** |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | Deno edge functions | **live** hosted | unused by AWS Lambda |
| `SUPABASE_ACCESS_TOKEN` | `.env.example` placeholder | tooling only | tooling only |

## Direct hosts and browser fetches (genuine Supabase traffic)

These bypass the adapter when `VITE_SUPABASE_URL` is set.

| File | Call | Production | Staging | Owner | Risk |
|---|---|---|---|---|---|
| `src/lib/publicWorkflowApi.ts` | Hardcoded host `nbcqwpysqgyxrrbgtmkw.supabase.co` + `/functions/v1/{get-signature-document,submit-signature,check-endorsement}` gated by `!AWS_BUILD` | `live_runtime` | AWS `/public/*` | frontend-compat | high |
| `src/pages/Unsubscribe.tsx` | `fetch(${VITE_SUPABASE_URL}/functions/v1/handle-email-unsubscribe)` **and** `functions.invoke` | `live_runtime` | invoke → alias; raw fetch URL unset (**dead**/broken extra path) | frontend-compat | high |
| `src/lib/payments/verificationFiles.ts` | `getSession()` then XHR `VITE_SUPABASE_URL/functions/v1/moov-account-file-upload` | `live_runtime` (auth + edge) | `getSession` is Cognito; XHR URL unset | financial-ledger | high |
| `src/components/settings/ZapierIntegrationSettings.tsx` | Displays `VITE_SUPABASE_URL/functions/v1/automation-webhook` (copy/paste, not fetch) | live URL in UI | blank URL | frontend-compat | medium |
| `src/lib/storagePath.ts` | Comment + parser for leftover `…supabase.co/storage/v1/object/sign/…` paths | `dead_code` | `dead_code` | frontend-compat | none |

Hardcoded `*.supabase.co` also appears in migration scripts, tests, and docs (classified `test` / `documentation`). Project ref in this repo is `nbcqwpysqgyxrrbgtmkw` only.

## `getSession()` file-by-file

| File | Production | Staging | Owner | Risk |
|---|---|---|---|---|
| `src/integrations/aws/client.ts` | alias implementation | **cognito_via_aws_adapter** (`restoreSession` → `/auth/refresh`) | identity-cognito | high |
| `src/hooks/useAuth.tsx` | **supabase_auth** | cognito_via_aws_adapter | frontend-compat | medium |
| `src/hooks/useMortgageAuth.tsx` | supabase_auth (mortgage storage key) | cognito_via_aws_adapter | frontend-compat | medium |
| `src/hooks/useSessionSecurity.tsx` | supabase_auth | cognito_via_aws_adapter | frontend-compat | medium |
| `src/hooks/useStepUp.tsx` | supabase_auth (MFA) | Cognito MFA stub (`aal1`) | frontend-compat | medium |
| `src/pages/Auth.tsx` | supabase_auth sign-in | Cognito `/auth/login` | frontend-compat | medium |
| `src/pages/checkops/CheckOpsResetPassword.tsx` | supabase_auth | Cognito forgot/confirm | frontend-compat | medium |
| `src/pages/HomeownerCheckUpload.tsx` | supabase_auth / OTP | AWS OTP (no SPA session) | frontend-compat | medium |
| `src/pages/CheckCommandCenter.tsx` | supabase_auth | cognito_via_aws_adapter | frontend-compat | medium |
| `src/pages/admin/AdminDbValidator.tsx` | supabase_auth | cognito_via_aws_adapter | frontend-compat | medium |
| `src/pages/admin/AdminFinancialModel.tsx` | supabase_auth | cognito_via_aws_adapter | financial-ledger | medium |
| `src/pages/admin/AdminTenants.tsx` | supabase_auth | cognito_via_aws_adapter | frontend-compat | medium |
| `src/components/admin/TenantManagementV2Dashboard.tsx` | supabase_auth | cognito_via_aws_adapter | frontend-compat | medium |
| `src/components/check-review/EndorsementChecklist.tsx` | supabase_auth | cognito_via_aws_adapter | frontend-compat | medium |
| `src/components/check-review/InPersonSignatureDialog.tsx` | supabase_auth | cognito_via_aws_adapter | frontend-compat | medium |
| `src/lib/payments/verificationFiles.ts` | supabase_auth **then** hosted function XHR | mixed (see above) | financial-ledger | high |
| `aws/tests/tenant-management-v2.test.mjs` | `test` | `test` | aws-migration-ci | none |

UI files import `@/integrations/supabase/client` (or mortgage client). They do **not** construct a second `createClient`. Staging traffic is therefore Cognito, not `/auth/v1`.

## Database, storage, functions, realtime

| Kind | Production | Staging | Notes |
|---|---|---|---|
| Table `.from` | PostgREST live | `/data/query` allowlist; writes allowlisted or `writes_disabled` | Keep UI; do not delete call sites |
| `.rpc` | Hosted RPCs | `/data/rpc` allowlist / workflow RPC | Review-to-Endorsing is AWS workflow, not Supabase |
| Storage | `claim-files`, `company-branding`, `tenant-logos`, `deposit-attachments`, `loss-draft-documents`, `endorsement-packets`, `homeowner-uploads` | S3 presign; uploads gated | Production storage still hosted |
| `functions.invoke` | 161 Deno functions | AWS `/functions/v1/:name` or `provider_disabled` | Class B/C stay disabled |
| Realtime `.channel` | hosted | stub | polling waiver already documented |

## Staging-only remaining **live** Supabase (9 files)

These still target hosted Supabase for migration, not the SPA:

| File | Role | Owner | Risk |
|---|---|---|---|
| `supabase/functions/aws-staging-db-bridge/index.ts` | Read-only hosted DB bridge | migration-bridges | high |
| `supabase/functions/aws-staging-storage-bridge/index.ts` | Sign-only storage bridge | migration-bridges | high |
| `aws/db-copy/lib/db-bridge.mjs` | Client for db-bridge | migration-bridges | high |
| `aws/storage/copy-from-supabase.mjs` | Copy objects from hosted storage | migration-bridges | high |
| `aws/db-copy/rehearsal/scripts/bridge-db-rehearsal.mjs` | Rehearsal | migration-bridges | medium |
| `aws/db-copy/rehearsal/scripts/bridge-storage-copy.mjs` | Rehearsal | migration-bridges | medium |
| `aws/cutover/scripts/bridge-teardown-dry-run.mjs` | Teardown dry-run (must not `--apply`) | migration-bridges | medium |
| `aws/db-copy/sql/03_inspect_supabase_dependencies.sql` | Inspect SQL | migration-bridges | low |
| `aws/db-copy/rehearsal/analysis/db_bridge_reconcile.json` | Evidence | migration-bridges | none |

`aws/cutover/BRIDGE_TEARDOWN.md` still says **DO NOT TEAR DOWN NOW**.

## Edge functions (production live / staging dead except bridges)

161 function directories under `supabase/functions/` (excluding `_shared`). Production: **live_runtime**. Staging SPA: **dead_code** (invoke goes to AWS). Owner `lovable-edge` unless financial.

Highest-risk hosted names (do not enable on AWS as a shortcut): Moov money movement, CheckAlt deposit submit/approve, Plaid transfer, Stripe/tenant-checkout, `homeowner-deductible-pay`. See `aws/providers/EDGE_FUNCTION_INVENTORY.md` classes A–E (not modified).

Temporary production-hosted bridges (`aws-staging-db-bridge`, `aws-staging-storage-bridge`) stay until an approved teardown.

## Dead code (safe to *list*, not to delete in this PR)

| File | Why |
|---|---|
| `src/lib/storagePath.ts` | Parses historic Storage URLs; no network |
| `.env.example` | Empty placeholders |
| `.env.production.aws.example` | **DO NOT USE YET** |
| `supabase.json` / `supabase-beta.json` | CLI installer metadata, not app runtime |

Soft `organizations` UI remains a staging-dead table path in the older Class A audit — still not removed here.

## Safe incremental removal order (**not authorized**)

Wave **0** must never run until cutover + Review-to-Endorsing + staging 503 diagnostics are stable:

0. **Keep** AWS compatibility interface (`src/integrations/aws/*`, dual `client.ts` / `mortgageClient.ts`, `publicWorkflowApi` AWS branch).
1. Docs and tests only (this inventory).
2. Confirmed `dead_code` on **both** envs (parser/metadata) after a human review.
3. Hosted edge functions already replaced on staging (Class A), only after 503 diagnostic workflow has a green live run and bridges are still up.
4. Production `.env.production` / Lovable DNS / Auth / Storage / webhooks — cutover decision, not this issue.

## Tests

| Test | What it proves |
|---|---|
| `aws/tests/supabase-remaining-live-inventory.test.mjs` | Dual client, Cognito `getSession`, no adapter `supabase.co`, env split, snapshot counts, UI imports shared client, removal flag false |
| `aws/tests/cutover-readiness.test.mjs` | `.env.production` stays Supabase-only |
| `aws/tests/aws-production-spa-bootstrap.test.mjs` | AWS SPA build must not embed Supabase |
| `aws/tests/staging-db-readonly-diagnostic.test.mjs` | 503 contract is offline-tested; not a live pass |
| `aws/tests/api-workflow.test.mjs` | Review-to-Endorsing ledger freeze |

Run: `node --experimental-strip-types --test aws/tests/supabase-remaining-live-inventory.test.mjs`

## Workstream guard

CODEOWNERS / release-locks own the adapter, Cognito, financial, and webhook paths (`@michaelcarletta-cmd`). This change adds only `aws/providers/lib/`, `aws/providers/results/supabase_remaining_live_inventory.*`, and `aws/tests/supabase-remaining-live-inventory.test.mjs`. No overlay, no SQL apply, no SPA promote.
