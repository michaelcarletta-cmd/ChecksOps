# Integration email simplification RC — 2026-09-16

**Workstream:** ChecksOps Integration & Release  
**This turn:** coherent Integration RC = #312 repair candidate + reviewed #349 email simplification  
**Deploy / merge / SQL apply / staging mutation:** NO  
**C1C / Cognito / production / production-prep:** untouched

Reviewed lineage (exact):

- #312 HEAD: `d987e55c554fcc9f0f67d79434f250a5c7f6e578` (`cursor/integration-repair-rc-ec26`)
- #349 HEAD: `51b45c8074853a677b6abbbea1d249cb50e873ef` (`cursor/email-architecture-simplify-ec26`)
- #349 classification: `PR349_READY_FOR_INTEGRATION`

This RC is a **fast-forward of #349 onto #312**. It does not overlay main, #210, #215, #216, or #218.

---

## Email architecture in this RC

- From = ChecksOps-controlled SES address only
- Display name = tenant/company name using existing `via ChecksOps` format
- Body/header = tenant logo, name, primary color
- Reply-To = `tenant_email_settings.reply_to` → `tenants.email_reply_to` → `support@checksops.com`
- `from_address` / `email_from_address` are not Reply-To fallbacks
- Sending-domain verify/check/disable/delete/cron return 410
- `senderOverride: 'checksops'` remains platform From/Reply-To for OTP/security/ops mail

Preserved from #312: SQL 71/72/73 endorsement behavior, `deliverAuditedEmail`, `email_send_log`, idempotency, recipient/sink locks, payment-direction, homeowner/portal workflows, provider-off staging safety.

---

## SQL preflight

#349 introduced **no SQL**. Do not apply `NOT_APPLIED_20260910_tenant_email_ses_domain.sql`.

| SQL | Git in this RC | Staging this turn | Future deploy |
|---|---|---|---|
| 29, 39, 52, 69, 71, 72, 73 | yes | applied (validated baseline) | verify only |
| 41 | yes | treat as already applied | verify; do not backfill `claims.org_id` |
| 42 | yes | treat as already applied | verify; do not re-apply if present |
| 40 | yes | Git-only / unverified GRANT | apply only if `checksops` lacks `claim_settlements` INSERT/UPDATE |
| 30 | source exists | **KEEP UNAPPLIED** | do not run |
| tenant SES domain uniqueness SQL | source exists, unused | **DO NOT APPLY** | retired sending-domain architecture |

---

## Staging safety flags (unchanged vs #312)

From `aws/template.yaml`:

- `AWS_EMAIL_MODE: "sink"`
- `AWS_EMAIL_FROM: "ChecksOps Staging <noreply@checksops.com>"`
- `AWS_TENANT_EMAIL_DOMAIN_ENABLED: "false"`
- `AWS_TENANT_SES_IDENTITY_DELETE_ENABLED: "false"`
- `AWS_TENANT_MAIL_FROM_ENABLED: "false"`
- `AWS_PROVIDER_EXECUTION_ENABLED: "false"`
- `AWS_MOOV_ENABLED: "false"`
- `AWS_CHECKALT_ENABLED: "false"`
- `AWS_FINANCIAL_PERMISSIONS_ACTIVATED: "false"`

---

## Current-main overlap (do not merge into this RC)

Main is ahead of this Integration lineage with unrelated merged work, including #348 WalletOps, #343/#344 release-locks, #331 endorsement-parity reconcile, partner share/revoke (#292/#295/#302), and tax-profile containment. Those are **not** part of this RC.

Do **not** merge main into this RC: #331’s `check-endorsement.mjs` would overwrite the validated #312 SQL 72/73 + `aws_mark_endorsement_request_sent` path. Main’s email-parity fixture fix (`0d1b2667b`) is the same class of test-only persist fixture already included by #349 for Integration.

When this RC later merges to main, expect conflicts in `check-endorsement.mjs`, `email.mjs`, and `email-parity-workflows.test.mjs`. Resolve by keeping Integration endorsement persist/SQL 71/72/73 and ChecksOps-only From.

Do not revive #210 / #215 / #216 / #218.

---

## Proposed later deploy order (do not execute)

1. Read-only catalog: SQL 41/42 present; SQL 72/73 fingerprints unchanged; SQL 30 absent; tenant SES domain uniqueness SQL unapplied.
2. Read-only GRANT check for `claim_settlements`. Apply SQL 40 **only if missing**.
3. Deploy Lambda from this RC Git-built zip (`git archive` + `npm ci --omit=dev`).
4. Deploy SPA from this RC (`vite --mode aws`).
5. Keep `AWS_EMAIL_MODE=sink`, tenant email domain false, provider execution false, CheckAlt/Moov disabled.
6. Do not send real email. Do not enable SES send IAM in this stack.
7. Do not touch C1C, Cognito, production, or production-prep.

---

## Tests

Recorded after the RC branch is cut. See the PR and `INTEGRATION_RC_READY` report.
