# ChecksOps 412-control interaction audit — coherent staging

**Verdict: CONDITIONAL GO** for continued staging work. **Do not begin production cutover.**

This audit did not patch product defects, did not deploy Lambda or frontend after the audit, did not enable provider execution, and did not switch `AWS_EMAIL_MODE=ses`.

## Target

| Item | Value |
| --- | --- |
| Staging API | `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging` |
| Staging UI | `https://staging.checksops.com` |
| Function | `checksops-staging-api` |
| CodeSha256 | `8zYBsVZA2Lwu6SUgy7V7V/N4EVBl/YBz/9f9irViL30=` |
| Source branch | `cursor/staging-coherent-lambda-ec26` |
| Source commit | `c32213f827e8be7f6be1a5d99b79e8b4f2b435d8` |
| RevisionId | `5871aead-b17c-4967-b9b2-90587efdec49` |
| LastModified | `2026-09-11T19:10:42.000+0000` |

Standing env (unchanged by this audit):

- `AWS_EMAIL_MODE=ses-identity`
- `AWS_EMAIL_SES_LOCK_RECIPIENT=mcarletta@freedomadj.com`
- `AWS_TENANT_EMAIL_DOMAIN_ENABLED=true`
- `AWS_PROVIDER_EXECUTION_ENABLED=false`
- `CHECKSOPS_ENV=staging`

Machine-readable inventory: `docs/audits/inventory-412-coherent-staging.json` and `.csv`.

## Headline counts

| Metric | Count |
| --- | --- |
| Total controls discovered | **412** |
| Total evaluated | **412** |
| PASS | **277** |
| FAIL | **9** |
| BLOCKED | **116** |
| NOT APPLICABLE | **10** |
| Effective coverage `(PASS+FAIL)/(412−NA)` | **71.1%** |
| Raw classified | **100%** |

P0 failures: **none** against the coherent Lambda package.

Interactive PASS rows were taken from staging browser sessions or live API calls. Nested apply/persist dialogs, cash-job detail, and remaining settings mutations that were not clicked remain **BLOCKED (missing data)** rather than PASS. A follow-up staging browser session recast public invalid-token pages, C1C `/c1c/cash-jobs`, and C1C `/c1c/wallet-ops` (including Add funds $0.00 / Not set up) from missing-data BLOCKED to PASS.

## P0 / P1 failures

### P0

None.

### P1 — C049 `/h/ledger/:token` valid view

| Field | Value |
| --- | --- |
| Expected | A valid homeowner ledger token on `/h/ledger/:token` renders the same public ledger as `/ledger/:token` (no login). |
| Actual | `/h/ledger/<valid token>` shows **Organization Not Found**. `/ledger/<same token>` shows project plan, signatures, shared docs, timeline, totals, and Sign now. |
| Repro | Logged out, open `https://staging.checksops.com/h/ledger/f2947f6588b20eaa7e6a8a4ac8bffe4a8c8e73aa705164d5`. Compare `https://staging.checksops.com/ledger/f2947f6588b20eaa7e6a8a4ac8bffe4a8c8e73aa705164d5`. |
| Evidence | `docs/audits/evidence/C049-h-ledger-org-not-found.webp`, `docs/audits/evidence/C048-ledger-valid.webp` |
| Likely root cause | Live SPA `isPublicTokenRoute()` includes `/ledger/` but **omits `/h/ledger/`**, so `/h/...` is parsed as tenant slug `h`. Current workspace `src/App.tsx` matches that omission. |

This is a homeowner-tracking routing defect, not a coherent-Lambda defect. Token API isolation for `/ledger/` still PASSed.

## All other FAILs

### P2 — C046 Unauthenticated `/admin/mortgage-ops`

| Field | Value |
| --- | --- |
| Expected | Unauthenticated admin routes show Access Restricted (same as `/admin/tenants` and `/admin/financial-model`). |
| Actual | Redirect to marketing homepage plus **Not authorized** toast. |
| Repro | Logged out, open `/admin/mortgage-ops`. |
| Evidence | `/opt/cursor/artifacts/audit412_unauth_mortgage_ops.webp` |
| Likely root cause | Mortgage-ops admin gate redirects instead of the Access Restricted shell used by other admin routes. |

### P2 — C384 C1C `/admin/mortgage-ops` deny UX

| Field | Value |
| --- | --- |
| Expected | Tenant admin denied from mortgage-ops sees Access Restricted, not the public marketing homepage. |
| Actual | C1C admin is denied (good) but lands on marketing home with **Not authorized** toast. C1C `/admin/financial-model` correctly shows Access Restricted. |
| Repro | Sign in as `payments@condition1commercial.com`, open `/admin/mortgage-ops`. |
| Evidence | `docs/audits/evidence/C384-c1c-mortgage-ops-redirect.webp` vs `/opt/cursor/artifacts/audit412_c1c_denied_financial_model.webp` |
| Likely root cause | Same mortgage-ops gate as C046. |

### P2 — C111 Freedom Funds Released badge vs list

| Field | Value |
| --- | --- |
| Expected | Queue badge equals visible-row / heading count. |
| Actual | Badge **109**, heading **Funds Released (100)**, totals bar **100 disbursements**. Recipients labeled “Condition One Commercial” appear on Freedom’s list (payee names; not proven as RLS leak). |
| Repro | Sign in as `checksops-tester@freedomadj.com`, `/freedom/checks`, Funds Released. |
| Evidence | `docs/audits/evidence/C111-funds-released-parity.webp` |
| Likely root cause | Badge query vs list pagination cap (100) and/or a different disbursement filter. C1C tenant-admin queue badges matched visible rows in this run. |

### P2 — C334 C1C Branding & Email shows Freedom name

| Field | Value |
| --- | --- |
| Expected | C1C branding matches Condition One Commercial (Profile / Check Center). |
| Actual | Company Name **Freedom Claims Adjusting**, email `claims@freedomclaims.com`, Philadelphia address. Profile/Users still show Condition One Commercial. |
| Repro | C1C admin → `/c1c/settings` → Branding & Email. |
| Evidence | `docs/audits/evidence/C334-c1c-branding-freedom-name.webp` |
| Likely root cause | Tenant branding row copied from Freedom defaults or shared seed; not a live SES send. |

### P2 — C356 / C405 Owner Preview Freedom → Org Not Found

| Field | Value |
| --- | --- |
| Expected | Platform owner Preview opens the selected tenant Check Center. |
| Actual | C1C preview worked. Freedom preview showed **Organization Not Found** in the audited session. Tenant list labeled Freedom as `freedom_czm`. |
| Repro | `checksopsadmin@gmail.com` → Tenant Management → Preview Freedom Claims. |
| Evidence | `/opt/cursor/artifacts/audit412_owner_preview_c1c_checks.webp` |
| Likely root cause | Preview URL/slug mismatch (`freedom` vs `freedom_czm`) or missing white-label org record for that slug. |

### P2 — C412 Production-prep SHA unchanged (environment freeze)

| Field | Value |
| --- | --- |
| Expected | `checksops-production-prep-api` CodeSha256 stays `l9nHBQHn+cwwroKO9+czOXi2WMjoeChOpgVFtR0Tj7A=` for this staging-only audit. |
| Actual | Observed `BIAPo9QUBVFeeM0s0Uwsbomulbxijvr7RbNraBPhXqE=` `LastModified=2026-09-11T20:08:55`. **This audit did not call UpdateFunctionCode on prep.** |
| Repro | `aws lambda get-function-configuration --function-name checksops-production-prep-api` |
| Likely root cause | Another process updated prep during the audit window. Staging coherent SHA is unchanged. |

### P3 — C077 Unknown path

| Field | Value |
| --- | --- |
| Expected | Unknown public paths render a not-found page. |
| Actual | `/this-path-does-not-exist-412audit` shows **Organization Not Found** (same slug-fallback family as C049). |
| Repro | Logged out, open that path. |
| Evidence | `docs/audits/evidence/C077-unknown-path-org-not-found.webp` |
| Likely root cause | First path segment treated as tenant slug. |

## BLOCKED controls

**116 BLOCKED.** Kinds:

| Kind | Count | Meaning |
| --- | --- | --- |
| missing data | 109 | Interactive control not clicked in this run (nested apply dialogs, cash-job detail, extra settings persist). |
| identity | 6 | Freedom-admin Cognito `c4386408-60e1-70e2-abb6-e6194e8e635f` / `mcarletta@freedomadj.com` → `identity_not_linked`. |
| unsafe action | 1 | Mortgage Desk OTP/queue would send email (`C386`). |

### Identity BLOCKED (do not treat as skip)

Exact blocker: Cognito user authenticates, then ChecksOps returns `identity_not_linked` / UI **No ChecksOps access**.

| ID | Control | Impact |
| --- | --- | --- |
| C390 | Freedom admin `/identity/me` | Cannot obtain a linked admin token. |
| C196 | Freedom admin Check Center | Cannot open `/freedom/checks` as admin. |
| C197 | Freedom admin override | Cannot prove admin-only override as Freedom admin (C1C admin override API still PASS). |
| C325 | Freedom admin Users tab | Cannot prove Freedom Users admin UX. |
| C326 | Freedom admin Branding tab | Cannot prove Freedom branding admin UX. |
| C362 | Freedom admin denied `/admin/tenants` | Cannot prove linked-admin vs owner denial from that identity. |

Unblock (data, not this audit): link Cognito sub `c4386408-60e1-70e2-abb6-e6194e8e635f` to the Freedom admin application user in `identity_accounts`. Do not silently exclude these rows.

Freedom **staff** (`checksops-tester@freedomadj.com`) **is** linked. Platform owner (`checksopsadmin@gmail.com`) **is** linked (`isMasterOwner=true`, UUID `233c588f-dc33-4307-8c3f-3da49c9fd2b3`). C1C admin (`payments@condition1commercial.com`) **is** linked.

### Provider / money BLOCKED vs NOT APPLICABLE

Live Moov / CheckAlt / ACH / RTP / wire / Plaid execution: **NOT APPLICABLE** (`C240–C244`, `C247–C249`) because `AWS_PROVIDER_EXECUTION_ENABLED=false` by standing order.

Fail-closed API routes (`C235–C239`, `C245–C246`) **PASS** (`provider_disabled` / `liveProviderCalled=false`). Platform-owner `moov-platform-bank` **PASS** with `liveProviderCalled=false`.

Wallet/Payments UI with provider disabled: C1C `/c1c/payments` tabs and `/c1c/wallet-ops` (Pending setup, Add funds $0.00 Not set up, ACH/ToS/KYC Not started) **PASS**. Cash Jobs list **PASS**; job-detail (`C230`) remains **BLOCKED (missing data)**. Live KYC complete / Add-funds-from-bank not executed.

### Unsafe / missing nested UI (representative)

Not an exhaustive dump of all 109 missing-data IDs; full list is in the JSON `blocked` array.

- `C386` Mortgage Desk request detail (unsafe: OTP email).
- `C144` Send to Mortgage Desk, `C146` send endorsement emails, hire-agent submit: not executed.
- `C230` cash-job detail frame not captured (list PASSed: Smith Roof Replacement $20,000).
- Public invalid tokens `/invoice`, `/pay-setup`, `/verify-account`, `/payment-direction` now PASS (deny). `/sign/:uuid` still shows Organization Not Found (same slug-fallback family as C049; exact `/sign` without token PASSed).
- Bulk Review/Void/Reissue apply, in-person signature, deposit packet generate, check image S3 object (`C175` staging S3 missing).

## Module-by-module

| Module | PASS | FAIL | BLOCKED | NA | Total |
| --- | --- | --- | --- | --- | --- |
| public_homeowner | 84 | 3 | 0 | 1 | 88 |
| check_center | 78 | 1 | 42 | 0 | 121 |
| payments_wallet | 28 | 0 | 17 | 9 | 54 |
| settings | 36 | 1 | 42 | 0 | 79 |
| admin_platform | 51 | 4 | 15 | 0 | 70 |

## Role-by-role

A control may list multiple roles; counts are multi-label.

| Role | PASS | FAIL | BLOCKED | NA |
| --- | --- | --- | --- | --- |
| anon | 93 | 4 | 2 | 1 |
| c1c_admin | 141 | 3 | 87 | 9 |
| platform_owner | 37 | 2 | 21 | 0 |
| freedom_staff | 13 | 0 | 1 | 0 |
| freedom_admin | 3 | 0 | 7 | 0 |
| mortgage_agent | 1 | 0 | 1 | 0 |

Freedom-admin positive paths are BLOCKED (identity). Shared controls (login field, slug checks opened as other roles) can still PASS.

## Severity breakdown (FAIL only)

| Severity | Count | IDs |
| --- | --- | --- |
| P0 | 0 | — |
| P1 | 1 | C049 |
| P2 | 7 | C046, C111, C334, C356, C384, C405, C412 |
| P3 | 1 | C077 |

## Area results (required scopes)

### Interactive controls

Exercised in the staging browser: landing nav (desktop + 390px hamburger), login/signup surfaces (signup not submitted), pricing/security/legal, find-a-pro, public endorse/sign/unsubscribe/auth, Check Center queues and detail tabs, C1C payments tabs, C1C settings tabs including Users/Referrals/Branding, owner Tenant Management and Financial Modeling, isolation denials, homeowner `/ledger` and `/start-claim`.

Not marked PASS from source inspection alone.

### Roles / authorization / isolation

| Identity | Linked | UI land |
| --- | --- | --- |
| Platform owner `checksopsadmin@gmail.com` | yes | `/admin/tenants` |
| Freedom staff `checksops-tester@freedomadj.com` | yes | `/freedom/checks` |
| C1C admin `payments@condition1commercial.com` | yes | `/c1c/checks` |
| Freedom admin `mcarletta@freedomadj.com` / sub `c4386408-…` | **no** | Cognito password succeeds, then No ChecksOps access |

C1C cannot open `/freedom/checks` (Access Denied) or `/admin/tenants` (Access Restricted). Staff denied C1C and admin. Owner finance UI no longer shows “Administrator access required” (improvement vs Pass 1). Tenant isolation on API queries PASS. Owner preview of C1C showed larger queue counts than C1C tenant-admin (Review 12 / Endorsing 20 vs C1C admin Endorsing 2) — master view vs tenant-admin filter; not classified P0.

### Check Center / workflows

Forward/reverse/override/Loss Draft reverse cleanup exercised on the coherent API with synthetic check `685e9e65-f85a-4b56-904b-bb7332b9f00d` (created then deleted). Invalid transitions fail-closed. Audit log rows created (`audit_id` present on override). C1C badge/list parity PASS for Review/Endorsing/Ready/Deposited/Loss Draft/Funds Released on tenant-admin. Freedom Funds Released FAIL C111. Nested bulk apply and Send-to-Mortgage-Desk not executed (BLOCKED).

### Homeowner tracking

| Path / case | Result |
| --- | --- |
| `/ledger/:token` valid | PASS — plan, signatures, shared docs, timeline, totals, Sign now, no login, no admin chrome, money/deductible CTA not executed |
| `/h/ledger/:token` valid | **FAIL C049** |
| `/start-claim/:token` valid | PASS form |
| invalid / expired / revoked | PASS deny copy |
| claim A vs B isolation | PASS API |
| same-email reuse / different-email | PASS API |
| upload isolation (spoofed tenant_id ignored) | PASS API |
| `/h/upload` | PASS surface; code not sent |
| no real email to open portal | honored |

### Email

Sink / ses-identity only. Audited reservation, idempotency/replay, tenant authorization, recipient lock, branding From, Reply-To validation, cross-tenant denial: PASS in API matrix. CloudWatch SES Send unchanged for this run. **Did not** set `AWS_EMAIL_MODE=ses`. **Did not** send a real email merely to test the portal.

### Provider / money

Fail-closed PASS. Live rails NOT APPLICABLE. No Moov transfers, CheckAlt deposits, ACH, RTP, wires, Plaid live execution, or real money movement.

### Platform / finance

Owner Tenant Management (6 tenants), Platform Finance, financial-model P&L (Low/Expected/High, Reset/Export present, copy says nothing saved to DB), mortgage-ops personnel (Morgan Carletta) PASS. Tenant-admin denied financial-model with Access Restricted PASS. Positive Freedom-admin platform paths BLOCKED by identity (not silently PASSed).

### Security

Unauth admin tenants/financial-model Access Restricted PASS; mortgage-ops inconsistent FAIL C046. Cross-tenant UI/API denials PASS. Public token scoping PASS on `/ledger` family except `/h/ledger` FAIL. Malformed IDs / authorization-before-mutation covered in API matrix. Email recipient lock present. Homeowner routes did not expose admin chrome on `/ledger`. `/h/ledger` failed closed as org-not-found (wrong closed state).

## Staging records changed

- Synthetic check `685e9e65-f85a-4b56-904b-bb7332b9f00d` **created then deleted**.
- `email_send_log` sink rows for portal-invite and homeowner-ledger-send (lock recipient `mcarletta@freedomadj.com`).
- Homeowner ledger upload on claim A (isolation probe; `notified=false`).
- Cognito passwords rotated for existing UAT users (`checksopsadmin@gmail.com`, `checksops-tester@freedomadj.com`, `payments@condition1commercial.com`, `mcarletta@freedomadj.com`). **Operators should rotate again.**
- **No** staging Lambda code/env change after the coherent package already live.
- **No** production frontend deploy.
- Production-prep SHA **changed by another process** (C412); this audit did not write it.

## Cleanup still required

- Rotate the UAT Cognito passwords used for this audit.
- Optional: delete remaining sink `email_send_log` rows if operators do not want them in staging history.
- Identity link for Freedom admin (data change; out of scope here).
- Do not treat C1C branding Freedom copy as “test data to leave” if email/docs would go out under that name.

## Production-readiness verdict

**CONDITIONAL GO**

Coherent staging Lambda SHA `8zYBsVZA2Lwu6SUgy7V7V/N4EVBl/YBz/9f9irViL30=` is live, provider execution remains false, email mode remains ses-identity with recipient lock, and API/security/email/workflow probes on that package are clean.

Do **not** production-cutover until at least:

1. Freedom-admin identity mapping is linked (C390 family).
2. `/h/ledger/:token` is a public token route (C049).
3. C1C branding is not Freedom Claims Adjusting (C334).
4. Freedom Funds Released badge/list parity is understood or fixed (C111).
5. Owner Preview Freedom slug/org (C356/C405).
6. Production-prep SHA freeze is reconciled (C412) if prep is still a cutover dependency.
7. Remaining BLOCKED nested apply/persist dialogs (bulk void, hire, KYC complete, cash-job detail) are either exercised or explicitly accepted as out of the cutover gate.

No product patches were applied during this audit.
