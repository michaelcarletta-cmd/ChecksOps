# ChecksOps Integration Inventory — 2026-09-13

**Workstream:** sole ChecksOps Integration & Release  
**This turn:** Phase 1 inventory + Phase 2 proposed Git strategy  
**Not done this turn:** shared-staging deploy, production/prep changes, real SES, provider enablement, DynamoDB, SQL apply

Known-good endorsement-hardened **overlay** package (not a Git SHA): `ZepKxoHP9PgTaeR0F+o2TpJcE6ot4/NxO2GvLVStjlo=`  
Canonical Git endorsement/email HEAD to preserve: `186dc3fb89e774290294eb7ec67daf971d8b0c10` (PR **#255**)  
SQL 71 is applied on staging. Sink-mode regression passed after the overlay restore. Real SES retest remains pending.

Live Lambda SHA was **not re-confirmed** this turn (`ExpiredTokenException` on `GetFunctionConfiguration`). Last known restore: `2026-09-12T19:16:00Z`, RevisionId `cde1db99-6c77-420d-be54-66206aaaf15a`.

---

## 1. Integration inventory

### 1.1 Git baseline

| Ref | SHA | Notes |
|---|---|---|
| `origin/main` | `4fc1166d8206cd7b70b13423b73c2b0b96ba8b5b` | Merge PR #251 mortgage library path helper. **Use this, not stale local `main`.** |
| Endorsement/email | `186dc3fb89e774290294eb7ec67daf971d8b0c10` | PR #255. Merge-base with main: `8dfdebdb53` (12 commits behind main, **merges cleanly onto current main**). |
| Functional audit tip (p3b) | `0cf75c8fb370234fc0af8436e22c4f983885c8be` | PR #264. **0 behind / 17 ahead of current main.** |
| Tenant docs | `94ba72d97851` | PR #267. 0 behind / 2 ahead of current main. |
| Homeowner ledger | `8617c5a2fdc5` | PR #235. 23 behind main (old lineage). |
| Coherent overlay snapshot | `c32213f827e8` | PR #239. Do **not** use as zip source of truth. |

Main commits the 412/email stack does not contain (already on `origin/main`; a merge of #255 onto main brings them in automatically):

- PR **#245** Mortgage Ops library parity (`29_mortgage_ops_library_parity.sql`) — applied on staging RDS as library helpers; live `tenant_documents_doc_type_check` still lacks `library:mortgage:%`
- PR **#247** Tax/1099 TIN AWS-layer containment (already on main; keep dark at provider/hosted layers)
- PR **#251** mortgage library path helper hotfix
- PR **#220** financial TOTP (dark merge)

### 1.2 Lineage map (dependency graph)

Two independent email lineages plus a third functional-audit stack. **That is the integration problem.** Overlay-vs-overlay cannot solve it.

```
origin/main (4fc1166d8)
├── Lineage B (canonical mailer / SQL 71) — merge this first
│   ├── #248 cursor/412-readiness-remediate-ec26     OPEN  (frontend 412 P1 + Mortgage Ops deny UX)
│   │     └── #249 cursor/mortgage-ops-agent-access-ec26  OPEN
│   │           SQL 29_mortgage_ops_agent_access.sql (NOT the library 29)
│   │           SQL 52_mortgage_ops_staff_grants.sql
│   │           └── #255 cursor/endorsement-email-audit-ec26  OPEN  HEAD 186dc3fb8
│   │                 SQL 71_endorsement_email_audit.sql (APPLIED on staging)
│   │                 deliverAuditedEmail + peek/reserve/finalize RPCs + durable audit client
│   │
├── Functional audit stack (based on current main) — merge after B
│   ├── #254 p1 CC-117 atomic Endorsed-on-Check
│   ├── #257 p2 CC-367 one admin override path
│   ├── #258 p3 allowlist: tenant flags, claim number, skip endorsements
│   ├── #260 p4 S3 image persist only if object exists
│   ├── #262 p5 public invoice/pay-setup tokens without Cognito
│   ├── #263 p6 reject negative amounts
│   ├── #261 p7 branding isolation (tenant profile, not Freedom placeholders)
│   └── #264 p3b CC-047 claim-number GRANT + public invalid-link
│         SQL 39_detected_claim_number_grant.sql (NOT known-applied)
│
├── Tenant/Mortgage (based on current main)
│   └── #267 tenant_documents mortgage doc_type   DRAFT
│         SQL 30 (UNAPPLIED; keep unapplied until operator authorization)
│
├── Lineage A (older mailer + homeowner/portal) — file-select, do not merge wholesale
│   ├── #223 tenant-email-outbound-harden          OPEN
│   ├── #231 portal-invite-email-audit             DRAFT
│   ├── #233 email-workflow-harden                 DRAFT
│   ├── #235 homeowner-ledger-tracking             DRAFT  SQL 69 (likely applied)
│   └── #239 staging-coherent-lambda               DRAFT  SUPERSEDED as zip source
│
├── AWS parity/security — NOT READY
│   └── #250 hosted PostgREST tax-profile containment  DRAFT  do not merge/apply
│
├── Docs-only (not Lambda)
│   ├── #232 functional audit report
│   ├── #237 full staging E2E audit  (CONFLICTING vs main)
│   ├── #253 blocked-control verification
│   └── #268 Phase 1 inventory PASS conversions
│
└── Bank/provider — DARK, accept handoffs only
    #259 #265 #266 #269 #270 (DynamoDB in #266/#269/#270 — do not create)
```

### 1.3 PR status snapshot

| PR | Draft | Mergeable vs its base | Role |
|---|---|---|---|
| 248 | no | MERGEABLE | 412 frontend + Mortgage Ops deny UX |
| 249 | no | MERGEABLE | Mortgage Ops agent SQL 29/52 + staff-status denial |
| 255 | no | MERGEABLE | Canonical endorsement/email audit |
| 254–264 | yes | MERGEABLE (stacked) | Functional-audit CC fixes |
| 267 | yes | MERGEABLE vs main | Mortgage doc_type (SQL unapplied) |
| 223/231/233/235/239 | mixed | stacked on old main | Unique homeowner/portal; obsolete mailer |
| 234 | yes | **CONFLICTING vs main** | Largely superseded |
| 250 | yes | MERGEABLE | Hosted tax containment — NOT READY |
| 268 | yes | MERGEABLE vs #253 | Docs only |
| 259/265/266/269/270 | no | MERGEABLE | Bank verify — stay dark |

### 1.4 Frontend vs backend

**Backend / Lambda (must land in the coherent Git SHA):**

- Mailer: `email.mjs`, `email-audited.mjs`, `email-policy.mjs`, `tenant-email-domain.mjs` from **#255 only**
- Endorsement: `check-endorsement.mjs` — **manual combine** of #255 public-token/SQL-71 path + #254/#264 CC-117 persist
- Allowlist / writes: `write-allowlist.mjs`, `write-check-workflow.mjs`, `write-app-metadata.mjs`, `workflow*.mjs`, `public-tokens.mjs`, `platform-authz.mjs`
- Homeowner: `homeowner.mjs`, `homeowner-ledger-public.mjs` (file-select from #235; re-seat callers on #255 mailer)
- Identity (live overlay, missing from #255 and p3b): `identity.mjs`, `identity-link.mjs` file-select from #239
- Mortgage library: #267 `mortgage-library-doc-types.mjs` + doc_type allowlist in `write-app-metadata.mjs`

**Frontend / SPA (deploy separately from Lambda; include in the same Git SHA):**

- 412: `App.tsx`, `publicTokenRoutes.ts`, Mortgage Ops pages, `CheckCommandCenter.tsx` deny UX
- p2–p7: override UX, S3 image guards, public invalid-link, negative amounts, branding isolation
- #267: `TenantDocumentLibrary.tsx`, `mortgageLibraryDocTypes.ts`
- Homeowner public routes from #235 into `App.tsx` / `publicTokenRoutes.ts` (conflict with 412)

**SQL (in Git; apply later, staging-only, operator-gated):** see §4.

**IAM / infra:** no new IAM in the integration build. Keep `NOT_APPLIED_20260911_staging_ses_send_iam.json` unapplied. Do not create DynamoDB. Do not enable provider execution.

### 1.5 Live staging fixes missing from Git

The restored package `ZepKxoHP…` is an **overlay zip**, not `git archive` of `186dc3fb` or main. Missing-from-Git pieces that the overlay historically carried:

1. **Homeowner ledger public path + SQL 69** (Lineage A / #235) — not in #255
2. **Portal-invite / remaining workflow `deliverAuditedEmail` callers** (#231/#233) — #255 hardened the **mailer** and endorsement; `homeowner.mjs` / `tenant-admin.mjs` on #255 still use the older invite log path
3. **Identity linking** (`identity-link.mjs` hire-mortgage → `application_user_id`, null-safe return in #239) — not in #255 or p3b
4. **Functional-audit CC-117 / CC-047 / public-token behavior** that was live as overlays `PqOt7K1…` / `WcL5Puo…` / `ei+nNC2…` — in Git on the p3b stack, **not** in `186dc3fb`
5. **#239 coherent zip snapshot** attempted to freeze a live tree; merging it would fight both #255 and p3b. **Supersede #239** by building the zip from the new integration SHA.

### 1.6 Already on staging RDS (do not re-litigate)

- SQL **71** endorsement email audit (`aws_email_send_log_peek/reserve/finalize`, `aws_mark_endorsement_request_sent`) — EXECUTE to `checksops` only
- Library SQL **29** `29_mortgage_ops_library_parity.sql` (from main #245)
- Email send-log idempotency unique index + status CHECK (also included in SQL 71)
- SQL **69** homeowner ledger view — treated as present from prior overlay workstream; **re-verify** when homeowner Git path is integrated

### 1.7 In Git, not auto-apply

| SQL | PR | Staging status | Action |
|---|---|---|---|
| `29_mortgage_ops_agent_access.sql` + `52_mortgage_ops_staff_grants.sql` | #249 | Not known-applied (different file from library 29) | OPERATOR later |
| `30_tenant_documents_mortgage_doc_type.sql` | #267 | Unapplied | OPERATOR later; keep feature dark until then |
| `39_detected_claim_number_grant.sql` | #264 | Unknown vs the drifted Lambda-only overlay | OPERATOR later; CC-047 cannot persist without GRANT |
| Hosted `revoke_postgrest_tax_profiles` | #250 | Must stay unapplied | NOT READY |
| Lineage A `NOT_APPLIED_20260911_email_send_log_*.sql` | #223 | Superseded by SQL 71 | Do not re-apply |
| SES send IAM JSON | #223 | Unapplied | Keep unapplied during integration |

---

## 2. Conflict and dependency report

Throwaway worktrees under `/tmp/checksops-integration-dryrun*` (not pushed).

### 2.1 Dry-run results

| Sequence | Result |
|---|---|
| `origin/main` + **#255** (includes #248+#249) | **CLEAN** |
| that + **p3b (#264 stack)** | **CONFLICT** 3 files |
| `origin/main` + **p3b** | **CLEAN** |
| that + **#255** | **CONFLICT** same 3 files |
| `main+#255` + **#267** | **CLEAN** |
| **p3b** + **#267** | **CONFLICT** `write-app-metadata.mjs` |
| `main+#255` + **#235** wholesale | **CONFLICT** 6 files including `email.mjs` |
| `main+#255` + **#254** only | **CONFLICT** `check-endorsement.mjs` |
| `main+#255` + **#234** | **CONFLICT** `data.mjs`, `CheckCommandCenter.tsx` |
| `main+#255` + **#250** | CLEAN in Git — **still do not merge** |

Cherry-picks of Lineage A commits onto #255 all conflict (`homeowner.mjs`, `email.mjs`, tests, SQL 69 as modify/delete). **Port by file-select + re-seat on `deliverAuditedEmail`, not cherry-pick.**

### 2.2 Confirmed conflict files and resolution rule

**A. `aws/functions/api/check-endorsement.mjs`** (highest risk)

| Side | Keep |
|---|---|
| #255 | `deliverAuditedEmail` / `withDurableAuditClient`; `aws_mark_endorsement_request_sent`; public submit/reject via `aws_public_submit_endorsement` / `aws_public_reject_endorsement`; consumed-token (`signed/rejected/waived/expired` → `token_consumed`); no pre-send row lock |
| p3b / #254 | Staff-path **atomic persist Endorsed-on-Check (CC-117)**; `updatePayeeSigned` fail-closed; public invoice invalid-link behavior that does not undo consume-token |

Do **not** take p3b’s raw `UPDATE public.check_endorsements` public submit/reject. That would drop the SQL 71 consumed-token contract that the sink regression proved.

**B. `aws/tests/parity-check-endorsement.test.mjs`**

Keep both suites: #255 overlay-export / durable-audit assertions **and** p3b CC-117 persist assertions.

**C. `src/components/settings/CompanyBrandingSettings.tsx`**

Union: p7 **tenant-profile isolation** (`activeTenantId`, no Freedom placeholders) **and** 412 `tenantBranding` typed helpers (`TENANT_BRANDING_READ_COLUMNS`). Do not load global/Freedom branding when a tenant id is present.

**D. `aws/functions/api/write-app-metadata.mjs`** (#267 vs p3b)

Keep **both**:

- p3b/p6: `asNonNegativeMoney` / `asPositiveQuantity`; master-owner lock on global company branding; platform-owner tenant ops flags
- #267: `isAllowedTenantDocumentDocType` on insert/update

**E. Lineage A vs #255 mailer** (`email.mjs`, `email-audited.mjs`)

**#255 wins entirely.** Lineage A’s mailer lacks `openIndependentAuditClient` / `withDurableAuditClient` / SQL 71 peek-reserve-finalize RPCs. Port A’s **callers** (portal invite, tenant-user invite, mortgage-agent invite, esign, email-queue, payment-direction, homeowner-otp, ledger send) onto #255’s `deliverAuditedEmail`.

**F. `write-allowlist.mjs` / `write-check-workflow.mjs`**

Git **auto-merged** #255+#249 with p3b in the reverse-order dry-run. Spot-check showed both:

- p3b: `detected_claim_number` moved to `INTAKE_SAFE_COLUMNS` (out of prohibited)
- #249: `assigned_employee_id` allowlist + staff-transition denial in `write-check-workflow.mjs`
- p4: S3 `HeadObject` before persisting image paths

Still **manually verify** after the real merge that skip-endorsements (#258) and staff denial (#249) are both present. Auto-merge is not a semantic review.

**G. `src/App.tsx` / `src/lib/publicTokenRoutes.ts`**

412 public-token routing **and** homeowner ledger public routes must both remain. Do not drop either.

### 2.3 Overlapping hot files (independent stacks)

Highest-risk paths touched by 2+ lineages:

- `aws/functions/api/email.mjs`, `email-audited.mjs`, `email-policy.mjs`, `tenant-email-domain.mjs`
- `aws/functions/api/check-endorsement.mjs`
- `aws/functions/api/write-allowlist.mjs`, `write-check-workflow.mjs`, `write-app-metadata.mjs`
- `aws/functions/api/public-tokens.mjs`
- `aws/functions/api/workflow.mjs`, `workflow-rpc.mjs`, `workflow-override.mjs`
- `aws/functions/api/identity.mjs`, `identity-link.mjs` (#234/#239 only)
- `src/pages/CheckCommandCenter.tsx`
- `src/components/settings/CompanyBrandingSettings.tsx`
- `src/App.tsx`, `src/lib/publicTokenRoutes.ts`

### 2.4 Superseded / do-not-merge-wholesale

| Item | Verdict |
|---|---|
| **#239** coherent staging zip from live overlay | **SUPERSEDED** as integration source. Keep `validate-coherent-staging-zip.mjs` ideas; rebuild zip from the new SHA. File-select identity commits only. |
| **#234** p0/p1 audit remediation | **Mostly superseded** by #248 + #254 + #257 for workflow/override. Unique remainder is identity/queue totals; prefer #239’s null-safe `identity-link.mjs`. Do not merge #234 wholesale (`CONFLICTING` vs main). |
| Lineage A `email.mjs` | **SUPERSEDED** by #255 |
| Lineage A `NOT_APPLIED_20260911_email_send_log_*.sql` | **SUPERSEDED** by SQL 71 |
| Overlay packages `PqOt7K1…` / `WcL5Puo…` / `ei+nNC2…` | Historical drift; **do not restore** as the coherent build |
| Overlay `ZepKxoHP…` | **Rollback artifact only** until the Git SHA is built and proven |

### 2.5 SQL / GRANT order (future apply, staging only)

Already applied: library 29, SQL 71, send-log shape, likely SQL 69.

Proposed later order (never auto-apply in the merge turn):

1. Re-verify SQL 69 if homeowner public path is in the SHA
2. `29_mortgage_ops_agent_access.sql` then `52_mortgage_ops_staff_grants.sql` (#249)
3. `39_detected_claim_number_grant.sql` (#264) — column GRANT only; no financial columns
4. `30_tenant_documents_mortgage_doc_type.sql` (#267) — after API/SPA allowlist is in the SHA

Do **not** apply: hosted tax #250, financial activation, provider SQL, SQL 24, SES IAM.

IAM: none new for the Git merge. Staging API must stay on `checksops`, never admin.

---

## 3. Exact proposed merge / integration order

**Do not execute this merge in this turn.** Target branch: `cursor/integration-coherent-ec26` from `origin/main` (`4fc1166d8`).

Prefer **merge of stacked tips** over replaying every intermediate PR, then **file-select** Lineage A.

| Step | Action | Expected Git result | Conflict policy |
|---|---|---|---|
| 0 | `git fetch origin main` and branch from `origin/main` | — | — |
| 1 | Merge `origin/cursor/endorsement-email-audit-ec26` (#255 = #248+#249+#255) | CLEAN | Mailer + SQL 71 + Mortgage Ops auth source of truth |
| 2 | Merge `origin/cursor/p3b-claim-number-grant-3bce` (#254…#264) | 3 conflicts | Resolve per §2.2 A–C |
| 3 | Merge `origin/cursor/tenant-documents-mortgage-doc-type-d93c` (#267) | conflict on `write-app-metadata.mjs` after step 2 | Resolve per §2.2 D; **leave SQL 30 unapplied** |
| 4 | File-select identity from #239: `identity.mjs`, `identity-link.mjs` (null-safe return), `index.mjs` only if required for the linker | manual | Do not take #239 workflow/email overlay |
| 5 | File-select homeowner/portal from #235/#233/#231 **without** `email.mjs`: `homeowner-ledger-public.mjs`, SQL 69, tests, portal-invite/tenant-admin/esign/email-queue/payment-direction/homeowner-otp callers re-seated on #255 `deliverAuditedEmail`; union `App.tsx` / `publicTokenRoutes.ts` | manual | Do not take overlay builders (`build-ledger-send-overlay.mjs`, `build-coherent-staging-zip.mjs`) |
| 6 | Skip #250, #234 wholesale, #239 wholesale, all Moov/bank PRs, docs PRs | — | — |
| 7 | Stop. Record exact Git SHA. Run unit tests. **Do not** `UpdateFunctionCode`. | — | — |

**Do not** merge Lineage A first. **Do not** pick a historical Lambda overlay. **Do not** activate unfinished features because the code is present (SQL 30, tax containment, bank verify, real SES, provider execution).

Preservation checklist after the merge (must be true in the SHA before any future deploy):

- [ ] `deliverAuditedEmail` + `withDurableAuditClient` + `aws_email_send_log_peek/reserve/finalize`
- [ ] Public endorsement consume-token + `aws_public_submit_endorsement`
- [ ] CC-117 atomic Endorsed-on-Check persist
- [ ] CC-367 single admin override path
- [ ] CC-047 `detected_claim_number` allowlisted in code (GRANT still operator)
- [ ] S3 image persist gated on object existence
- [ ] Public invoice/pay-setup tokens without Cognito + invalid-link
- [ ] Negative amount rejection
- [ ] Branding isolation (tenant profile)
- [ ] Mortgage Ops agent auth + tenant staff-status denial
- [ ] Tenant document doc_type allowlist in API (SQL 30 still unapplied)
- [ ] Homeowner ledger public path present
- [ ] Identity linker present
- [ ] `AWS_PROVIDER_EXECUTION_ENABLED=false` still fail-closed

---

## 4. READY / NOT READY / OPERATOR REQUIRED

### READY to integrate in Git now (no staging deploy)

| Item | Notes |
|---|---|
| #248 + #249 + #255 | Canonical stack; #255 merges clean onto current main |
| #254–#264 functional stack | After conflict resolution in §2.2 |
| #267 **code** | SQL 30 stays unapplied |
| Selected Lineage A files | Homeowner public + SQL 69 file + audited **callers** on #255 mailer |
| #239 identity-link null-safe return | File-select only |
| Docs PRs | Optional; not required for Lambda SHA |

### NOT READY / stay dark / do not merge

| Item | Why |
|---|---|
| **#250** hosted PostgREST tax containment | Unfinished hosted execution; no remediated handoff |
| **#259 #265 #266 #269 #270** bank verify | Provider dark; #266/#269/#270 create DynamoDB — **do not** |
| **#239 wholesale** | Overlay snapshot, not Git-derived coherent source |
| **#234 wholesale** | CONFLICTING vs main; superseded for workflow |
| Lineage A `email.mjs` | Would overwrite SQL 71 mailer |
| Real SES / `AWS_EMAIL_MODE` flip | Integration stays sink/ses-identity lock as currently configured; **no send test this turn** |
| Provider execution | Keep `AWS_PROVIDER_EXECUTION_ENABLED=false` |
| Tax containment SQL | Unapplied |
| Production / production-prep | Out of scope |

### OPERATOR REQUIRED (later authorized turns — not this turn)

| Item | When |
|---|---|
| Apply SQL 29 agent-access + 52 staff grants | After Git SHA contains #249; staging RDS only |
| Apply SQL 39 claim-number GRANT | After Git SHA contains p3b; staging only |
| Apply SQL 30 mortgage doc_type | After Git SHA contains #267; staging only; feature stays dark until then |
| SQL preflight (71 still present, library 29 still present, 69 re-verify) | Before any shared-staging deploy |
| Shared-staging `UpdateFunctionCode` of a **Git-built** zip | Only after gates in §5 |
| SPA/frontend deploy | Separate from Lambda; same SHA |
| Real endorsement SES retest | Only after live SHA is the Git-built artifact **and** lock recipient still `mcarletta@freedomadj.com` |
| Cognito password / pool changes | Never as part of integration |

### Requires staging validation after a future authorized deploy

Sink endorsement regression (durable reservation, `request_sent_at`, idempotent replay, same MessageId, one mailer invocation, public submit, consumed-token rejection), CC-117, CC-367, CC-047, public tokens, branding isolation, S3 images, Mortgage Ops library insert **after** SQL 30, homeowner ledger public path, identity `/identity/me` for linked testers.

---

## 5. Proposed staging deployment plan (future turn only)

**Do not deploy shared staging in this turn.**

When a later turn authorizes the first Git-derived coherent deploy:

1. **Clean integration branch** `cursor/integration-coherent-ec26` with every conflict resolved per §2.2 and preservation checklist checked.
2. **Exact Git SHA** recorded in the deploy artifact (the zip must be built from that SHA, not from a live overlay).
3. **Complete dependency resolution** — no remaining “pick overlay A vs B”.
4. **Automated tests** for endorsement audit, workflow override, allowlist, public tokens, negative amounts, mortgage library, homeowner ledger, identity-link.
5. **Import/load tests** of the built zip (reuse the coherent-zip validator idea; do not reuse the #239 snapshot bytes).
6. **SQL preflight** (read-only): SQL 71 functions exist; library 29 exists; 69 exists if homeowner is in the SHA; 29-agent/52/39/30 **not** applied unless that same turn explicitly authorizes them.
7. **Artifact inventory/parity**: list every shipped `aws/functions/api/*.mjs` vs Git SHA; prove `deliverAuditedEmail` and public consume-token are present; prove CC-117 persist is present.
8. **Rollback artifact**: keep `ZepKxoHP…` zip (`/tmp/endorsement-audit-staging-updated.zip` / `/tmp/drift-aws/restore-ZepKxoHP.zip`) as the rollback target until the Git SHA is proven on staging.
9. **Proof previously approved fixes are present** before flipping any traffic: peek/reserve/finalize, `idempotent_replay`, SQL 71, Mortgage Ops staff denial, provider fail-closed.
10. **Env unchanged**: `AWS_PROVIDER_EXECUTION_ENABLED=false`; real SES remains disabled for the first Git SHA soak (sink or existing `ses-identity` + lock recipient — **no new SES retest** until a later explicit authorization).
11. **RevisionId-guarded** `UpdateFunctionCode` only; no env/IAM/Cognito/SQL in the same breath as the first Git zip unless separately authorized.
12. **Do not** touch `checksops-production-prep-api` or production.

First Git-derived deploy should be treated as a **code-parity** deploy, not an enablement deploy.
