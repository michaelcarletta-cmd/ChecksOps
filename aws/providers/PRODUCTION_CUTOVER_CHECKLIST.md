# Production provider cutover checklist

**Current verdict: BLOCKED for executing production cutover.**  
**Moov sandbox: PASS (PR #124). CheckAlt: PARTIAL (separate chat; do not modify #125/#130).**  
**Data/storage rehearsal: GO (PR #127).** Production execution flags remain **false**.

Authoritative matrix + night-of runbooks: `aws/cutover/CUTOVER_READINESS_MATRIX.md` and `aws/cutover/FINAL_PRODUCTION_CUTOVER_RUNBOOK.md`.

Historical sections below still describe provider UAT gates. When they conflict with the 2026-09-05 matrix (for example older “Moov NO-GO / no NAT” lines), **use the matrix**.

This checklist is the current handoff for provider cutover readiness after PRs #102 and #103. Older Tranche 4 and UAT result documents are historical evidence; when they conflict with this checklist, use the newer code/parity state and re-prove live AWS/provider gates before production approval.

Production ChecksOps stays on Lovable/Supabase until every required gate below is proven and explicitly approved.

## Safety state that must remain true

- [x] Production provider execution remains disabled in AWS
- [x] `AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false`
- [x] Production DNS has not been redirected to AWS
- [x] Production provider webhooks have not been redirected to AWS
- [x] Production Moov / CheckAlt identifiers are not reused for sandbox/UAT validation
- [x] AWS sandbox/UAT provider rows remain isolated from production financial rows
- [ ] Production activation approval granted — **NO**

Do not apply `64_financial_activation_grants.sql` before explicit production-cutover approval.

## Frontend / DNS

- [ ] Re-confirm production DNS still points at the existing Lovable/Supabase production frontend immediately before cutover planning
- [ ] Re-confirm production frontend still uses the existing production auth/provider path until cutover
- [x] AWS frontend has a Cognito/AWS API path for staging validation
- [ ] Run final frontend contract regression against every production-required Moov and CheckAlt function after live provider validation
- [ ] Prepare production frontend env switch to Cognito + AWS API Gateway, but do not deploy it yet

## Provider function parity

The original Lovable/Supabase Edge Functions remain the behavioral reference implementation. See `LOVABLE_AWS_PROVIDER_PARITY.md`.

- [x] AWS function names exist for the production-required Moov and CheckAlt functions inventoried in the parity audit
- [x] CheckAlt authentication contract uses `/public/fincapture/authenticate` with `{ userName, password }`
- [x] CheckAlt depositor identity is separated from the API login
- [x] CheckAlt `userAmount` remains integer cents
- [x] Moov production-parity transfer semantics preserve the facilitator transfer path and pinned `v2024.01.00` behavior where used by the original client
- [x] Staging `functions.invoke` accepts normal successful 2xx Supabase-style envelopes
- [ ] Re-run full unit/provider parity suite from the final pre-cutover commit
- [ ] Record the final passing test count and commit SHA

No single sandbox transfer or UAT deposit is sufficient to mark a provider GO.

## AWS staging network / runtime gates

- [ ] Authenticate to AWS staging and positively verify the intended staging account/role
- [ ] Deploy or verify the dedicated staging NAT/private route configuration already represented in the AWS staging code
- [ ] Prove `checksops-staging-api` provider egress from the Lambda itself, not from a no-VPC sidecar or developer VM
- [ ] Prove Lambda can reach Moov sandbox HTTPS
- [ ] Prove Lambda can reach `https://uatapi.checkalt.com`
- [ ] Confirm RDS remains private after NAT/route changes
- [ ] Confirm the public/main VPC route table was not replaced

Historical UAT evidence showed the staging Lambda had no NAT and returned `503 provider_egress_failed`; that remains a blocker until re-tested live.

## Moov sandbox gates

Staging already has sandbox client credentials. The remaining identity/payment-method mapping must be created or supplied in the sandbox environment only.

- [x] `MOOV_SANDBOX_PUBLIC_KEY` present in staging Secrets Manager (historical UAT evidence)
- [x] `MOOV_SANDBOX_SECRET_KEY` present in staging Secrets Manager (historical UAT evidence)
- [ ] Re-confirm sandbox keys are still present after AWS access is restored
- [ ] Configure or derive `MOOV_SANDBOX_PLATFORM_ACCOUNT_ID` from a genuine sandbox account context
- [ ] Configure/use a genuine `MOOV_SANDBOX_CONNECTED_ACCOUNT_ID`, or create one only if the sandbox key has `/accounts.write`
- [ ] Resolve sandbox wallet/payment methods using account-specific scopes
- [ ] Confirm `wallet.partnerAccountID` resolves the sandbox facilitator
- [ ] Confirm sandbox platform/connected IDs do not equal production IDs
- [ ] Execute a real sandbox $0.01 transfer using the production-shaped facilitator path
- [ ] Retrieve the sandbox transfer by provider ID
- [ ] Prove ChecksOps idempotent retry does not create a duplicate provider object
- [ ] Prove provider-side idempotency/duplicate behavior where Moov sandbox permits it
- [ ] Validate the transfer/status database side effects against the original Supabase behavior

`GET /accounts` is diagnostic only and must not be treated as the production money-path gate.

## CheckAlt UAT gates

Dedicated CheckAlt UAT API credentials and the approved UAT host are configured historically. A FinCapture depositor registration is still required.

- [x] Dedicated `CHECKALT_UAT_*` API credentials were present in staging Secrets Manager during prior UAT
- [x] UAT host is restricted to `https://uatapi.checkalt.com`
- [x] Approved merchant header is `lockbox5`
- [x] API authentication previously succeeded through the FinCapture authentication path
- [ ] Re-confirm UAT credentials after AWS access is restored
- [ ] Obtain a CheckAlt-approved UAT deposit account number — do not invent one and do not copy production
- [ ] Register a UAT FinCapture depositor distinct from the API login
- [ ] Obtain/confirm the depositor `ssoKey` via register / `getUserAccountInformation`
- [ ] Persist the UAT depositor only in the isolated AWS sandbox/UAT tables
- [ ] Verify UAT user/account lookup uses the registered depositor identity
- [ ] Execute UAT amount validation at 1 / 100 / 12345 integer cents when the provider environment permits
- [ ] Execute a real UAT deposit with provider-approved non-production test data/images
- [ ] Retrieve/poll the UAT deposit status
- [ ] Exercise approve/reject only if supported by the UAT test scenario
- [ ] Prove retry/idempotency does not create an unintended duplicate deposit
- [ ] Validate CheckAlt database/status side effects against the original Supabase behavior

The API login must never be substituted as `ssoKey` for a deposit.

## Image handling gates

- [x] AWS has the CheckAlt image normalization path and under-budget fast path in code
- [x] Oversized/front/rear/under-limit image handling has unit coverage from prior migration work
- [ ] Re-run image tests from the final pre-cutover commit
- [ ] Prove at least one provider-approved UAT front/rear image pair through the live CheckAlt UAT path

## Sandbox/UAT webhooks

Production webhook URLs remain on the existing production implementation until shadow/dual-run approval.

- [ ] Configure `MOOV_SANDBOX_WEBHOOK_SECRET` on staging if Moov sandbox signed webhook validation is required
- [ ] Configure `CHECKALT_SANDBOX_WEBHOOK_SECRET` on staging if CheckAlt UAT signed webhook validation is supported/required
- [x] Signature/duplicate/spoofed-tenant protections have unit coverage
- [x] Sandbox webhook storage/apply is isolated from production rows
- [ ] Prove a real signed Moov sandbox webhook from the staging endpoint
- [ ] Prove a real signed CheckAlt UAT webhook if CheckAlt exposes one in UAT; otherwise document polling as the provider-supported test limitation
- [ ] Prove duplicate event delivery is idempotent with real event IDs
- [ ] Prove tenant mapping is derived from trusted provider/account mapping, never payload tenant IDs
- [ ] Validate resulting sandbox/UAT ledger/status application against the original production semantics

Do not redirect production webhook URLs merely to complete this gate.

## Database / authorization / reconciliation

- [ ] Apply `62_sandbox_financial_apply_grants.sql` on staging only if it has not already been applied and the live staging test requires it
- [ ] Do **not** apply `64_financial_activation_grants.sql`
- [ ] Re-run tenant/auth/RLS isolation tests
- [ ] Re-run provider authorization tests for deposit, disbursement, ACH/RTP/wallet transfer, stakeholder payment, and provider configuration
- [ ] Capture financial aggregates immediately before live sandbox/UAT provider validation
- [ ] Capture the same aggregates immediately after validation
- [ ] Confirm zero unintended drift in production/restored financial rows
- [ ] Confirm sandbox/UAT objects are isolated and reconcilable
- [ ] Confirm report-only reconciliation has no unexplained findings

## Production secrets (future approval only)

Do not copy staging secrets into production merely because staging passes.

| Secret | Staging validation | Production cutover later |
| --- | --- | --- |
| Moov public/secret keys + platform account | Sandbox keys/IDs only | Production keys/IDs from the existing production integration or approved replacement secret |
| Moov webhook signing secret | Sandbox secret only | Production signing secret for the AWS production endpoint |
| CheckAlt FI key / API login | UAT credentials | Production FinCapture credentials |
| CheckAlt depositor registrations | UAT-only isolated rows | Production tenant registrations/mapping, migrated only through an approved plan |
| CheckAlt webhook secret | UAT/sandbox only if supported | Production secret if provider supports signing |
| Plaid | **Not required for ChecksOps** — keep disabled; not a cutover blocker | N/A |

## Production webhook / DNS cutover prerequisites

Before flipping any production URL:

1. Every production-required provider function has a verified AWS equivalent.
2. Live staging/UAT provider validation passes where the provider test environment permits.
3. Database side effects and frontend contracts are verified.
4. Real-event idempotency/shadow delivery is proven or the provider limitation is explicitly documented and accepted.
5. Rollback is tested and documented.
6. Production secrets are loaded into a separate approved production secret set.
7. Production execution/financial flags are activated only in the approved order.
8. DNS/frontend/webhook changes occur only during the approved cutover window.

## Current GO / NO-GO

| Gate | Status | Current blocker |
| --- | --- | --- |
| Moov sandbox | **PASS** | Production `AWS_MOOV_ENABLED` still false; production keys/webhook dual-run outstanding |
| CheckAlt | **PARTIAL** | Separate chat (PR #125/#130). Production `AWS_CHECKALT_ENABLED` false |
| Data/storage rehearsal | **GO** | Final production delta not executed; bridges remain |
| AWS ChecksOps overall (execute cutover) | **BLOCKED** | See `aws/cutover/CUTOVER_READINESS_MATRIX.md` |

## STOP conditions

Stop immediately and do not activate production if any of the following occurs:

- AWS identity/account/role cannot be positively verified
- a sandbox/UAT credential resolves to a production provider object
- RDS becomes public or routing changes expose unintended resources
- provider validation requires inventing/copying production account/bank/customer identifiers
- financial aggregates drift unexpectedly
- a live provider call produces an unexplained side effect
- any production execution flag changes before explicit approval
- DNS or production webhook routing changes before explicit approval

Until every required gate in `aws/cutover/CUTOVER_READINESS_MATRIX.md` is resolved, the verdict remains **BLOCKED for executing production cutover**. Moov sandbox is PASS; CheckAlt stays PARTIAL on a separate track.
