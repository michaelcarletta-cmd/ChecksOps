# ChecksOps coherent Git integration — 2026-09-13

**Workstream:** sole ChecksOps Integration & Release  
**Deploy this turn:** NO (shared staging, production, and production-prep untouched)  
**Real SES:** not sent  
**Provider execution:** remains fail-closed (`AWS_PROVIDER_EXECUTION_ENABLED=false`)  
**SQL apply this turn:** none (including SQL 30)

**Successor (2026-09-14):** live staging is the validated Integration baseline in `docs/audits/INTEGRATION_VALIDATED_BASELINE_2026-09-14.md` and `docs/audits/INTEGRATION_INVENTORY_2026-09-14.md`. SQL **29/39/52/69/71/72/73** are applied; SQL **30** remains unapplied. Lambda pin `OSiyHTQqSq5J3QRZCKdDrQ7PRW5qPWeJS71LZ46LIOE=`; SPA ETag `113dfd26211290d0be78377d4b8e1ee2`. Endorsement email E2E is **PASS and CLOSED**. This 2026-09-13 report remains the Git-merge record for `3d0235c31`. The next coherent artifact **must include PR #289** (SQL 72/73 + GET txn). Do not deploy from this file.

## Verdict

| Gate | Result |
|---|---|
| Git integration + clean Lambda/SPA build | **PASS** |
| One authorized coherent staging deployment | **NOT READY** |

NOT READY because live staging SQL catalog could not be re-verified this turn (`ExpiredToken`). SQL `29_mortgage_ops_agent_access.sql`, `52_mortgage_ops_staff_grants.sql`, and `39_detected_claim_number_grant.sql` last known status is **REQUIRED BEFORE DEPLOY**. Local disposable PG16 preflight of those files is PASS and idempotent.

---

## Identity

- **Branch:** `cursor/integration-coherent-ec26`
- **PR:** https://github.com/michaelcarletta-cmd/ChecksOps/pull/282
- **Base:** `origin/main` `4fc1166d8206cd7b70b13423b73c2b0b96ba8b5b`
- **Canonical mailer SHA:** `186dc3fb89e774290294eb7ec67daf971d8b0c10` (PR #255)
- **SESv2 pin:** `@aws-sdk/client-sesv2` **3.1124.0** (exact, same release as `client-s3` / `client-secrets-manager` / `client-ses`)
- **Known-good live overlay (Lambda rollback only, not a Git SHA):** `ZepKxoHP9PgTaeR0F+o2TpJcE6ot4/NxO2GvLVStjlo=`
- **Final integration Git SHA:** the HEAD commit that contains this report on `cursor/integration-coherent-ec26` (see PR / `git rev-parse HEAD` after this file lands)

---

## Exact merge order actually used

1. Merge PR **#255** `origin/cursor/endorsement-email-audit-ec26` (includes **#248** + **#249**) — clean. Merge commit `8c13028f3`.
2. Merge Functional Audit p3b / PR **#264** `origin/cursor/p3b-claim-number-grant-3bce` — 3 conflicts. Merge commit `034cacc54`.
3. Merge PR **#267** code only `origin/cursor/tenant-documents-mortgage-doc-type-d93c` — 1 conflict. Merge commit `0fd8d96d9`. SQL 30 source is in Git; **not applied**.
4. File-select identity from **#239** + Lineage A homeowner/portal callers. Commit `822d2518d`.
5. Align tests to SQL 71 (no Lineage A INSERT fallback). Commit `4ed0950d3`.
6. Adapt already-present stakeholder resend caller to `deliverAuditedEmail`. Commit `a629a7c8f`.
7. Docs report (first pass). Commit `5447862f2`.
8. Pin `@aws-sdk/client-sesv2` 3.1124.0 in `package.json` + lockfile. Commit `261cae5ad`.
9. Disposable PG16 SQL 29/52/39/69/71 preflight test. Commit `5ff741630`.
10. Restore `p_reason` on `admin_override_check_status` generated Args so `tsc -b` succeeds. Commit `fd054fad1`.
11. This deployment-readiness report.

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

## 1. Pin SES v2 dependency

`aws/functions/api/package.json` and `package-lock.json` pin `@aws-sdk/client-sesv2` to **3.1124.0** (exact), matching `client-s3` / `client-secrets-manager` / `client-ses`.

Clean build method: `git archive HEAD aws/functions/api` then `npm ci --omit=dev` in an isolated directory. **No** historical Lambda zip `node_modules`. Workspace leftovers of 3.1130.0 are irrelevant to the artifact.

Installed in the clean tree: `@aws-sdk/client-sesv2@3.1124.0` (resolved `client-sesv2-3.1124.0.tgz`).

---

## 2. SQL preflight (READ-ONLY; nothing applied)

### Live staging

**UNVERIFIED this turn.** `aws sts get-caller-identity` → `ExpiredToken`. Cannot `GetFunctionConfiguration`, cannot oneshot into VPC. Do not treat last-known catalog as freshly proven.

SQL 30 remains **KEEP UNAPPLIED**.

### Local disposable PG16 (does not touch staging)

`aws/tests/coherent-sql-preflight-pg.test.mjs` applies SQL **29, 52, 39, 69, 71, 72, 73 twice** after stubs + role shim + auth UID GUC. SQL 72/73 were added after this 2026-09-13 merge record; they are required in the next coherent artifact (PR #289).

| File | Local result | Live last-known | Live this turn | Notes |
|---|---|---|---|---|
| `aws/rls/sql/29_mortgage_ops_agent_access.sql` | safe / idempotent PASS | REQUIRED BEFORE DEPLOY | UNVERIFIED | Distinct from already-applied **library** `29_mortgage_ops_library_parity.sql` |
| `aws/workflows/sql/52_mortgage_ops_staff_grants.sql` | safe / idempotent PASS | REQUIRED BEFORE DEPLOY | UNVERIFIED | GRANT UPDATE assignment columns + GRANT EXECUTE agent helpers |
| `aws/write-path/sql/39_detected_claim_number_grant.sql` | safe / idempotent PASS | REQUIRED BEFORE DEPLOY | UNVERIFIED | GRANT UPDATE (`detected_claim_number`) only; **no** amount UPDATE grant |
| `aws/workflows/sql/69_staging_homeowner_ledger_view.sql` | safe / idempotent PASS | ALREADY APPLIED | UNVERIFIED | Re-verify immediately before deploy |
| `aws/workflows/sql/71_endorsement_email_audit.sql` | safe / idempotent PASS | ALREADY APPLIED | UNVERIFIED | Re-verify immediately before deploy |
| `aws/rls/sql/30_tenant_documents_mortgage_doc_type.sql` | local constraint test PASS | KEEP UNAPPLIED | not applied | Do not apply |

Expected GRANT/RLS when 29/52/39 are applied:

- Agent queue policies `mortgage_ops_agent_*` + `CREATE OR REPLACE` visibility helpers
- `GRANT UPDATE (assigned_to, assigned_at, assigned_by, assignment_reason, last_agent_action_at, last_agent_action_by)` (and assignment columns named in SQL 52) on `public.checks` / mortgage request tables to `checksops`
- `GRANT UPDATE (detected_claim_number) ON public.checks TO checksops`

No conflicting `CREATE` vs `CREATE OR REPLACE` issues on the disposable cluster. No SQL 30 constraint present after 29/52/39/69/71.

---

## 3. Restore Postgres / RLS test coverage

Installed PostgreSQL 16 locally. Started cluster `16/main` on `5432` and created role `ubuntu` SUPERUSER for peer-auth fixture tests. Started a second isolated cluster at `/tmp/pg-sql65:55432` for SQL 65.

| Test | Result |
|---|---|
| `mortgage-ops-library-parity-pg.test.mjs` | **PASS** (previously skipped: no `initdb`) |
| `tenant-documents-mortgage-doc-type-pg.test.mjs` | **PASS** local only; staging SQL 30 still unapplied |
| `endorsing-tenant-backfill.test.mjs` | **PASS** (previously skipped: no peer socket) |
| `coherent-sql-preflight-pg.test.mjs` | **PASS** |
| `sql65-isolated-writer.test.mjs` | **PASS** after isolated cluster start |

Tests were **not** weakened. SQL 65 remains CheckAlt production-writer / provider-dark and is **not** part of the coherent mailer/homeowner/mortgage deploy sequence.

---

## 4. Coherent SPA build (not deployed)

Command: `npx tsc -b --pretty false` then `npx vite build --mode aws` using `.env.aws` (`VITE_AUTH_PROVIDER=cognito`, staging API URL).

| Check | Result |
|---|---|
| `tsc -b` | **EXIT 0** after Args fix (`p_reason` / optional `p_actor_id`) |
| `vite build --mode aws` | **EXIT 0** in ~11.04s |
| Files | 113 |
| Uncompressed dist bytes | 9,152,334 |
| Dist tree SHA256 | `556d1a1cff9df755cd63da606fd040b901cf949d081be4a077b91b7c12682e13` |
| tarball | `/opt/cursor/artifacts/coherent_spa_dist.tar.gz` SHA256 `f7d16c226ed91c5482a94b99d64286f415644ea9bffcd60936610dda3e6fd898` |

Build coverage needles present in `dist/`:

- `/ledger/`, `/h/ledger/`, `/start-claim/`
- Access Restricted (`AdminMortgageOps`, `AdminTenants`, `AdminFinancialModel`)
- `PublicInvalidLink` chunk + Endorse / Sign / HomeownerLedger / MortgageOps routes
- Mortgage document library allowlist (`library:mortgage` + verification doc types in `index-*.js`)
- Homeowner portal chunks (`HomeownerLedger`, `HomeownerClaimPortal`, `HomeownerCheckUpload`)
- Endorsement/signature routes (`Endorse-*.js`, `Sign-*.js`, `EndorsementChecklist-*.js`)
- C1C branding isolation: no `Freedom Restoration` string in dist; branding load/save lives in `index-*.js` with `useTenantFilter` source still on the Git tree

Do **not** deploy this SPA. Ignore Vercel preview blocks; they are not a compile failure.

---

## 5. Semantic regression + complete automated suite

Command: `npm run test:aws-api`

| Metric | Value |
|---|---|
| Tests | **781** |
| Pass | **781** |
| Fail | **0** |
| Skipped | **0** |
| Exit | **0** |
| Log | `/opt/cursor/artifacts/coherent_aws_api_tests_final.log` |

### Source still contains (proven in suite + source inventory)

**Email / endorsement**

- `deliverAuditedEmail` in `email.mjs` (SQL 71 `aws_email_send_log_peek` / `_reserve` / `_finalize`)
- Fail-closed reservation before mailer (`Reservation must persist before the mailer runs`)
- Idempotent replay (`replayReservedRow` / `peekAuditedEmail`)
- Public endorsement consume-token (`aws_public_submit_endorsement`, `token_consumed`)
- CC-117 `persistPhysicalEndorsementOnCheck`

**Homeowner**

- Passwordless ledger (`homeowner.mjs` / `homeowner-ledger-public.mjs`)
- Same-email token reuse / different-email isolation (`homeowner-ledger-tracking.test.mjs`)
- Public ledger routes `/ledger/:token`, `/h/ledger/:token`, `/start-claim/:token`
- Sign/upload public handlers
- `allow_deductible_payment: false` on AWS ledger presenters (no deductible payment CTA)

**Mortgage Ops**

- Tenant request isolation + `mortgage_agent` authorization (`mortgage-ops-agent-access.test.mjs`, SQL 29 helpers)
- Tenant cannot mutate staff status (`write-check-workflow.mjs` staff-transition denial; `tenant admin cannot accept or update mortgage request via RPC`)
- Owner oversight preserved on platform admin routes

**Functional audit**

- Claim-number allowlist / SQL 39 grant source
- Status override (`admin_override_check_status` + `p_reason`)
- Negative amount protections (`write-app-metadata.mjs`)
- Public invalid-token behavior (`PublicInvalidLink` + endorsement consume)
- Branding isolation (`CompanyBrandingSettings` + C1C tests; no Freedom bleed)

**Security**

- Provider execution fail-closed (`provider-flags.mjs`)
- Tenant isolation (data/query + RLS tests)
- Identity-link refuse `cognito_sub_must_not_equal_application_user_id`

---

## 6. Artifact reproducibility

Lambda zip is rebuilt from the **final Git commit** via `git archive` + `npm ci --omit=dev`. Metadata JSON (not in Git) records exact SHA, lock, import/load, source inventory, SHA256, size.

SPA is the `vite --mode aws` dist from the same Git tree (gitignored). Identity: tree SHA256 above + tarball checksum.

No untracked source is included in the Lambda zip (archive of `git ls-files` under `aws/functions/api` only).

Prior historical zip `vVu/1SNz1W9cFaMZUyNAQCRGDBGuT67+vEl64e7fFjc=` is **superseded** (sesv2 was an undeclared 3.1130.0 leftover).

---

## 7. Deployment package (PREPARE ONLY — DO NOT EXECUTE)

See `/opt/cursor/artifacts/coherent_deployment_package.json`.

Order:

A. Revision/SHA guard current staging (`RevisionId`, CodeSha256; expect overlay `ZepKxoHP…` unless drift)  
B. SQL preflight (READ-ONLY catalog) after AWS credentials work  
C. Apply SQL 29 agent-access / 52 / 39 transactionally/idempotently — **not SQL 30**  
D. Verify SQL 69 / 71  
E. Deploy coherent Lambda by exact Git-built artifact  
F. Verify Lambda CodeSha256 matches the Git-built zip  
G. Deploy coherent SPA to staging host (not Vercel production)  
H. Smoke with `AWS_EMAIL_MODE=ses-identity`, provider execution false  
I. Targeted regression  
J. Only after I PASS + human authorization: one real endorsement SES test, then revert to ses-identity  

### Rollback (no data destruction)

- **Lambda:** `update-function-code` back to CodeSha256 `ZepKxoHP9PgTaeR0F+o2TpJcE6ot4/NxO2GvLVStjlo=` (known-good endorsement overlay zip). Not a Git SHA.
- **SPA:** restore the pre-G staging dist / CloudFront previous version. Copy current staging dist before G if versioning is absent.
- **SQL 39:** `REVOKE UPDATE (detected_claim_number) ON public.checks FROM checksops` — does not delete values.
- **SQL 52:** `REVOKE` assignment UPDATE / EXECUTE grants — does not delete rows.
- **SQL 29:** drop the four agent policies if needed; leave functions in place rather than `DROP FUNCTION`.
- **SQL 69/71:** do not roll back (already independently applied; would break live endorsement/homeowner).
- Forbidden: DELETE/TRUNCATE of checks, email audit, homeowner tokens, tenant data.

---

## Remaining skips

**None** in `npm run test:aws-api` (781/781). SQL 65 isolated cluster was started for this environment only; it is not a staging apply.

---

## Remaining blockers

| Sev | Item |
|---|---|
| **P0** | AWS `ExpiredToken` — live staging SQL 29/52/39/69/71 catalog and live Lambda CodeSha256 unverified this turn |
| **P1** | SQL 29 agent-access + 52 + 39 last known **unapplied**; required before deploy |
| **P2** | Vercel preview may stay blocked (ignore; do not treat as SPA compile failure). Real SES still unauthorized. SQL 30 remains dark by design |

---

## Stop line

**PASS** Git integration, SESv2 pin, clean Lambda/SPA build, and 781/781 automated tests on `cursor/integration-coherent-ec26`.  
**NOT READY** (as of 2026-09-13) for one authorized coherent staging deployment until live SQL preflight succeeds and operator SQL 29/52/39 are applied.

**2026-09-14 successor:** those SQL files are now applied on staging, plus SQL 72 and SQL 73 from PR #289. See `docs/audits/INTEGRATION_VALIDATED_BASELINE_2026-09-14.md`. The next Git-built coherent zip must include `e34f6878c`, `320685542`, and `e7c7bfde3`. Do not deploy in the documentation turn.
