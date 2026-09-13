# ChecksOps coherent Git integration — 2026-09-13

**Workstream:** sole ChecksOps Integration & Release  
**Deploy this turn:** NO (shared staging, production, and production-prep untouched)  
**Real SES:** not sent  
**Provider execution:** remains fail-closed (`AWS_PROVIDER_EXECUTION_ENABLED=false`)  
**SQL apply this turn:** none (including SQL 30)

## Verdict

| Gate | Result |
|---|---|
| Git integration build | **PASS** |
| One authorized coherent staging deployment | **NOT READY** |

NOT READY because required operator SQL is still unapplied, the staging SPA was not rebuilt, PG16 disposable RLS did not run in this environment, and this turn did not deploy.

---

## Identity

- **Branch:** `cursor/integration-coherent-ec26`
- **PR:** https://github.com/michaelcarletta-cmd/ChecksOps/pull/282
- **Base:** `origin/main` `4fc1166d8206cd7b70b13423b73c2b0b96ba8b5b`
- **Integration source SHA (Lambda zip built from this commit):** `a629a7c8fec65262ef0854e5846dc5c243d7c97a`
- **Canonical mailer SHA:** `186dc3fb89e774290294eb7ec67daf971d8b0c10` (PR #255)
- **Known-good live overlay (rollback only, not a Git SHA):** `ZepKxoHP9PgTaeR0F+o2TpJcE6ot4/NxO2GvLVStjlo=`

---

## Exact merge order actually used

1. Merge PR **#255** `origin/cursor/endorsement-email-audit-ec26` (includes **#248** + **#249**) — clean. Merge commit `8c13028f3`.
2. Merge Functional Audit p3b / PR **#264** `origin/cursor/p3b-claim-number-grant-3bce` — 3 conflicts. Merge commit `034cacc54`.
3. Merge PR **#267** code only `origin/cursor/tenant-documents-mortgage-doc-type-d93c` — 1 conflict. Merge commit `0fd8d96d9`. SQL 30 source is in Git; **not applied**.
4. File-select identity from **#239** + Lineage A homeowner/portal callers. Commit `822d2518d`.
5. Align tests to SQL 71 (no Lineage A INSERT fallback). Commit `4ed0950d3`.
6. Adapt already-present stakeholder resend caller to `deliverAuditedEmail`. Commit `a629a7c8f`.

---

## Conflicts and resolutions

### `aws/functions/api/check-endorsement.mjs`

- **KEEP #255:** `deliverAuditedEmail` / `withDurableAuditClient` / SQL 71 peek-reserve-finalize; public submit/reject via `aws_public_submit_endorsement` / `aws_public_reject_endorsement`; `token_consumed` for missing and `signed|rejected|waived|expired`.
- **ADD p3b:** `persistPhysicalEndorsementOnCheck` (CC-117 atomic Endorsed-on-Check).
- **DO NOT restore** p3b raw `UPDATE public.check_endorsements` on public submit/reject.

### `aws/tests/parity-check-endorsement.test.mjs`

Union: SQL 71 `token_consumed` coverage **and** unused-payee pending GET **and** CC-117 persist tests.

### `src/components/settings/CompanyBrandingSettings.tsx`

Union: p7 `useTenantFilter` + `activeTenantId` isolation with 412 `tenantBranding` helpers. No Freedom placeholders. Platform/master-owner restrictions preserved. Email field remains read-only.

### `aws/functions/api/write-app-metadata.mjs`

Both:

- p3b negative-amount / `isMasterOwner` branding safeguards
- #267 `isAllowedTenantDocumentDocType` allowlist

SQL 30 remains unapplied.

---

## PRs / file-selects included

| Item | How |
|---|---|
| #248 412 frontend + Mortgage Ops deny UX | via #255 merge |
| #249 Mortgage Ops agent access + staff-status denial | via #255 merge |
| #255 canonical mailer / SQL 71 / public token consume | merge |
| #254–#264 functional-audit stack | merge #264 |
| #267 mortgage `doc_type` allowlist (code only) | merge |
| #239 `identity.mjs` + `identity-link.mjs` only | file-select, null-safe linker |
| #231/#233/#235 audited portal/workflow callers, `homeowner-ledger-public.mjs`, SQL 69 source, `/ledger`, `/h/ledger`, `/start-claim` | file-select; callers adapted to #255 `deliverAuditedEmail` |

`homeowner.mjs` imports `deliverAuditedEmail` from `email-audited.mjs`, which is a **barrel re-export of #255 `email.mjs`**, not Lineage A INSERT audit.

---

## Intentionally excluded (kept dark/unapplied)

- PR #250 hosted tax containment
- #234 wholesale
- #239 wholesale / zip snapshot as source of truth
- Lineage A `email.mjs`
- Moov/bank #259 / #265 / #266 / #269 / #270
- SQL 30 operator apply
- Shared staging deploy, production, production-prep
- Real SES
- Provider execution enablement
- DynamoDB

---

## Phase 2 — semantic conflict review

Reviewed even when Git auto-merged:

| File | Preserved |
|---|---|
| `write-allowlist.mjs` | `detected_claim_number`; `assigned_employee_id` |
| `write-check-workflow.mjs` | Mortgage Ops staff-transition denial; assigned employee allowlist |
| `workflow-rpc.mjs` | claim-number update path |
| `email.mjs` | `withDurableAuditClient` + peek/reserve/finalize (identical to #255) |
| `check-endorsement.mjs` | audited send + public consume + CC-117 persist |
| `homeowner.mjs` | passwordless tracking via audited helper |
| `tenant-admin.mjs` | portal/hire audited through `email.mjs` |
| `tenant-email-domain.mjs` | `requireAuthorizedTenant`; no Freedom bleed |
| `write-app-metadata.mjs` | negative amounts + master-owner branding + doc_type allowlist |
| `identity.mjs` / `identity-link.mjs` | `/identity/link` master-owner only; null-safe SELECT-after-upsert |
| `provider-flags.mjs` | fail-closed unless `AWS_PROVIDER_EXECUTION_ENABLED=true` |

Integrated branch simultaneously preserves: claim-number fix, Mortgage Ops tenant/staff mutation boundaries, audited endorsement delivery, public endorsement token consume, tenant-branding isolation, homeowner passwordless tracking, portal invite auditing, identity linking, functional-audit fixes, provider fail-closed behavior.

---

## Phase 3 — SQL / operator inventory (nothing applied)

| SQL | Role | Status |
|---|---|---|
| `aws/workflows/sql/71_endorsement_email_audit.sql` | endorsement email audit/idempotency RPCs | **ALREADY APPLIED** |
| `aws/rls/sql/29_mortgage_ops_library_parity.sql` | library helpers (PR #245 on main) | **ALREADY APPLIED** (live `tenant_documents_doc_type_check` still lacks `library:mortgage:%`) |
| `aws/workflows/sql/69_staging_homeowner_ledger_view.sql` | homeowner ledger view | **ALREADY APPLIED** (re-verify before deploy) |
| `aws/rls/sql/29_mortgage_ops_agent_access.sql` | Mortgage Ops agent access (not the library 29) | **REQUIRED BEFORE DEPLOY** |
| `aws/workflows/sql/52_mortgage_ops_staff_grants.sql` | Mortgage Ops staff grants | **REQUIRED BEFORE DEPLOY** |
| `aws/write-path/sql/39_detected_claim_number_grant.sql` | claim-number grant (CC-047) | **REQUIRED BEFORE DEPLOY** |
| `aws/rls/sql/30_tenant_documents_mortgage_doc_type.sql` | mortgage `doc_type` | **KEEP UNAPPLIED** (OPTIONAL AFTER DEPLOY / later operator) |
| Hosted tax #250 SQL, SES IAM JSON, Lineage A send_log INSERT SQL | — | **KEEP UNAPPLIED** |

**Compatibility:** integrated code expects SQL 71 RPCs (`aws_email_send_log_peek/reserve/finalize`, `aws_mark_endorsement_request_sent`, public endorsement RPCs). Those match the currently known staging schema (SQL 71 applied). Mortgage Ops agent queue and claim-number persist still need operator grants 29/52/39 before a coherent deploy. SQL 30 is not required for this artifact; doc_type values remain allowlisted in application code and stay dark in the database until applied.

---

## Phase 4 — automated tests

Command: `npm run test:aws-api` (`node --experimental-strip-types --test aws/tests/*.test.mjs`)

| Metric | Value |
|---|---|
| Tests | 780 |
| Pass | 775 |
| Fail | 0 |
| Skipped | 5 |
| Exit | 0 |

Skipped (environment, not product regressions):

1. fixture database backfills only NULL children
2. fixture aborts on tenant mismatch
3. disposable PostgreSQL mortgage library RLS matrix — PG16 `initdb` absent
4. SQL 65 isolated apply — isolated Postgres not running
5. disposable PostgreSQL tenant_documents mortgage doc_type constraint — PG16 `initdb` absent

Covered in the same suite: AWS API, endorsement/email audit, email workflow hardening, homeowner ledger tracking, Mortgage Ops, tenant isolation/RLS inventory (source), functional-audit, public tokens, branding isolation, negative amounts, claim-number, workflow override, check image/storage, import-adjacent load tests.

No test silently falls back to Lineage A mailer: SQL 71 peek/reserve/finalize mocks are required, and C1C branding asserts **no** `INSERT INTO public.email_send_log`.

---

## Phase 5 — Lambda artifact (not deployed)

Built from Git tree `git ls-files aws/functions/api` at `a629a7c8fec65262ef0854e5846dc5c243d7c97a` plus reused `node_modules` after declared-dependency parity. **Not** a historical live zip as the source tree.

| Field | Value |
|---|---|
| Integration commit | `a629a7c8fec65262ef0854e5846dc5c243d7c97a` |
| Artifact path | `/opt/cursor/artifacts/checksops-staging-api-coherent.zip` |
| Size | 11,727,242 bytes (12 MiB) |
| SHA256 hex | `bd5bbfd52373d56f5c15a3195323404024460c11ae4faefebc497ae1eedf1637` |
| SHA256 base64 (AWS CodeSha256 form) | `vVu/1SNz1W9cFaMZUyNAQCRGDBGuT67+vEl64e7fFjc=` |
| Source files in zip (excluding node_modules) | 132 |
| Import/load | **PASS** 31/31, `sesSendAttempted=false`, `deploy=false` |
| Health from packed `index.handler` | 200, `environment=staging` |

**Dependency gaps**

- All `package.json` dependencies are present in `node_modules`.
- `@aws-sdk/client-sesv2` is **present in node_modules** but **not listed** in `package.json` / `package-lock.json` (dynamic import for tenant identity APIs only; same pattern as the live overlay). Declared lock does not pin it.

**Files differing from known-good endorsement overlay (`ZepKxoHP…` / Git #255 `186dc3fb8`)**

Overlay hot files vs #255:

- `email.mjs` — identical
- `email-audited.mjs` — identical barrel
- `tenant-email-domain.mjs` — identical
- `email-policy.mjs` — identical
- `check-endorsement.mjs` — **differs** (+283/−57): keeps SQL 71 / public consume; **adds** CC-117 `persistPhysicalEndorsementOnCheck`

The full API tree also includes p3b, #267, identity linker, and Lineage A homeowner/portal callers that were never in the five-file overlay.

---

## Phase 6 — frontend rebuild plan (SPA not deployed)

**Frontend rebuild required: YES**

31 `src/` files differ from `origin/main`. A staging SPA rebuild is required for:

| Capability | Files |
|---|---|
| Branding isolation | `CompanyBrandingSettings.tsx`, `tenantBranding.ts`, `TenantContext.tsx` |
| Public token routes | `App.tsx`, `publicTokenRoutes.ts`, `WhiteLabelApp.tsx`, `PublicInvalidLink.tsx`, `PublicInvoicePage.tsx`, `RecipientPaymentSetup.tsx`, `Endorse.tsx` |
| Access Restricted | `AdminMortgageOps.tsx`, `AdminTenants.tsx`, `useMortgageAuth.tsx`, `mortgageDeskAuth.ts`, `MortgageOpsLogin.tsx`, `MortgageOpsQueue.tsx` |
| Functional-audit UI | `CheckCommandCenter.tsx`, `AdminCheckTracker.tsx`, `CheckAdminEditDialog.tsx`, `EndorsementChecklist.tsx`, `ReuploadCheckImageButton.tsx`, `CashJobForm.tsx`, `FundsTab.tsx`, `InvoicesTab.tsx`, `safeIntakeFields.ts`, `fundsReleasedQuery.ts` |
| Homeowner ledger alias | `App.tsx` routes `/ledger/:token`, `/h/ledger/:token`, `/start-claim/:token`; `publicTokenRoutes.ts` prefixes |
| Mortgage library UI | `TenantDocumentLibrary.tsx`, `mortgageLibraryDocTypes.ts` |
| Other | `client.ts`, `storage.ts`, `tenantRoute.ts` |

Do **not** deploy the SPA in this turn.

---

## Unresolved conflicts / gaps

- SQL 29 agent access + SQL 52 staff grants + SQL 39 claim-number grant still **unapplied** (required before deploy).
- SQL 69/71 should be re-verified on staging immediately before deploy.
- PG16 disposable RLS and SQL 65 isolated-cluster tests skipped in this environment.
- Live Lambda CodeSha256 was not re-confirmed this turn.
- SES v2 SDK is extra in `node_modules`, not in the lockfile.
- Real SES retest remains pending and is out of scope here.
- SPA rebuild is required and was not performed.

---

## Stop line

**PASS** Git integration on `cursor/integration-coherent-ec26` at `a629a7c8fec65262ef0854e5846dc5c243d7c97a`.  
**NOT READY** for one authorized coherent staging deployment.
