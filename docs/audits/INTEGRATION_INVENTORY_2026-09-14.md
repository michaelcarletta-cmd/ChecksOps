# ChecksOps Integration inventory — 2026-09-14

**Workstream:** sole ChecksOps Integration & Release  
**Supersedes:** `docs/audits/INTEGRATION_INVENTORY_2026-09-13.md` (Phase 1–2 proposed merge; that merge is complete)  
**Live identity:** `docs/audits/INTEGRATION_VALIDATED_BASELINE_2026-09-14.md`  
**This turn:** inventory + Git lineage only. **Do not deploy. Do not send real SES.**

The 2026-09-13 inventory proposed merging #255 then functional-audit p3b then #267 plus Lineage A file-selects onto `cursor/integration-coherent-ec26`. That merge landed at `3d0235c31` (PR #282). This inventory records the **validated live staging** state after SQL 29/39/52/69/71/72/73 and the closed endorsement email E2E.

---

## 1. Authoritative release lineage

```
origin/main (historical merge base 4fc1166d8 for the coherent branch)
└── cursor/integration-coherent-ec26  3d0235c31994493468c7aed732dc1125e501b617  PR #282
    ├── #248 412 frontend + Mortgage Ops deny UX
    ├── #249 SQL 29 agent-access + SQL 52 staff grants  (APPLIED on staging)
    ├── #255 canonical mailer / SQL 71                 (APPLIED on staging)
    ├── #254–#264 functional audit, SQL 39              (APPLIED on staging)
    ├── #267 mortgage doc_type code; SQL 30 UNAPPLIED
    ├── #239 identity.mjs + identity-link.mjs file-select
    ├── #231/#233/#235 homeowner/portal + SQL 69          (APPLIED on staging)
    └── cursor/public-endorsement-rpc-ec26  e7c7bfde3  PR #289  ← REQUIRED in next coherent artifact
          ├── e34f6878c  SQL 72 aws_public_endorsement_by_token     (APPLIED)
          ├── 320685542  GET read-only txn (in live Lambda pin)
          └── e7c7bfde3  SQL 73 submit-payee + JS skip second UPDATE (SQL APPLIED; JS not deployed)
```

Stay dark / do not merge wholesale: #250 hosted tax, #234 wholesale, #239 wholesale, Lineage A `email.mjs`, Moov/bank #259/#265/#266/#269/#270, DynamoDB, production, production-prep.

---

## 2. Live staging (validated — do not redeploy to match Git)

| Pin | Value |
|---|---|
| Lambda CodeSha256 | `OSiyHTQqSq5J3QRZCKdDrQ7PRW5qPWeJS71LZ46LIOE=` |
| SPA `index.html` ETag | `113dfd26211290d0be78377d4b8e1ee2` |
| SQL 73 fingerprint | `d388bb4ec4a9cd6ee83d7e02e193b47c` |
| SQL 72 fingerprint | `445994fc428e76a872899c37701cb590` |
| `AWS_EMAIL_MODE` | `ses-identity` |
| Recipient lock | `mcarletta@freedomadj.com` |
| Provider execution | `false` |
| CheckAlt / Moov | disabled |
| Endorsement email E2E | **PASS and CLOSED** |

Lambda pin composition: coherent zip `Wk5V+GVPry6FUpty7Jn21YZeQ62TMBXo4oDM0bj2IBI=` (`3d0235c31`) + GET txn patch `320685542`. Pin on SHA, not RevisionId.

---

## 3. SQL inventory (staging RDS `checksops`)

Already applied — do not re-litigate; include in the next Git-built artifact:

| SQL | File | Git commit / PR | Staging |
|---|---|---|---|
| 29 | `aws/rls/sql/29_mortgage_ops_agent_access.sql` | coherent / #249 | present |
| 39 | `aws/write-path/sql/39_detected_claim_number_grant.sql` | coherent / #264 | present (column GRANT only) |
| 52 | `aws/workflows/sql/52_mortgage_ops_staff_grants.sql` | coherent / #249 | present |
| 69 | `aws/workflows/sql/69_staging_homeowner_ledger_view.sql` | coherent / #235 | present |
| 71 | `aws/workflows/sql/71_endorsement_email_audit.sql` | coherent / #255 | present |
| 72 | `aws/workflows/sql/72_public_endorsement_token_lookup.sql` | **PR #289 `e34f6878c`** | present |
| 73 | `aws/workflows/sql/73_public_endorsement_submit_payee.sql` | **PR #289 `e7c7bfde3`** | present |

Intentionally unapplied:

| SQL | File | Action |
|---|---|---|
| 30 | `aws/rls/sql/30_tenant_documents_mortgage_doc_type.sql` | KEEP UNAPPLIED |
| Hosted tax | #250 | NOT READY |
| Financial / provider SQL | 64/65/70 | DARK |
| SES send IAM JSON | historical | keep unapplied |

**Next environment / next coherent preflight apply order:** 29 → 52 → 39 → 69 → 71 → 72 → 73. Never auto-apply SQL 30. Encoded in `aws/tests/coherent-sql-preflight-pg.test.mjs`.

SQL 72/73 are not staging-only undocumented state: sources, rollbacks, and fingerprint pins live in Git on PR #289.

---

## 4. Next coherent artifact (future authorized turn only)

Do **not** execute in this turn.

1. Merge PR **#289** into `cursor/integration-coherent-ec26` (or rebuild the coherent branch including those three commits).
2. Build Lambda from that Git SHA (`git archive` + `npm ci --omit=dev`). Expected differences vs live pin `OSiyHTQq…`: the JS fail-closed skip of the second public payee UPDATE from `e7c7bfde3`.
3. SPA may stay on ETag `113dfd26211290d0be78377d4b8e1ee2` unless frontend files change; SQL 72/73 do not require an SPA redeploy.
4. SQL preflight is **verify-only** on current staging (29/39/52/69/71/72/73 already present; 30 absent). Re-apply only if catalog drift is proven.
5. Keep env `ses-identity`, lock recipient, provider execution false.
6. Do not touch production-prep. Do not enable CheckAlt/Moov. Do not send another real endorsement email unless a later turn explicitly re-opens that gate.

Rollback (no data destruction): keep Lambda pin `OSiyHTQq…` as the known-good live SHA until a future Git-built zip is authorized and proven. SQL 72/73 rollback files restore prior function bodies; do **not** DROP `aws_public_submit_endorsement`.

---

## 5. READY / NOT READY

| Item | Status |
|---|---|
| Live staging as Integration baseline | **READY / VALIDATED** |
| SQL 72/73 in Git (PR #289) | **READY** |
| SQL 72/73 applied on staging | **READY** |
| Endorsement email E2E | **PASS / CLOSED** — do not retest |
| Next coherent Git zip including #289 | **NOT BUILT this turn** (required before the next Git-derived deploy) |
| Shared-staging freeze for non-Integration workstreams | **IN EFFECT** |
| Production / production-prep | **DO NOT TOUCH** |
| Provider execution / CheckAlt / Moov | **DARK** |
| SQL 30 | **KEEP UNAPPLIED** |
| P2 unknown-token GET mapping | **DEFERRED** |
